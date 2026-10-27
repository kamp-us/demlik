use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::resilience::deadline::{self, DeadlineExceeded};
use demlik_tea::runtime::{
    self, NoInterpreter, Options, Profile, Runtime, RuntimeTimer, SubscriptionWork, Subscriptions,
};
use demlik_tea::timing::{Timer, TimerCallback, TimerError};
use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    convert::Infallible,
    io::{self, BufRead},
    rc::Rc,
};
type Calls = Rc<RefCell<Vec<&'static str>>>;
type Log = Rc<RefCell<Vec<String>>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let value=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));value}};}
macro_rules! observe_async{($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let value=$function($($arg),*).await;$calls.borrow_mut().push(stringify!($function));value}};}
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum SelectedProfile {
    Promise,
    Effect,
}
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Action {
    Fire,
    Stop,
    Override,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Script {
    profile: SelectedProfile,
    action: Action,
}
struct Model {
    delivered: Option<(String, demlik_tea::data::JsText, deadline::DeadlineNumber)>,
    local: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
enum Cmd {}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for Cmd {
    type Msg = DeadlineExceeded;
    type Completion = Vec<DeadlineExceeded>;
    fn settle(
        self,
        _: Self::Completion,
        _: f64,
    ) -> Result<Vec<DeadlineExceeded>, CommandContractError> {
        match self {}
    }
}
struct Host {
    log: Log,
    pending: RefCell<Option<TimerCallback>>,
}
impl Timer for Host {
    type Handle = ();
    fn now_ms(&self) -> f64 {
        100.25
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<(), TimerError> {
        self.log.borrow_mut().push(format!("arm:{ms}"));
        *self.pending.borrow_mut() = Some(callback);
        Ok(())
    }
    fn clear_timeout(&self, _: &()) {
        self.log.borrow_mut().push("clear".into());
        self.pending.borrow_mut().take();
    }
}
struct Runners {
    enabled: bool,
    log: Log,
    calls: Calls,
}
impl Subscriptions<Sub<deadline::TimerDeps<DeadlineExceeded>>, DeadlineExceeded> for Runners {
    type Error = Infallible;
    fn has_runner(&self, _: &str) -> bool {
        self.enabled
    }
    fn start(
        &self,
        _: Sub<deadline::TimerDeps<DeadlineExceeded>>,
        producer: runtime::Producer<DeadlineExceeded>,
    ) -> Result<Option<SubscriptionWork<Infallible>>, Infallible> {
        self.log.borrow_mut().push("override".into());
        let msg = observe!(
            self.calls,
            deadline::deadline_exceeded,
            "override",
            200.5,
            None
        );
        observe!(self.calls, runtime::Producer::emit, &producer, msg).unwrap();
        let log = Rc::clone(&self.log);
        Ok(Some(SubscriptionWork::new(move || {
            log.borrow_mut().push("override:clear".into());
            async { Ok(()) }
        })))
    }
}
async fn pump() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}
async fn execute(script: Script) -> Value {
    let calls: Calls = Rc::new(RefCell::new(vec![]));
    let log: Log = Rc::new(RefCell::new(vec![]));
    let host = Rc::new(Host {
        log: Rc::clone(&log),
        pending: RefCell::new(None),
    });
    let mut cells: demlik_tea::core::Row<'static, Model, DeadlineExceeded, Cmd> =
        Default::default();
    cells.insert(
        "deadline_exceeded".into(),
        Box::new(|s: &Model, msg: &DeadlineExceeded| {
            Step::new(
                Model {
                    delivered: Some((msg.kind.clone(), msg.id.clone(), msg.at_ms)),
                    local: Rc::clone(&s.local),
                },
                vec![],
            )
        }),
    );
    let declarations = Rc::clone(&calls);
    let machine = Machine {
        init: Box::new(|_, _| {
            Step::new(
                Model {
                    delivered: None,
                    local: Rc::new(()),
                },
                vec![],
            )
        }),
        update: Update::raw_reducer(cells),
        subscriptions: demlik_tea::core::subscriptions(move |s: &Model| {
            if s.delivered.is_some() {
                return vec![];
            }
            let deadline = observe!(declarations, deadline::deadline_sub, "watch", 130.5);
            let deps = observe!(declarations, deadline::next_timer, &[deadline], 100.25).unwrap();
            vec![observe!(declarations, Sub::new, "timer", deps).unwrap()]
        }),
    };
    let mut options: Options<Model, DeadlineExceeded, Infallible, Infallible> = observe!(
        calls,
        Options::new,
        match script.profile {
            SelectedProfile::Promise => Profile::Promise,
            SelectedProfile::Effect => Profile::Effect,
        }
    );
    options.timer = Some(observe!(calls, RuntimeTimer::new, Rc::clone(&host)));
    options.terminal = Some(Rc::new(|s: &Model| s.delivered.is_some()));
    let runtime = observe!(
        calls,
        runtime::launch,
        machine,
        (),
        NoInterpreter::new(),
        Runners {
            enabled: script.action == Action::Override,
            log: Rc::clone(&log),
            calls: Rc::clone(&calls)
        },
        options
    );
    let ready_error = observe_async!(calls, Runtime::ready, &runtime)
        .err()
        .map(|error| error.name());
    if ready_error.is_none() {
        pump().await;
        observe_async!(calls, Runtime::idle, &runtime).unwrap();
        if script.action == Action::Fire {
            log.borrow_mut().push("fire".into());
            host.pending.borrow_mut().take().unwrap()().unwrap();
            observe_async!(calls, Runtime::done, &runtime).unwrap();
        }
    }
    observe_async!(calls, Runtime::stop, &runtime);
    pump().await;
    let state = observe!(calls, Runtime::get_state, &runtime).unwrap();
    let delivered = state
        .delivered
        .as_ref()
        .map(|(kind, id, at_ms)| json!({"type":kind,"id":id,"atMs":at_ms}));
    json!({"comparison":{"readyError":ready_error,"trace":*log.borrow(),"delivered":delivered,"pending":host.pending.borrow().is_some()},"observedRustCalls":*calls.borrow()})
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for line in io::stdin().lock().lines() {
                let line = line.unwrap();
                if line.trim().is_empty() {
                    continue;
                }
                let script: Script = serde_json::from_str(&line).unwrap();
                println!("{}", execute(script).await);
            }
        })
        .await;
}
