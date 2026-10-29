//! A loopback-only, native Rust TEA teaching playground. Run with:
//! cargo run -p demlik-tea --example cay_ocagi
#[path = "cay_ocagi/domain.rs"]
mod domain;
#[path = "cay_ocagi/native.rs"]
mod native;
use demlik_tea::runtime::{NoSubscriptions, Options, Profile, launch};
use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use domain::*;
use native::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::convert::Infallible;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
struct Event {
    seq: u64,
    at: f64,
    kind: String,
    name: String,
    payload: Value,
    model: Option<Model>,
}
#[derive(Clone, Serialize)]
struct Pending {
    id: u64,
    name: String,
    payload: Value,
}
struct Envelope {
    id: u64,
    message: Msg,
}
#[derive(Serialize)]
struct View {
    model: Model,
    events: VecDeque<Event>,
    pending: Vec<Pending>,
    effects: Vec<ActiveEffect>,
    now: f64,
    paused: bool,
    speed: f64,
    event_id: u64,
    effect_id: u64,
    inbox_id: u64,
}
impl View {
    fn event(&mut self, kind: &str, name: &str, payload: Value, model: Option<Model>) {
        self.event_id += 1;
        self.events.push_front(Event {
            seq: self.event_id,
            at: self.now,
            kind: kind.into(),
            name: name.into(),
            payload,
            model,
        });
        self.events.truncate(100);
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Order { table: u8, glasses: u8 },
    Heat,
    Brew,
    Serve { id: u32 },
    Cancel { id: u32 },
    Refill,
    Restock,
    EmptyWater,
    Reset,
    Pause { paused: bool },
    Step,
    Speed { speed: f64 },
}

fn accept(
    action: Action,
    tx: &mpsc::SyncSender<Envelope>,
    view: &Trace,
    clock: &Arc<Mutex<Clock>>,
) -> Result<Value, String> {
    let message = match action {
        Action::Pause { paused } => {
            clock.lock().unwrap().paused = paused;
            return Ok(json!({"paused": paused}));
        }
        Action::Step => {
            let mut clock = clock.lock().unwrap();
            clock.paused = true;
            clock.steps = (clock.steps + 1).min(20);
            return Ok(json!({"step": true}));
        }
        Action::Speed { speed } => {
            if ![0.5, 1.0, 2.0, 4.0].contains(&speed) {
                return Err("Speed must be 0.5, 1, 2 or 4".into());
            }
            clock.lock().unwrap().speed = speed;
            return Ok(json!({"speed": speed}));
        }
        Action::Order { table, glasses } => {
            if !(1..=3).contains(&table) || !(1..=6).contains(&glasses) {
                return Err("Choose table 1–3 and 1–6 glasses".into());
            }
            Msg::OrderPlaced { table, glasses }
        }
        Action::Heat => Msg::HeatRequested,
        Action::Brew => Msg::BrewRequested,
        Action::Serve { id } => Msg::ServeRequested { id },
        Action::Cancel { id } => Msg::OrderCancelled { id },
        Action::Refill => Msg::WaterRefilled,
        Action::Restock => Msg::LeavesRestocked,
        Action::EmptyWater => Msg::WaterEmptied,
        Action::Reset => Msg::ResetRequested,
    };
    let id = enqueue(message, tx, view).map_err(|error| error.to_string())?;
    Ok(json!({"accepted": id}))
}

// @section channel_send
// Both browser actions and timer completions use this same real inbox.
fn enqueue(
    message: Msg,
    tx: &mpsc::SyncSender<Envelope>,
    view: &Trace,
) -> Result<u64, mpsc::TrySendError<Envelope>> {
    let mut view = view.lock().unwrap();
    let id = view.inbox_id + 1;
    let name = message.tag().to_owned();
    let payload = serde_json::to_value(&message).unwrap();
    tx.try_send(Envelope { id, message })?;
    view.inbox_id = id;
    view.pending.push(Pending {
        id,
        name: name.clone(),
        payload: payload.clone(),
    });
    view.event("channel", &name, payload, None);
    Ok(id)
}
// @endsection

fn source() -> Value {
    let files = [
        ("domain.rs", include_str!("cay_ocagi/domain.rs")),
        ("native.rs", include_str!("cay_ocagi/native.rs")),
        ("cay_ocagi.rs", include_str!("cay_ocagi.rs")),
    ];
    let mut sections = serde_json::Map::new();
    for (file, content) in files {
        let mut current: Option<(String, usize, Vec<&str>)> = None;
        for (index, line) in content.lines().enumerate() {
            if let Some(name) = line.trim().strip_prefix("// @section ") {
                current = Some((name.into(), index + 2, vec![]));
            } else if line.trim() == "// @endsection" {
                if let Some((name, start, lines)) = current.take() {
                    sections.insert(
                        name,
                        json!({"file":file, "start":start, "code":lines.join("\n")}),
                    );
                }
            } else if let Some((_, _, lines)) = current.as_mut() {
                lines.push(line);
            }
        }
    }
    Value::Object(sections)
}

fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}
fn http(
    mut stream: TcpStream,
    port: u16,
    tx: mpsc::SyncSender<Envelope>,
    view: Trace,
    clock: Arc<Mutex<Clock>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let result = (|| -> Result<(), String> {
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0; 2048];
            let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Incomplete request".into());
            }
            bytes.extend_from_slice(&chunk[..n]);
            if bytes.len() > 16384 {
                return Err("Request too large".into());
            }
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let header = std::str::from_utf8(&bytes[..header_end])
            .map_err(|e| e.to_string())?
            .to_owned();
        let mut request = header
            .lines()
            .next()
            .ok_or("Missing request")?
            .split_whitespace();
        let method = request.next().ok_or("Missing method")?;
        let path = request
            .next()
            .ok_or("Missing path")?
            .split('?')
            .next()
            .unwrap();
        let headers: Vec<(&str, &str)> = header
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .map(|(k, v)| (k, v.trim()))
            .collect();
        if method == "GET" {
            let (mime, body) = match path {
                "/" => (
                    "text/html; charset=utf-8",
                    include_bytes!("cay_ocagi/index.html").to_vec(),
                ),
                "/style.css" => (
                    "text/css; charset=utf-8",
                    include_bytes!("cay_ocagi/style.css").to_vec(),
                ),
                "/app.js" => (
                    "text/javascript; charset=utf-8",
                    include_bytes!("cay_ocagi/app.js").to_vec(),
                ),
                "/api/state" => (
                    "application/json",
                    serde_json::to_vec(&*view.lock().unwrap()).unwrap(),
                ),
                "/api/source" => ("application/json", serde_json::to_vec(&source()).unwrap()),
                "/favicon.ico" => {
                    return respond(&mut stream, "204 No Content", "image/x-icon", b"")
                        .map_err(|e| e.to_string());
                }
                _ => {
                    return respond(&mut stream, "404 Not Found", "text/plain", b"Not found")
                        .map_err(|e| e.to_string());
                }
            };
            return respond(&mut stream, "200 OK", mime, &body).map_err(|e| e.to_string());
        }
        if method != "POST" || path != "/api/action" {
            return Err("Unsupported request".into());
        }
        for (_, origin) in headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("origin"))
        {
            if *origin != format!("http://127.0.0.1:{port}")
                && *origin != format!("http://localhost:{port}")
            {
                return Err("Cross-origin actions are not allowed".into());
            }
        }
        let length: usize = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .ok_or("Content-Length required")?
            .1
            .parse()
            .map_err(|_| "Invalid content length")?;
        if length > 2048 {
            return Err("Action too large".into());
        }
        while bytes.len() < header_end + length {
            let mut chunk = [0; 2048];
            let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Incomplete action".into());
            }
            bytes.extend_from_slice(&chunk[..n]);
        }
        let action: Action = serde_json::from_slice(&bytes[header_end..header_end + length])
            .map_err(|e| e.to_string())?;
        let reply = accept(action, &tx, &view, &clock)?;
        respond(
            &mut stream,
            "202 Accepted",
            "application/json",
            &serde_json::to_vec(&reply).unwrap(),
        )
        .map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        let _ = respond(
            &mut stream,
            "400 Bad Request",
            "application/json",
            &serde_json::to_vec(&json!({"error":error})).unwrap(),
        );
    }
}

async fn run(port: u16, listener: TcpListener) {
    let view = Arc::new(Mutex::new(View {
        model: Model::default(),
        events: VecDeque::new(),
        pending: vec![],
        effects: vec![],
        now: 0.0,
        paused: false,
        speed: 2.0,
        event_id: 0,
        effect_id: 0,
        inbox_id: 0,
    }));
    let clock = Arc::new(Mutex::new(Clock {
        speed: 2.0,
        ..Clock::default()
    }));
    // @section channel_create
    // mpsc = multiple producers, single consumer. tx sends; rx receives.
    // This transports values inside our program. It is not a Discord chat room.
    let (tx, rx) = mpsc::sync_channel::<Envelope>(64);
    // @endsection
    // @section runtime
    // demlik_tea owns transitions and command execution. This is the real runtime.
    let machine: Machine<'static, Model, Msg, Cmd, Sub> = Machine {
        init: Box::new(|loaded, _| Step::new(loaded.unwrap_or_default(), vec![])),
        update: Update::reducer(update),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let options: Options<Model, Msg, Infallible, Infallible> = Options::new(Profile::Promise);
    let runtime = launch(
        machine,
        (),
        Effects {
            clock: clock.clone(),
            view: view.clone(),
            inbox: tx.clone(),
        },
        NoSubscriptions::new(),
        options,
    );
    runtime.ready().await.expect("TEA runtime starts");
    // @endsection
    let observed = view.clone();
    let _observation = runtime.observe(move |message, model| {
        let mut view = observed.lock().unwrap();
        view.model = model.clone();
        view.event(
            "update",
            message.tag(),
            serde_json::to_value(message).unwrap(),
            Some(model.clone()),
        );
    });
    let http_view = view.clone();
    let http_clock = clock.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let (tx, view, clock) = (tx.clone(), http_view.clone(), http_clock.clone());
                    std::thread::spawn(move || http(stream, port, tx, view, clock));
                }
                Err(error) => eprintln!("HTTP accept failed: {error}"),
            }
        }
    });
    println!(
        "\n  ÇAY OCAĞI · native Rust TEA\n  http://127.0.0.1:{port}\n  Ctrl+C to stop. No accounts, cloud services or network dependencies.\n"
    );
    let mut last = Instant::now();
    let mut next_input = 0.0;
    loop {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let elapsed = last.elapsed().as_secs_f64().min(0.25);
        last = Instant::now();
        let (now, paused, speed, step) = {
            let mut clock = clock.lock().unwrap();
            let step = clock.steps > 0;
            if step {
                clock.steps -= 1;
                clock.now += 1.0;
            } else if !clock.paused {
                clock.now += elapsed * clock.speed;
            }
            (clock.now, clock.paused, clock.speed, step)
        };
        {
            let mut view = view.lock().unwrap();
            view.now = now;
            view.paused = paused;
            view.speed = speed;
        }
        if step || (!paused && now >= next_input) {
            // @section channel_receive
            // The receiver takes ONE ticket, then the native runtime applies it.
            match rx.try_recv() {
                Ok(envelope) => {
                    view.lock()
                        .unwrap()
                        .pending
                        .retain(|item| item.id != envelope.id);
                    runtime
                        .dispatch_once(envelope.message)
                        .await
                        .expect("TEA dispatch succeeds");
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
            // @endsection
            next_input = now + 0.45;
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("CAY_PORT")
        .unwrap_or_else(|_| "4318".into())
        .parse()?;
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    tokio::task::LocalSet::new()
        .run_until(run(port, listener))
        .await;
    Ok(())
}
