use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::data::PlainData;
use demlik_tea::ports::Port;
use demlik_tea::runtime::{
    CommandContext, CommandWork, DriveError, DriveOptions, Interpreter, Options, Profile, Runtime,
    RuntimeError, SubscriptionWork, Subscriptions, Unsubscribe,
};
use demlik_tea::timing::{Timer, TimerCallback, TimerError};
use demlik_tea::{EitherSub, Machine, Step, Sub, Tagged, TimerDeps, Update, messages};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    convert::Infallible,
    io::{self, BufRead},
    rc::Rc,
};
use tokio::sync::Notify;
type Log = Rc<RefCell<Vec<String>>>;
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let value=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));value}};}
macro_rules! observe_async {($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let value=$function($($arg),*).await;$calls.borrow_mut().push(stringify!($function));value}};}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Case {
    Identity,
    Ports,
    Events,
    TimerFire,
    TimerStop,
    TimerHostCancel,
    TimerOverride,
    ScopeClose,
    DriveDone,
    DriveStall,
    DriveCancel,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SelectedProfile {
    Promise,
    Effect,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Special {
    Nan,
    Infinity,
    NegativeInfinity,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(untagged)]
enum Delay {
    Number(f64),
    Special(Special),
}
impl Delay {
    fn number(self) -> f64 {
        match self {
            Self::Number(n) => n,
            Self::Special(Special::Nan) => f64::NAN,
            Self::Special(Special::Infinity) => f64::INFINITY,
            Self::Special(Special::NegativeInfinity) => f64::NEG_INFINITY,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Script {
    id: String,
    profile: SelectedProfile,
    case: Case,
    ms: Delay,
}
fn push(log: &Log, value: impl Into<String>) {
    log.borrow_mut().push(value.into());
}
fn number(n: f64) -> String {
    ryu_js::Buffer::new().format(n).to_owned()
}
struct Model {
    n: u32,
    owner: u32,
    local: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
messages! {#[derive(serde::Serialize)]#[serde(tag="type")]enum Msg{Address{owner:u32},Ping,ProjectCrash,Tick,Start,Advance,Cancel}}
enum Cmd {
    Next,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "Next"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, value: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(value)
    }
}
struct Handler;
impl Interpreter<Cmd> for Handler {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        _: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(CommandWork::new(async { Ok(vec![Msg::Advance]) }))
    }
}
struct Pulse(u32);
impl Tagged for Pulse {
    fn tag(&self) -> &str {
        "pulse"
    }
}
type Run = Runtime<Model, Msg, Infallible, &'static str, Pulse>;
struct Runner {
    case: Case,
    log: Log,
    hold: Option<Rc<Notify>>,
}
type Desired = EitherSub<Sub<TimerDeps<Msg>>, Sub<SourceDeps>>;
#[derive(serde::Serialize)]
struct SourceDeps {
    label: &'static str,
}
impl Subscriptions<Desired, Msg> for Runner {
    type Error = &'static str;
    fn has_runner(&self, kind: &str) -> bool {
        kind == "source" || (kind == "timer" && self.case == Case::TimerOverride)
    }
    fn start(
        &self,
        sub: Desired,
        producer: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<Self::Error>>, Self::Error> {
        let log = Rc::clone(&self.log);
        if matches!(sub, EitherSub::Left(_)) {
            push(&log, "override");
            producer.emit(Msg::Tick).unwrap();
            return Ok(Some(SubscriptionWork::new(move || {
                push(&log, "override:clear");
                async { Ok(()) }
            })));
        }
        let EitherSub::Right(sub) = sub else {
            unreachable!()
        };
        let label = sub.into_parts().2.label;
        let hold = self.hold.clone();
        push(&log, format!("source:{label}:start"));
        Ok(Some(SubscriptionWork::new(move || async move {
            push(&log, format!("source:{label}:close-start"));
            if let Some(hold) = hold {
                hold.notified().await;
            }
            push(&log, format!("source:{label}:close-done"));
            Ok(())
        })))
    }
}
struct Host {
    next: Cell<u32>,
    pending: RefCell<BTreeMap<u32, TimerCallback>>,
    log: Log,
}
impl Host {
    fn new(log: Log) -> Self {
        Self {
            next: Cell::new(0),
            pending: RefCell::new(BTreeMap::new()),
            log,
        }
    }
    fn fire(&self) -> bool {
        let Some(id) = self.pending.borrow().keys().next().copied() else {
            return false;
        };
        let callback = self.pending.borrow_mut().remove(&id).unwrap();
        push(&self.log, "fire");
        callback().unwrap();
        true
    }
}
impl Timer for Host {
    type Handle = u32;
    fn now_ms(&self) -> f64 {
        17.25
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<u32, TimerError> {
        let id = self.next.get() + 1;
        self.next.set(id);
        push(&self.log, format!("arm:{}", number(ms)));
        self.pending.borrow_mut().insert(id, callback);
        Ok(id)
    }
    fn clear_timeout(&self, id: &u32) {
        push(&self.log, "clear");
        self.pending.borrow_mut().remove(id);
    }
}
fn boot(
    script: &Script,
    log: Log,
    calls: Calls,
    host: Option<Rc<Host>>,
    label: &'static str,
    hold: Option<Rc<Notify>>,
) -> Run {
    let case = script.case;
    let delay = script.ms.number();
    let deps_calls = Rc::clone(&calls);
    let machine = Machine {
        init: Box::new(|_, _| {
            Step::new(
                Model {
                    n: 0,
                    owner: 1,
                    local: Rc::new(()),
                },
                vec![],
            )
        }),
        update: Update::reducer(move |s: &Model, msg: &Msg| {
            let (n, cmds) = match msg {
                Msg::Start => (
                    1,
                    if case == Case::DriveDone {
                        vec![Cmd::Next]
                    } else {
                        vec![]
                    },
                ),
                Msg::Advance => {
                    let n = s.n + 1;
                    (n, if n < 3 { vec![Cmd::Next] } else { vec![] })
                }
                Msg::Cancel => (9, vec![]),
                Msg::Tick => (1, vec![]),
                _ => (s.n + 1, vec![]),
            };
            Step::new(
                Model {
                    n,
                    owner: s.owner,
                    local: Rc::clone(&s.local),
                },
                cmds,
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(move |s: &Model| {
            if matches!(
                case,
                Case::TimerFire | Case::TimerStop | Case::TimerOverride | Case::TimerHostCancel
            ) && s.n == 0
            {
                vec![EitherSub::Left(
                    observe!(deps_calls, demlik_tea::Sub::timer, delay, Msg::Tick).unwrap(),
                )]
            } else if case == Case::ScopeClose {
                vec![EitherSub::Right(
                    observe!(
                        deps_calls,
                        demlik_tea::Sub::new,
                        "source",
                        SourceDeps { label }
                    )
                    .unwrap(),
                )]
            } else {
                vec![]
            }
        }),
    };
    let projected = Rc::clone(&log);
    let addressed = Rc::clone(&log);
    let identity = observe!(
        calls,
        demlik_tea::core::Identity::new,
        move |s: &Model| {
            if case == Case::Identity {
                push(&projected, "ofState");
                PlainData::from(&json!({"owner":s.owner}))
            } else {
                PlainData::Undefined
            }
        },
        move |msg: &Msg| {
            if case == Case::Identity {
                push(&addressed, format!("ofMsg:{}", msg.tag()));
                if let Msg::Address { owner } = msg {
                    return PlainData::from(&json!({"owner":owner}));
                }
            }
            PlainData::Undefined
        },
    );
    let authored = observe!(calls, demlik_tea::Machine::with_identity, machine, identity);
    let profile = match script.profile {
        SelectedProfile::Promise => Profile::Promise,
        SelectedProfile::Effect => Profile::Effect,
    };
    let mut options: Options<Model, Msg, Infallible, &'static str> =
        observe!(calls, demlik_tea::runtime::Options::new, profile);
    options.clock = Rc::new(|| 17.25);
    let errors = Rc::clone(&log);
    options.on_error = Some(Rc::new(move |error, phase| {
        let message = match error {
            RuntimeError::IdentityDrop(notice) => {
                format!("{}:{}:{notice}", notice.name(), notice.msg_type)
            }
            RuntimeError::Panic(cause) => cause.summary.clone(),
            RuntimeError::Handler(error) => (*error).to_owned(),
            _ => error.name().to_owned(),
        };
        push(
            &errors,
            format!(
                "error:{}:{message}",
                serde_json::to_value(phase).unwrap().as_str().unwrap()
            ),
        );
    }));
    if matches!(
        case,
        Case::TimerFire | Case::TimerStop | Case::TimerOverride | Case::TimerHostCancel
    ) {
        options.terminal = Some(Rc::new(|s: &Model| s.n > 0));
    }
    if let Some(host) = host {
        options.timer = Some(observe!(
            calls,
            demlik_tea::runtime::RuntimeTimer::new,
            host
        ));
    }
    if case == Case::Events {
        let telemetry = Rc::clone(&log);
        options.telemetry = Some(observe!(
            calls,
            demlik_tea::runtime::Telemetry::new,
            move |event| {
                push(
                    &telemetry,
                    format!(
                        "telemetry:{}:{}:{}",
                        number(event.seq),
                        event.msg_type,
                        number(event.at)
                    ),
                );
                async move {
                    if event.seq == 2.0 {
                        Err("telemetry boom")
                    } else {
                        Ok(())
                    }
                }
            }
        ));
    }
    let events = Rc::clone(&log);
    let options = observe!(
        calls,
        demlik_tea::runtime::Options::with_events,
        options,
        move |msg: &Msg, state: &Model| {
            if case != Case::Events {
                return vec![];
            }
            push(&events, format!("project:{}:{}", msg.tag(), state.n));
            if matches!(msg, Msg::ProjectCrash) {
                panic!("projector boom");
            }
            vec![Pulse(state.n)]
        }
    );
    observe!(
        calls,
        demlik_tea::runtime::launch,
        authored,
        (),
        Handler,
        Runner { case, log, hold },
        options
    )
}
async fn pump() {
    for _ in 0..24 {
        tokio::task::yield_now().await;
    }
}
async fn execute(script: Script) -> Value {
    let log: Log = Rc::new(RefCell::new(vec![]));
    let calls: Calls = Rc::new(RefCell::new(vec![]));
    let host = matches!(
        script.case,
        Case::TimerFire | Case::TimerStop | Case::TimerOverride | Case::TimerHostCancel
    )
    .then(|| Rc::new(Host::new(Rc::clone(&log))));
    let runtime = boot(
        &script,
        Rc::clone(&log),
        Rc::clone(&calls),
        host.clone(),
        "first",
        None,
    );
    observe_async!(calls, demlik_tea::runtime::Runtime::ready, &runtime).unwrap();
    if script.case == Case::ScopeClose {
        let scope = observe!(calls, demlik_tea::runtime::EffectScope::new);
        let release = Rc::new(Notify::new());
        let second = boot(
            &script,
            Rc::clone(&log),
            Rc::clone(&calls),
            None,
            "second",
            Some(Rc::clone(&release)),
        );
        observe_async!(calls, demlik_tea::runtime::Runtime::ready, &second).unwrap();
        observe_async!(
            calls,
            demlik_tea::runtime::EffectScope::attach,
            &scope,
            &runtime
        )
        .unwrap();
        observe_async!(
            calls,
            demlik_tea::runtime::EffectScope::attach,
            &scope,
            &second
        )
        .unwrap();
        push(&log, "host:close-start");
        let closing = observe!(calls, demlik_tea::runtime::EffectScope::close, &scope);
        tokio::pin!(closing);
        assert!(futures::poll!(closing.as_mut()).is_pending());
        pump().await;
        push(&log, format!("host:close-pending:{}", !scope.is_closed()));
        release.notify_one();
        closing.await;
        push(&log, "host:close-done");
        return json!({"comparison":{"trace":*log.borrow(),"state":0},"observedRustCalls":*calls.borrow()});
    }
    match script.case {
        Case::Identity => {
            let trace = Rc::clone(&log);
            let _boot = observe!(
                calls,
                demlik_tea::runtime::Runtime::on_boot,
                &runtime,
                move |s: &Model| push(&trace, format!("boot:{}", s.n))
            );
            let trace = Rc::clone(&log);
            let callback: Rc<dyn Fn()> = Rc::new(move || push(&trace, "changed"));
            let first = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_shared,
                &runtime,
                Rc::clone(&callback)
            );
            let duplicate = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_shared,
                &runtime,
                Rc::clone(&callback)
            );
            first();
            let _new = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_shared,
                &runtime,
                Rc::clone(&callback)
            );
            duplicate();
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Address { owner: 1 }
            )
            .unwrap();
            let repeat = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_shared,
                &runtime,
                Rc::clone(&callback)
            );
            repeat();
            let _new = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_shared,
                &runtime,
                callback
            );
            repeat();
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Address { owner: 2 }
            )
            .unwrap();
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Ping
            )
            .unwrap();
        }
        Case::Ports => {
            let name = format!("runtime-hooks:{}", script.id);
            let port: Port<u32> =
                observe!(calls, demlik_tea::ports::define_port::<u32>, name.clone()).unwrap();
            let collision =
                observe!(calls, demlik_tea::ports::define_port::<String>, name).unwrap_err();
            push(&log, format!("collision:{}:{collision}", collision.name()));
            let second = boot(
                &script,
                Rc::clone(&log),
                Rc::clone(&calls),
                None,
                "second",
                None,
            );
            observe_async!(calls, demlik_tea::runtime::Runtime::ready, &second).unwrap();
            let trace = Rc::clone(&log);
            let _other = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &second,
                &port,
                Rc::new(move |value: &u32| push(&trace, format!("other:{value}")))
            );
            let own = Rc::new(RefCell::new(None::<Unsubscribe>));
            let removed = Rc::new(RefCell::new(None::<Unsubscribe>));
            let own_in = Rc::clone(&own);
            let removed_in = Rc::clone(&removed);
            let run = runtime.clone();
            let token = port.clone();
            let trace = Rc::clone(&log);
            let tracked = Rc::clone(&calls);
            *own.borrow_mut() = Some(observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &runtime,
                &port,
                Rc::new(move |value: &u32| {
                    push(&trace, format!("first:{value}"));
                    own_in.borrow().as_ref().unwrap()();
                    removed_in.borrow().as_ref().unwrap()();
                    let trace = Rc::clone(&trace);
                    let _added = observe!(
                        tracked,
                        demlik_tea::runtime::Runtime::subscribe_port,
                        &run,
                        &token,
                        Rc::new(move |value: &u32| push(&trace, format!("added:{value}")))
                    );
                })
            ));
            let trace = Rc::clone(&log);
            *removed.borrow_mut() = Some(observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &runtime,
                &port,
                Rc::new(move |value: &u32| push(&trace, format!("removed:{value}")))
            ));
            let trace = Rc::clone(&log);
            let _bad = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &runtime,
                &port,
                Rc::new(move |value: &u32| {
                    push(&trace, format!("bad:{value}"));
                    panic!("port boom");
                })
            );
            let trace = Rc::clone(&log);
            let same: Rc<dyn Fn(&u32)> =
                Rc::new(move |value| push(&trace, format!("same:{value}")));
            let stale = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &runtime,
                &port,
                Rc::clone(&same)
            );
            let duplicate = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &runtime,
                &port,
                Rc::clone(&same)
            );
            stale();
            let _again = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &runtime,
                &port,
                Rc::clone(&same)
            );
            duplicate();
            observe!(
                calls,
                demlik_tea::runtime::Runtime::emit_port,
                &runtime,
                &port,
                1
            );
            observe!(
                calls,
                demlik_tea::runtime::Runtime::emit_port,
                &runtime,
                &port,
                2
            );
            observe!(
                calls,
                demlik_tea::runtime::Runtime::emit_port,
                &second,
                &port,
                3
            );
            let replacement: Port<u32> = observe!(
                calls,
                demlik_tea::ports::define_port::<u32>,
                format!("runtime-hooks:replacement:{}", script.id)
            )
            .unwrap();
            let trace = Rc::clone(&log);
            let callback: Rc<dyn Fn(&u32)> =
                Rc::new(move |value| push(&trace, format!("replacement:{value}")));
            let old = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &runtime,
                &replacement,
                Rc::clone(&callback)
            );
            old();
            let _new = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe_port,
                &runtime,
                &replacement,
                callback
            );
            old();
            observe!(
                calls,
                demlik_tea::runtime::Runtime::emit_port,
                &runtime,
                &replacement,
                4
            );
            observe_async!(calls, demlik_tea::runtime::Runtime::stop, &second);
        }
        Case::Events => {
            let trace = Rc::clone(&log);
            let _changed = observe!(
                calls,
                demlik_tea::runtime::Runtime::subscribe,
                &runtime,
                move || push(&trace, "changed")
            );
            let trace = Rc::clone(&log);
            let _observed = observe!(
                calls,
                demlik_tea::runtime::Runtime::observe,
                &runtime,
                move |msg: &Msg, s: &Model| push(&trace, format!("observe:{}:{}", msg.tag(), s.n))
            );
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Ping
            )
            .unwrap();
            let trace = Rc::clone(&log);
            let first = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                Rc::new(move |event: &Pulse| {
                    push(&trace, format!("event:first:{}", event.0));
                    panic!("event boom");
                })
            );
            let trace = Rc::clone(&log);
            let cb: Rc<dyn Fn(&Pulse)> =
                Rc::new(move |event| push(&trace, format!("event:second:{}", event.0)));
            let second = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                Rc::clone(&cb)
            );
            let duplicate = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                Rc::clone(&cb)
            );
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Ping
            )
            .unwrap();
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::ProjectCrash
            )
            .unwrap();
            first();
            second();
            duplicate();
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Ping
            )
            .unwrap();
            let old = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                Rc::clone(&cb)
            );
            old();
            let replacement = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                Rc::clone(&cb)
            );
            old();
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Ping
            )
            .unwrap();
            replacement();
            let keeper = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                Rc::new(|_: &Pulse| {})
            );
            let stale = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                Rc::clone(&cb)
            );
            let other = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                Rc::clone(&cb)
            );
            stale();
            let _readded = observe!(
                calls,
                demlik_tea::runtime::Runtime::on,
                &runtime,
                "pulse",
                cb
            );
            other();
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Ping
            )
            .unwrap();
            keeper();
        }
        Case::TimerFire | Case::TimerStop | Case::TimerOverride | Case::TimerHostCancel => {
            pump().await;
            observe_async!(calls, demlik_tea::runtime::Runtime::idle, &runtime).unwrap();
            let trace = Rc::clone(&log);
            let _boot = observe!(
                calls,
                demlik_tea::runtime::Runtime::on_boot,
                &runtime,
                move |s: &Model| push(&trace, format!("boot:{}", s.n))
            );
            let trace = Rc::clone(&log);
            let _observed = observe!(
                calls,
                demlik_tea::runtime::Runtime::observe,
                &runtime,
                move |msg: &Msg, s: &Model| push(&trace, format!("commit:{}:{}", msg.tag(), s.n))
            );
            if script.case == Case::TimerFire {
                let host = host.as_ref().unwrap();
                pump().await;
                if script.ms.number() != f64::INFINITY
                    || matches!(script.profile, SelectedProfile::Promise)
                {
                    for _ in 0..4 {
                        if observe!(calls, demlik_tea::runtime::Runtime::get_state, &runtime)
                            .unwrap()
                            .n
                            > 0
                        {
                            break;
                        }
                        host.fire();
                        pump().await;
                    }
                    observe_async!(calls, demlik_tea::runtime::Runtime::done, &runtime).unwrap();
                }
            } else if script.case == Case::TimerOverride {
                observe_async!(calls, demlik_tea::runtime::Runtime::idle, &runtime).unwrap();
            } else if script.case == Case::TimerHostCancel {
                let host = host.as_ref().unwrap();
                let id = host.pending.borrow().keys().next().copied().unwrap();
                push(&log, "host:cancel");
                observe!(calls, Host::clear_timeout, host.as_ref(), &id);
                pump().await;
            }
        }
        Case::DriveDone | Case::DriveStall | Case::DriveCancel => {
            let trace = Rc::clone(&log);
            let _observer = observe!(
                calls,
                demlik_tea::runtime::Runtime::observe,
                &runtime,
                move |msg: &Msg, s: &Model| push(&trace, format!("commit:{}:{}", msg.tag(), s.n))
            );
            let mut options = DriveOptions::default();
            if script.case == Case::DriveCancel {
                let signal = observe!(calls, demlik_tea::runtime::DriveSignal::new);
                observe!(calls, demlik_tea::runtime::DriveSignal::abort, &signal);
                options.cancellation = Some(observe!(
                    calls,
                    demlik_tea::runtime::DriveCancellation::new,
                    signal,
                    |_: &Model| Msg::Cancel
                ));
            }
            match observe_async!(
                calls,
                demlik_tea::runtime::drive_to_done,
                &runtime,
                Msg::Start,
                |s: &Model| s.n >= 3,
                options
            ) {
                Ok(state) => push(&log, format!("drive:done:{}", state.n)),
                Err(DriveError::Stalled { state }) => {
                    push(&log, format!("drive:DriveStalledError:{}", state.n))
                }
                Err(error) => panic!("unexpected drive error {error:?}"),
            }
        }
        Case::ScopeClose => unreachable!(),
    }
    pump().await;
    let state = observe!(calls, demlik_tea::runtime::Runtime::get_state, &runtime)
        .unwrap()
        .n;
    observe_async!(calls, demlik_tea::runtime::Runtime::stop, &runtime);
    json!({"comparison":{"trace":*log.borrow(),"state":state},"observedRustCalls":*calls.borrow()})
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for line in io::stdin().lock().lines() {
                let line = line.expect("read input line");
                if line.trim().is_empty() {
                    continue;
                }
                let script: Script = serde_json::from_str(&line).expect("validated hook script");
                println!("{}", execute(script).await);
            }
        })
        .await;
}
