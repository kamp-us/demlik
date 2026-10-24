use std::cell::{Cell, RefCell};
use std::io::{self, BufRead};
use std::rc::Rc;

use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile, RuntimeError,
};
use demlik_tea::storage::{Migrated, Store};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;

type Calls = Rc<RefCell<Vec<&'static str>>>;

macro_rules! observe {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let value = $function($($arg),*);
        $calls.borrow_mut().push(stringify!($function));
        value
    }};
}
macro_rules! observe_async {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let value = $function($($arg),*).await;
        $calls.borrow_mut().push(stringify!($function));
        value
    }};
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Scenario {
    Serial,
    Restored,
    MissingHandler,
    HandlerFailure,
    NoStore,
    TerminalBoot,
    HeldSave,
    FailedSave,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SelectedProfile {
    Promise,
    Effect,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    profile: SelectedProfile,
    scenario: Scenario,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    input: Input,
}
#[derive(Clone, Serialize)]
struct Model {
    n: i64,
    done: bool,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
messages! { enum Msg { Start, Added { by: i64 }, Finish } }
enum Cmd {
    Batch,
    Last,
    Fail,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Batch => "Batch",
            Self::Last => "Last",
            Self::Fail => "Fail",
        }
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
struct SaveGate {
    entered: Notify,
    released: Notify,
    held: Cell<bool>,
    fail: bool,
}
#[derive(Clone)]
struct Saved {
    state: Rc<RefCell<Option<Model>>>,
    trace: Trace,
    gate: Option<Rc<SaveGate>>,
}
impl Store<Model> for Saved {
    type Raw = Option<Model>;
    type Error = &'static str;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.state.borrow().clone())
    }
    async fn save(&self, model: &Model) -> Result<(), Self::Error> {
        self.trace.borrow_mut().push(format!("save:{}", model.n));
        if let Some(gate) = &self.gate {
            if model.done && !gate.held.replace(true) {
                gate.entered.notify_one();
                gate.released.notified().await;
                if gate.fail {
                    return Err("intentional save failure");
                }
            }
        }
        *self.state.borrow_mut() = Some(model.clone());
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Model> {
        raw.map(Migrated::State).unwrap_or(Migrated::Fresh)
    }
}
struct Effects {
    trace: Trace,
    scenario: Scenario,
}
impl Interpreter<Cmd> for Effects {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        context: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        if matches!(self.scenario, Scenario::MissingHandler) {
            return None;
        }
        Some(CommandWork::new(async move {
            self.trace.borrow_mut().push(command.tag().into());
            match command {
                Cmd::Batch => Ok(vec![Msg::Added { by: 2 }, Msg::Added { by: 4 }]),
                Cmd::Last => {
                    context
                        .dispatch(Msg::Added { by: 8 })
                        .map_err(|_| "unexpected dispatch refusal")?;
                    Ok(vec![Msg::Finish])
                }
                Cmd::Fail => Err("intentional handler failure"),
            }
        }))
    }
}
fn machine(scenario: Scenario) -> Machine<'static, Model, Msg, Cmd, Sub, ()> {
    Machine {
        init: Box::new(|loaded, _| {
            Step::new(loaded.unwrap_or(Model { n: 0, done: false }), vec![])
        }),
        update: Update::reducer(move |state: &Model, message: &Msg| {
            let (n, done, commands) = match message {
                Msg::Start => (
                    state.n + 1,
                    matches!(scenario, Scenario::HandlerFailure),
                    if matches!(scenario, Scenario::HandlerFailure) {
                        vec![Cmd::Fail]
                    } else {
                        vec![Cmd::Batch, Cmd::Last]
                    },
                ),
                Msg::Added { by } => (state.n + by, state.done, vec![]),
                Msg::Finish => (state.n, true, vec![]),
            };
            Step::new(Model { n, done }, commands)
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
async fn execute(input: Input, calls: &Calls) -> Result<Value, String> {
    let trace = Rc::new(RefCell::new(vec![]));
    let reports = Rc::new(RefCell::new(vec![]));
    let controls_save = matches!(input.scenario, Scenario::HeldSave | Scenario::FailedSave);
    let gate = Rc::new(SaveGate {
        entered: Notify::new(),
        released: Notify::new(),
        held: Cell::new(false),
        fail: matches!(input.scenario, Scenario::FailedSave),
    });
    let loaded = match input.scenario {
        Scenario::Restored => Some(Model { n: 5, done: false }),
        Scenario::TerminalBoot => Some(Model { n: 7, done: true }),
        _ => None,
    };
    let saved = Saved {
        state: Rc::new(RefCell::new(loaded)),
        trace: Rc::clone(&trace),
        gate: controls_save.then(|| Rc::clone(&gate)),
    };
    let profile = match input.profile {
        SelectedProfile::Promise => Profile::Promise,
        SelectedProfile::Effect => Profile::Effect,
    };
    let mut options = Options::new(profile);
    if !matches!(input.scenario, Scenario::NoStore) {
        options.store = Some(observe!(
            calls,
            demlik_tea::runtime::Persistence::new,
            saved.clone()
        ));
    }
    options.terminal = Some(Rc::new(|state: &Model| state.done));
    let reported = Rc::clone(&reports);
    options.on_error = Some(Rc::new(move |_, phase| {
        reported
            .borrow_mut()
            .push(serde_json::to_value(phase).expect("phase serializes"))
    }));
    let interpreter = Effects {
        trace: Rc::clone(&trace),
        scenario: input.scenario,
    };
    let runtime = match input.profile {
        SelectedProfile::Promise => observe!(
            calls,
            demlik_tea::runtime::launch,
            machine(input.scenario),
            (),
            interpreter,
            NoSubscriptions::new(),
            options
        ),
        SelectedProfile::Effect => observe_async!(
            calls,
            demlik_tea::runtime::run,
            machine(input.scenario),
            (),
            interpreter,
            NoSubscriptions::new(),
            options
        ),
    };
    let boot_trace = Rc::clone(&trace);
    let _remove_boot = observe!(
        calls,
        demlik_tea::runtime::Runtime::on_boot,
        &runtime,
        move |state| boot_trace
            .borrow_mut()
            .push(format!("commit:boot:{}", state.n))
    );
    let commit_trace = Rc::clone(&trace);
    let _remove_observer = observe!(
        calls,
        demlik_tea::runtime::Runtime::observe,
        &runtime,
        move |message, state| commit_trace.borrow_mut().push(format!(
            "commit:{}:{}",
            message.tag(),
            state.n
        ))
    );
    observe_async!(calls, demlik_tea::runtime::Runtime::ready, &runtime)
        .map_err(|e| e.to_string())?;
    let mut failure = None;
    let mut pending_save = Value::Null;
    let mut done_failure = None;
    let mut done_state = None;
    if controls_save {
        let mut dispatched = Box::pin(async {
            observe_async!(
                calls,
                demlik_tea::runtime::Runtime::dispatch,
                &runtime,
                Msg::Finish
            )
        });
        if futures::poll!(dispatched.as_mut()).is_ready() {
            return Err("terminal dispatch completed before controlled save".into());
        }
        gate.entered.notified().await;
        let mut waiter =
            Box::pin(async { observe_async!(calls, demlik_tea::runtime::Runtime::done, &runtime) });
        let early = futures::poll!(waiter.as_mut());
        let (done_status, early) = match early {
            std::task::Poll::Pending => ("pending", None),
            std::task::Poll::Ready(result) => (
                if result.is_ok() {
                    "resolved"
                } else {
                    "rejected"
                },
                Some(result),
            ),
        };
        pending_save = json!({"state":observe!(calls, demlik_tea::runtime::Runtime::get_state, &runtime).as_deref(),"result":observe!(calls, demlik_tea::runtime::Runtime::result, &runtime).as_deref(),"saved":*saved.state.borrow(),"doneStatus":done_status,"trace":trace.borrow().clone()});
        gate.released.notify_one();
        if let Err(error) = dispatched.await {
            failure = Some(failure_of(&error)?);
        }
        match match early {
            Some(result) => result,
            None => waiter.await,
        } {
            Ok(state) => done_state = Some(state),
            Err(error) => done_failure = Some(failure_of(&error)?),
        }
        if matches!(input.scenario, Scenario::FailedSave) {
            let later = observe_async!(calls, demlik_tea::runtime::Runtime::done, &runtime);
            match later {
                Err(error) if failure_of(&error)? == "save" => {}
                _ => return Err("later done() did not retain failed save".into()),
            }
        }
    } else if !matches!(input.scenario, Scenario::TerminalBoot) {
        if let Err(error) = observe_async!(
            calls,
            demlik_tea::runtime::Runtime::dispatch,
            &runtime,
            Msg::Start
        ) {
            match &*error {
                RuntimeError::Handler("intentional handler failure") => failure = Some("handler"),
                _ => return Err(format!("unexpected dispatch failure: {error}")),
            }
        }
    }
    let terminal = observe!(calls, demlik_tea::runtime::Runtime::result, &runtime);
    let done = if terminal.is_some() {
        Some(
            observe_async!(calls, demlik_tea::runtime::Runtime::done, &runtime)
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let state = observe!(calls, demlik_tea::runtime::Runtime::get_state, &runtime)
        .ok_or("missing initialized state")?;
    let saved_value = || {
        if matches!(input.scenario, Scenario::NoStore) {
            Value::Null
        } else {
            json!(*saved.state.borrow())
        }
    };
    let mut output = json!({"state":*state,"result":terminal.as_deref(),"done":done.as_deref(),"saved":saved_value(),"trace":trace.borrow().clone(),"failure":failure,"reports":reports.borrow().clone(),"pendingSave":pending_save,"doneFailure":done_failure,"doneState":done_state.as_deref()});
    observe_async!(calls, demlik_tea::runtime::Runtime::stop, &runtime);
    output["afterStop"] = json!({"saved":saved_value(),"trace":trace.borrow().clone(),"reports":reports.borrow().clone()});
    Ok(output)
}
fn failure_of(error: &RuntimeError<&'static str, &'static str>) -> Result<&'static str, String> {
    match error {
        RuntimeError::Handler("intentional handler failure") => Ok("handler"),
        RuntimeError::Save("intentional save failure") => Ok("save"),
        _ => Err(format!("unexpected failure: {error}")),
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    for line in io::stdin().lock().lines() {
        let calls = Rc::new(RefCell::new(vec![]));
        let answer = match line.map_err(|error| error.to_string()).and_then(|line| {
            serde_json::from_str::<Request>(&line).map_err(|error| error.to_string())
        }) {
            Ok(request) => {
                match tokio::task::LocalSet::new()
                    .run_until(execute(request.input, &calls))
                    .await
                {
                    Ok(output) => {
                        json!({"id":request.id,"ok":true,"output":output,"observedCalls":calls.borrow().clone()})
                    }
                    Err(error) => {
                        json!({"id":request.id,"ok":false,"error":error,"observedCalls":calls.borrow().clone()})
                    }
                }
            }
            Err(error) => {
                json!({"id":null,"ok":false,"error":error,"observedCalls":calls.borrow().clone()})
            }
        };
        println!("{answer}");
    }
}
