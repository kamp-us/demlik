//! Browser host for the same tea-house Machine and domain used by the native demo.
//! JavaScript supplies elapsed time and user actions, never simulation decisions.
#[cfg(target_arch = "wasm32")]
mod bridge;
#[path = "../../tea/examples/cay_ocagi/domain.rs"]
pub mod domain;
use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use domain::{Cmd, Model, Msg};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::mpsc;

#[derive(Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
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

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    State,
    Source,
    Action { action: Action },
    Advance { elapsed_ms: f64 },
    Replay { messages: Vec<Msg> },
}

#[derive(Serialize)]
struct Event {
    seq: u64,
    at: f64,
    kind: String,
    name: String,
    payload: Value,
    model: Option<Model>,
}
#[derive(Serialize)]
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
struct ActiveEffect {
    id: u64,
    command: Cmd,
    start: f64,
    duration: f64,
}

pub struct BrowserHost {
    machine: Machine<'static, Model, Msg, Cmd, Sub>,
    model: Model,
    tx: mpsc::SyncSender<Envelope>,
    rx: mpsc::Receiver<Envelope>,
    pending: Vec<Pending>,
    effects: Vec<ActiveEffect>,
    events: VecDeque<Event>,
    now: f64,
    paused: bool,
    speed: f64,
    steps: u32,
    next_input: f64,
    inbox_id: u64,
    event_id: u64,
    effect_id: u64,
}

// @section runtime
// This is the actual demlik_tea Machine, compiled into WebAssembly.
// The browser host drives its core; it does not run the native Tokio executor.
fn machine() -> Machine<'static, Model, Msg, Cmd, Sub> {
    Machine {
        init: Box::new(|loaded, _| Step::new(loaded.unwrap_or_default(), vec![])),
        update: Update::reducer(domain::update),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
// @endsection

impl Default for BrowserHost {
    fn default() -> Self {
        let machine = machine();
        let model = (machine.init)(None, &()).state;
        // @section channel_create
        // This real Rust channel lives inside this browser's Wasm instance.
        // Each visitor gets a separate instance, inbox, clock, and Model.
        let (tx, rx) = mpsc::sync_channel::<Envelope>(64);
        // @endsection
        Self {
            machine,
            model,
            tx,
            rx,
            pending: vec![],
            effects: vec![],
            events: VecDeque::new(),
            now: 0.0,
            paused: false,
            speed: 2.0,
            steps: 0,
            next_input: 0.0,
            inbox_id: 0,
            event_id: 0,
            effect_id: 0,
        }
    }
}

impl BrowserHost {
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

    // @section channel_send
    // User actions and timer completions enter the same bounded Rust inbox.
    fn enqueue(&mut self, message: Msg) -> Result<u64, String> {
        let id = self.inbox_id + 1;
        let name = message.tag().to_owned();
        let payload = serde_json::to_value(&message).unwrap();
        self.tx
            .try_send(Envelope { id, message })
            .map_err(|error| error.to_string())?;
        self.inbox_id = id;
        self.pending.push(Pending {
            id,
            name: name.clone(),
            payload: payload.clone(),
        });
        self.event("channel", &name, payload, None);
        Ok(id)
    }
    // @endsection

    fn action(&mut self, action: Action) -> Result<Value, String> {
        let message = match action {
            Action::Pause { paused } => {
                self.paused = paused;
                return Ok(json!({"paused":paused}));
            }
            Action::Step => {
                self.paused = true;
                self.steps = (self.steps + 1).min(20);
                return Ok(json!({"step":true}));
            }
            Action::Speed { speed } => {
                if ![0.5, 1.0, 2.0, 4.0].contains(&speed) {
                    return Err("Speed must be 0.5, 1, 2 or 4".into());
                }
                self.speed = speed;
                return Ok(json!({"speed":speed}));
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
        self.enqueue(message).map(|id| json!({"accepted":id}))
    }

    // @section effects
    // Browser effect adapter: Rust schedules work against its own logical clock.
    // JS supplies only elapsed milliseconds. It never decides when tea is ready.
    fn start_effect(&mut self, command: Cmd) {
        let duration = match command {
            Cmd::HeatWater { .. } => 6.0,
            Cmd::SteepTea { .. } => 8.0,
            Cmd::DeliverTea { .. } => 2.5,
        };
        self.effect_id += 1;
        self.event(
            "effect",
            command.tag(),
            serde_json::to_value(&command).unwrap(),
            None,
        );
        self.effects.push(ActiveEffect {
            id: self.effect_id,
            command,
            start: self.now,
            duration,
        });
    }

    fn finish_due_effects(&mut self) {
        let mut index = 0;
        while index < self.effects.len() {
            let effect = &self.effects[index];
            if self.now - effect.start < effect.duration {
                index += 1;
                continue;
            }
            let completion = match &effect.command {
                Cmd::HeatWater {
                    generation,
                    has_water,
                } => Msg::HeatFinished {
                    generation: *generation,
                    result: if *has_water {
                        Ok(())
                    } else {
                        Err("Semaverde su yok. Su ekleyip ateşi yeniden yak.".into())
                    },
                },
                Cmd::SteepTea {
                    generation,
                    glasses,
                } => Msg::BrewFinished {
                    generation: *generation,
                    glasses: *glasses,
                },
                Cmd::DeliverTea { generation, id } => Msg::ServeFinished {
                    generation: *generation,
                    id: *id,
                },
            };
            // Keep a finished effect until its completion fits into the inbox.
            if self.enqueue(completion).is_ok() {
                self.effects.remove(index);
            } else {
                index += 1;
            }
        }
    }
    // @endsection

    pub fn advance(&mut self, elapsed_ms: f64) -> Result<(), String> {
        if !elapsed_ms.is_finite() || elapsed_ms < 0.0 {
            return Err("Invalid elapsed time".into());
        }
        let step = self.steps > 0;
        if step {
            self.steps -= 1;
            self.now += 1.0;
        } else if !self.paused {
            self.now += (elapsed_ms / 1000.0).min(0.25) * self.speed;
        }
        self.finish_due_effects();
        if step || (!self.paused && self.now >= self.next_input) {
            // @section channel_receive
            // Take one Rust ticket and apply the actual Machine's update.
            if let Ok(envelope) = self.rx.try_recv() {
                self.pending.retain(|pending| pending.id != envelope.id);
                let result = self
                    .machine
                    .update
                    .apply(&self.model, &envelope.message)
                    .map_err(|error| format!("Machine transition failed: {error:?}"))?;
                self.model = result.state;
                self.event(
                    "update",
                    envelope.message.tag(),
                    serde_json::to_value(&envelope.message).unwrap(),
                    Some(self.model.clone()),
                );
                for command in result.commands {
                    self.start_effect(command);
                }
            }
            // @endsection
            self.next_input = self.now + 0.45;
        }
        Ok(())
    }

    pub fn model(&self) -> &Model {
        &self.model
    }

    pub fn state(&self) -> Value {
        json!({"host_profile":"browser-wasm", "model":self.model, "events":self.events,
            "pending":self.pending, "effects":self.effects, "now":self.now,
            "paused":self.paused, "speed":self.speed, "event_id":self.event_id,
            "effect_id":self.effect_id, "inbox_id":self.inbox_id})
    }

    pub fn request(&mut self, request: Request) -> Result<Value, String> {
        match request {
            Request::State => Ok(self.state()),
            Request::Source => Ok(source()),
            Request::Action { action } => self.action(action),
            Request::Advance { elapsed_ms } => {
                self.advance(elapsed_ms)?;
                Ok(Value::Null)
            }
            Request::Replay { messages } => Ok(replay(messages)),
        }
    }
}

// Used by the bounded native/Wasm equivalence check. Both targets apply this
// same actual Machine to the same Msg values and expose every Model and Cmd.
pub fn replay(messages: Vec<Msg>) -> Value {
    let machine = machine();
    let mut model = (machine.init)(None, &()).state;
    let mut trace = vec![];
    for message in messages {
        let step = machine
            .update
            .apply(&model, &message)
            .expect("declared message");
        model = step.state;
        trace.push(json!({"message":message, "model":model, "commands":step.commands}));
    }
    Value::Array(trace)
}

fn source() -> Value {
    let files = [
        (
            "domain.rs",
            "tea/examples/cay_ocagi/domain.rs",
            include_str!("../../tea/examples/cay_ocagi/domain.rs"),
        ),
        ("lib.rs", "cay-ocagi-web/src/lib.rs", include_str!("lib.rs")),
    ];
    let mut sections = serde_json::Map::new();
    for (file, path, content) in files {
        let mut current: Option<(String, usize, Vec<&str>)> = None;
        for (index, line) in content.lines().enumerate() {
            if let Some(name) = line.trim().strip_prefix("// @section ") {
                current = Some((name.into(), index + 2, vec![]));
            } else if line.trim() == "// @endsection" {
                if let Some((name, start, lines)) = current.take() {
                    sections.insert(
                        name,
                        json!({"file":file,"path":path,"start":start,"code":lines.join("\n")}),
                    );
                }
            } else if let Some((_, _, lines)) = current.as_mut() {
                lines.push(line);
            }
        }
    }
    Value::Object(sections)
}
