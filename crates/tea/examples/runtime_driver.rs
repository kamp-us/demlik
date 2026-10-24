use std::cell::RefCell;
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

macro_rules! observe {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let value = $function($($arg),*);
        $calls.push(stringify!($function));
        value
    }};
}
macro_rules! observe_async {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let value = $function($($arg),*).await;
        $calls.push(stringify!($function));
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
#[derive(Clone)]
struct Saved {
    state: Rc<RefCell<Option<Model>>>,
    trace: Trace,
}
impl Store<Model> for Saved {
    type Raw = Option<Model>;
    type Error = &'static str;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.state.borrow().clone())
    }
    async fn save(&self, model: &Model) -> Result<(), Self::Error> {
        self.trace.borrow_mut().push(format!("save:{}", model.n));
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
        subscriptions: Box::new(|_| vec![]),
    }
}
async fn execute(input: Input, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let trace = Rc::new(RefCell::new(vec![]));
    let reports = Rc::new(RefCell::new(vec![]));
    let loaded = match input.scenario {
        Scenario::Restored => Some(Model { n: 5, done: false }),
        Scenario::TerminalBoot => Some(Model { n: 7, done: true }),
        _ => None,
    };
    let saved = Saved {
        state: Rc::new(RefCell::new(loaded)),
        trace: Rc::clone(&trace),
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
    if !matches!(input.scenario, Scenario::TerminalBoot) {
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
    let mut output = json!({"state":*state,"result":terminal.as_deref(),"done":done.as_deref(),"saved":saved_value(),"trace":trace.borrow().clone(),"failure":failure,"reports":reports.borrow().clone()});
    observe_async!(calls, demlik_tea::runtime::Runtime::stop, &runtime);
    output["afterStop"] = json!({"saved":saved_value(),"trace":trace.borrow().clone(),"reports":reports.borrow().clone()});
    Ok(output)
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    for line in io::stdin().lock().lines() {
        let mut calls = vec![];
        let answer = match line.map_err(|error| error.to_string()).and_then(|line| {
            serde_json::from_str::<Request>(&line).map_err(|error| error.to_string())
        }) {
            Ok(request) => {
                match tokio::task::LocalSet::new()
                    .run_until(execute(request.input, &mut calls))
                    .await
                {
                    Ok(output) => {
                        json!({"id":request.id,"ok":true,"output":output,"observedCalls":calls})
                    }
                    Err(error) => {
                        json!({"id":request.id,"ok":false,"error":error,"observedCalls":calls})
                    }
                }
            }
            Err(error) => json!({"id":null,"ok":false,"error":error,"observedCalls":calls}),
        };
        println!("{answer}");
    }
}
