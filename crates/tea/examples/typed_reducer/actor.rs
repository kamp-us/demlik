use super::{Calls, observe, observe_async};
use demlik_tea::{
    Machine, NoCellError, PlainData, Step, Sub, Tagged, TryUpdate,
    command::{CommandContractError, CommandFamily},
    core::{Identity, Row},
    persistence::recorder::RecorderOptions,
    runtime::{
        CommandContext, CommandWork, ErrorPhase, Interpreter, NoEvent, NoSubscriptions, Options,
        Persistence, Profile, RuntimeError, Supervision,
    },
    storage::{Migrated, Store},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    sync::Arc,
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectedProfile {
    Promise,
    Effect,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Stop,
    Escalate,
    Restart,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scenario {
    Declared,
    NestedNoCell,
    Panic,
    Lookup,
    IdentityDrop,
    IdentityPanic,
    Success,
    RehydratePanic,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verb {
    Dispatch,
    Once,
}
struct Cause(Cell<u8>);
struct Failure {
    original: Rc<Cause>,
    nested: Option<NoCellError>,
}
struct Model {
    n: i64,
    original: Rc<Cause>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
enum Msg {
    Add(i64),
    Reject,
    Unknown,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Add(_) => "add",
            Self::Reject => "reject",
            Self::Unknown => "unknown",
        }
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["add", "reject", "unknown"];
}
struct Cmd(i64);
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "effect"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, completion: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(completion)
    }
}
type Trace = Rc<RefCell<Vec<String>>>;
struct Host {
    trace: Trace,
    effects: Rc<Cell<u32>>,
}
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Infallible>> {
        Some(CommandWork::new(async move {
            self.trace.borrow_mut().push(format!("effect:{}", cmd.0));
            self.effects.set(self.effects.get() + 1);
            Ok(vec![])
        }))
    }
}
struct Saved {
    trace: Trace,
    values: Rc<RefCell<Vec<i64>>>,
}
impl Store<Model> for Saved {
    type Raw = ();
    type Error = Infallible;
    async fn load(&self) -> Result<(), Infallible> {
        self.trace.borrow_mut().push("load".into());
        Ok(())
    }
    async fn save(&self, state: &Model) -> Result<(), Infallible> {
        self.trace.borrow_mut().push(format!("save:{}", state.n));
        self.values.borrow_mut().push(state.n);
        Ok(())
    }
    fn migrate(&self, _: ()) -> Migrated<Model> {
        self.trace.borrow_mut().push("migrate".into());
        Migrated::Fresh
    }
}
fn add(s: &Model, m: &Msg, trace: &RefCell<Vec<String>>) -> Step<Model, Cmd> {
    let Msg::Add(by) = m else {
        panic!("wrong add fixture")
    };
    trace.borrow_mut().push(format!("reduce:add:{}", s.n));
    let n = s.n + by;
    Step::new(
        Model {
            n,
            original: Rc::clone(&s.original),
        },
        vec![Cmd(n)],
    )
}
type Error = RuntimeError<Infallible, Infallible, Failure>;
fn kind(error: &Error) -> &'static str {
    match error {
        RuntimeError::Reduce(f) => {
            if f.nested.is_some() {
                "nested-no-cell"
            } else {
                "declared"
            }
        }
        RuntimeError::NoCell(_) => "lookup",
        RuntimeError::Panic(_) => "panic",
        RuntimeError::IdentityDrop(_) => "identity-drop",
        RuntimeError::Stopped { .. } | RuntimeError::Discarded { .. } => "stopped",
        _ => panic!("unexpected runtime error {}", error.name()),
    }
}
pub async fn execute(
    selected: SelectedProfile,
    policy: Policy,
    scenario: Scenario,
    verb: Verb,
    calls: &Calls,
) -> Value {
    let trace = Rc::new(RefCell::new(vec![]));
    let values = Rc::new(RefCell::new(vec![]));
    let effects = Rc::new(Cell::new(0));
    let original = Rc::new(Cause(Cell::new(73)));
    let init_log = Rc::clone(&trace);
    let init_cause = Rc::clone(&original);
    let update = if matches!(scenario, Scenario::Lookup) {
        let log = Rc::clone(&trace);
        let mut row: Row<'static, Model, Msg, Cmd> = Row::new();
        row.insert("add".into(), Box::new(move |s, m| add(s, m, &log)));
        TryUpdate::RawReducer(row)
    } else {
        let log = Rc::clone(&trace);
        let cause = Rc::clone(&original);
        TryUpdate::try_reducer(move |s: &Model, m: &Msg| match m {
            Msg::Add(_) => Ok(add(s, m, &log)),
            Msg::Reject => {
                log.borrow_mut().push(format!("reduce:reject:{}", s.n));
                if matches!(scenario, Scenario::Panic) {
                    panic!("reducer boundary panic")
                };
                Err(Failure {
                    original: Rc::clone(&cause),
                    nested: matches!(scenario, Scenario::NestedNoCell).then(|| {
                        NoCellError::new("child-missing", "child", vec!["child-ok".into()])
                    }),
                })
            }
            Msg::Unknown => panic!("unknown exhaustive fixture"),
        })
    };
    let sub_log = Rc::clone(&trace);
    let machine: Machine<'static, Model, Msg, Cmd, Sub, (), Failure> = Machine {
        init: Box::new(move |_, _| {
            init_log.borrow_mut().push("init:5".into());
            Step::new(
                Model {
                    n: 5,
                    original: Rc::clone(&init_cause),
                },
                vec![],
            )
        }),
        update,
        subscriptions: demlik_tea::core::try_subscriptions(move |s: &Model| {
            sub_log.borrow_mut().push(format!("subs:{}", s.n));
            Ok(vec![])
        }),
    };
    let authored = observe!(
        calls,
        demlik_tea::core::Machine::with_identity,
        machine,
        Identity::new(
            |_| PlainData::Number(1.0),
            move |m: &Msg| {
                if matches!(m, Msg::Reject) {
                    if matches!(scenario, Scenario::IdentityPanic) {
                        panic!("identity boundary panic")
                    }
                    if matches!(scenario, Scenario::IdentityDrop) {
                        return PlainData::Number(2.0);
                    }
                }
                PlainData::Undefined
            }
        )
    );
    let profile = match selected {
        SelectedProfile::Promise => Profile::Promise,
        SelectedProfile::Effect => Profile::Effect,
    };
    let mut options: Options<Model, Msg, Infallible, Infallible, NoEvent, Failure> =
        Options::new(profile);
    options.store = Some(Persistence::new(Saved {
        trace: Rc::clone(&trace),
        values: Rc::clone(&values),
    }));
    let reports = Rc::new(RefCell::new(vec![]));
    let native_errors = Rc::new(RefCell::new(vec![]));
    let reported_ptr = Rc::new(Cell::new(0usize));
    let log = Rc::clone(&trace);
    let report_rows = Rc::clone(&reports);
    let saved = Rc::clone(&values);
    let effect_count = Rc::clone(&effects);
    let cause = Rc::clone(&original);
    let raw = Rc::clone(&native_errors);
    let ptr = Rc::clone(&reported_ptr);
    options.on_error = Some(Rc::new(move |error, phase| {
        let k = kind(error);
        log.borrow_mut().push(format!(
            "report:{}:{k}",
            serde_json::to_value(phase).unwrap().as_str().unwrap()
        ));
        if phase == ErrorPhase::Reduce {
            ptr.set(std::ptr::from_ref(error).addr())
        }
        let same = match error {
            RuntimeError::Reduce(f) => {
                Some(Rc::ptr_eq(&f.original, &cause) && f.original.0.get() == 73)
            }
            _ => None,
        };
        report_rows.borrow_mut().push(json!({"phase":phase,"kind":k,"sameOriginal":same,"saved":*saved.borrow(),"effects":effect_count.get()}));
        raw.borrow_mut()
            .push(json!({"phase":phase,"name":error.name()}));
    }));
    let restart_rows = Rc::new(RefCell::new(vec![]));
    options.supervision = match policy {
        Policy::Stop => Supervision::Stop,
        Policy::Escalate => Supervision::Escalate,
        Policy::Restart => {
            let log = Rc::clone(&trace);
            let rows = Rc::clone(&restart_rows);
            let ptr = Rc::clone(&reported_ptr);
            Supervision::Restart(Rc::new(move |s, m, error| {
                log.borrow_mut()
                    .push(format!("rehydrate:{}:{}", m.tag(), s.n));
                rows.borrow_mut().push(json!({"state":s.n,"msg":m.tag(),"kind":kind(error),"sameReport":ptr.get()==std::ptr::from_ref(error).addr()}));
                if matches!(scenario, Scenario::RehydratePanic) {
                    panic!("rehydrate boundary panic")
                }
                Model {
                    n: 40,
                    original: Rc::clone(&s.original),
                }
            }))
        }
    };
    let host = Host {
        trace: Rc::clone(&trace),
        effects: Rc::clone(&effects),
    };
    let live = match selected {
        SelectedProfile::Promise => observe!(
            calls,
            demlik_tea::runtime::try_launch,
            authored,
            (),
            host,
            NoSubscriptions::new(),
            options
        ),
        SelectedProfile::Effect => observe_async!(
            calls,
            demlik_tea::runtime::try_run,
            authored,
            (),
            host,
            NoSubscriptions::new(),
            options
        ),
    };
    let record = observe!(
        calls,
        demlik_tea::persistence::recorder::recorder,
        &live,
        RecorderOptions {
            capture_steps: true,
            sample_rate: None
        }
    );
    let boot_log = Rc::clone(&trace);
    let unboot = observe!(
        calls,
        demlik_tea::runtime::Runtime::on_boot,
        &live,
        move |s| boot_log.borrow_mut().push(format!("boot:{}", s.n))
    );
    let observe_log = Rc::clone(&trace);
    let off = observe!(
        calls,
        demlik_tea::runtime::Runtime::observe,
        &live,
        move |m, s| observe_log
            .borrow_mut()
            .push(format!("observe:{}:{}", m.tag(), s.n))
    );
    if observe_async!(calls, demlik_tea::runtime::Runtime::ready, &live).is_err() {
        panic!("unexpected boot failure")
    }
    trace.borrow_mut().push("ready".into());
    let actions = if matches!(scenario, Scenario::Success) {
        vec![Msg::Add(2), Msg::Add(3)]
    } else {
        vec![
            Msg::Add(2),
            if matches!(scenario, Scenario::Lookup) {
                Msg::Unknown
            } else {
                Msg::Reject
            },
            Msg::Add(3),
        ]
    };
    let mut receipts = vec![];
    let mut before = None;
    let mut same_after_failure = Value::Null;
    for (index, message) in actions.into_iter().enumerate() {
        let label = message.tag().to_owned();
        if index == 1 {
            before = live.get_state()
        }
        let result = match verb {
            Verb::Dispatch => observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &live,
                message
            ),
            Verb::Once => observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch_once,
                &live,
                message
            ),
        };
        if index == 1 {
            same_after_failure = json!(Arc::ptr_eq(
                before.as_ref().unwrap(),
                &live.get_state().unwrap()
            ))
        }
        let outcome = match result {
            Ok(()) => {
                trace.borrow_mut().push(format!("receipt:{label}:ok"));
                json!({"msg":label,"ok":true})
            }
            Err(error) => {
                let k = kind(&error);
                trace.borrow_mut().push(format!("receipt:{label}:{k}"));
                let same = live.reports().iter().any(|r| Rc::ptr_eq(&r.error, &error));
                json!({"msg":label,"ok":false,"kind":k,"sameReport":same})
            }
        };
        receipts.push(outcome);
    }
    observe_async!(calls, demlik_tea::runtime::Runtime::idle, &live)
        .unwrap_or_else(|_| panic!("idle failed"));
    let state = observe!(calls, demlik_tea::runtime::Runtime::get_state, &live).unwrap();
    let snapshot = observe!(
        calls,
        demlik_tea::persistence::recorder::Recorder::dump,
        &record
    )
    .unwrap();
    let captured = json!({"anchor":snapshot.loaded.as_ref().map(|s|s.n),"msgs":snapshot.msgs.iter().map(|m|m.tag()).collect::<Vec<_>>(),"states":snapshot.steps.as_ref().unwrap().iter().map(|s|s.state.n).collect::<Vec<_>>(),"final":snapshot.final_state.n,"sameFinal":Arc::ptr_eq(&snapshot.final_state,&state)});
    observe!(
        calls,
        demlik_tea::persistence::recorder::Recorder::stop,
        &record
    );
    off();
    unboot();
    observe_async!(calls, demlik_tea::runtime::Runtime::stop, &live);
    trace.borrow_mut().push("stopped".into());
    let saved_after_stop = values.borrow().clone();
    observe_async!(calls, demlik_tea::runtime::Runtime::stop, &live);
    let final_trace = trace.borrow().clone();
    let report_values = reports.borrow().clone();
    let restart_values = restart_rows.borrow().clone();
    let raw_values = native_errors.borrow().clone();
    json!({"comparison":{"trace":final_trace,"receipts":receipts,"reports":report_values,"restarts":restart_values,"n":state.n,"owner":Rc::ptr_eq(&state.original,&original),"sameAfterTrigger":same_after_failure,"saved":saved_after_stop,"effects":effects.get(),"record":captured,"stopIdempotent":*values.borrow()==saved_after_stop},"errorProfile":raw_values})
}
