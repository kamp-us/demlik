use demlik_tea::flow::saga::{
    self, Saga, SagaConfig, SagaFields, SagaPhase, SagaState, SagaStep, StepId,
};
use demlik_tea::{
    PlainData, Step,
    data::{plain_data, stringify_json},
    work_queue::{Queue, QueueField},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead},
    rc::Rc,
};
#[path = "../paginate_queue/wire.rs"]
mod wire;
use wire::{Number, data, snapshot};
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));result}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputStep {
    #[serde(rename = "do")]
    forward: Value,
    undo: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Seed {
    position: Option<Number>,
    done: Vec<Option<Number>>,
    compensating: bool,
    phase: SagaPhase,
    #[serde(default)]
    error: QueueField<Value>,
    #[serde(default)]
    compensation_error: QueueField<Value>,
}
type State = SagaState<StepId, PlainData>;
fn id(number: Option<Number>) -> StepId {
    StepId(number.map(Number::value))
}
fn slot(field: QueueField<Value>) -> QueueField<Rc<PlainData>> {
    match field {
        QueueField::Absent => QueueField::Absent,
        QueueField::Undefined => QueueField::Undefined,
        QueueField::Value(value) => QueueField::Value(Rc::new(data(&value))),
    }
}
impl From<Seed> for Rc<State> {
    fn from(seed: Seed) -> Self {
        Rc::new(State::new(SagaFields {
            position: id(seed.position),
            done: Rc::new(seed.done.into_iter().map(id).collect()),
            compensating: seed.compensating,
            phase: seed.phase,
            error: slot(seed.error),
            compensation_error: slot(seed.compensation_error),
            items: Queue::new(),
        }))
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Action {
    Start,
    StepOk,
    StepErr { error: Value },
    UndoOk,
    UndoErr { error: Value },
    Reset,
    RoundTrip,
    Restore { encoded: String },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Script {
    steps: Vec<InputStep>,
    initial: Option<Seed>,
    actions: Vec<Action>,
}
fn predicates(state: &State, calls: &Calls) -> Value {
    json!({"committed":observe!(calls,saga::is_committed,state),"aborted":observe!(calls,saga::is_aborted,state),"compensationFailed":observe!(calls,saga::is_compensation_failed,state),"settled":observe!(calls,saga::is_settled,state)})
}
fn row(
    state: &State,
    commands: &[Rc<PlainData>],
    same_state: Option<bool>,
    same_items: Option<bool>,
    prior_unchanged: bool,
    configured: &[Rc<PlainData>],
    calls: &Calls,
) -> Value {
    json!({"state":snapshot(state),"commands":snapshot(&commands),"sameState":same_state,"sameItems":same_items,"priorUnchanged":prior_unchanged,"commandsAreConfigured":commands.iter().all(|command|configured.iter().any(|configured|Rc::ptr_eq(command,configured))),"predicates":predicates(state,calls),"serialized":stringify_json(&plain_data(state).unwrap()).unwrap()})
}
fn execute(script: Script) -> Value {
    let calls = Calls::default();
    let mut configured = vec![];
    let steps = script
        .steps
        .into_iter()
        .map(|step| {
            let forward = Rc::new(data(&step.forward));
            let undo = Rc::new(data(&step.undo));
            configured.extend([Rc::clone(&forward), Rc::clone(&undo)]);
            observe!(&calls, SagaStep::new, forward, undo)
        })
        .collect();
    let saga: Saga<PlainData, PlainData> =
        observe!(&calls, saga::create_saga, SagaConfig { steps });
    let mut state: Rc<State> = script
        .initial
        .map(Into::into)
        .unwrap_or_else(|| observe!(&calls, Saga::init, &saga));
    let mut rows = vec![row(&state, &[], None, None, true, &configured, &calls)];
    for action in script.actions {
        let previous = Rc::clone(&state);
        let before = snapshot(&previous);
        let step = match action {
            Action::Start => observe!(&calls, Saga::start, &saga, &state),
            Action::StepOk => observe!(&calls, Saga::step_ok, &saga, &state),
            Action::StepErr { error } => {
                observe!(&calls, Saga::step_err, &saga, &state, Rc::new(data(&error)))
            }
            Action::UndoOk => observe!(&calls, Saga::undo_ok, &saga, &state),
            Action::UndoErr { error } => {
                observe!(&calls, Saga::undo_err, &saga, &state, Rc::new(data(&error)))
            }
            Action::Reset => Step::new(observe!(&calls, saga::init_saga), vec![]),
            Action::RoundTrip => {
                let encoded = stringify_json(&plain_data(&state).unwrap()).unwrap();
                Step::new(Rc::new(serde_json::from_str(&encoded).unwrap()), vec![])
            }
            Action::Restore { encoded } => {
                Step::new(Rc::new(serde_json::from_str(&encoded).unwrap()), vec![])
            }
        };
        state = step.state;
        rows.push(row(
            &state,
            &step.commands,
            Some(Rc::ptr_eq(&state, &previous)),
            Some(state.items.ptr_eq(&previous.items)),
            before == snapshot(&previous),
            &configured,
            &calls,
        ));
    }
    json!({"comparison":rows,"observedRustCalls":*calls.borrow()})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        println!(
            "{}",
            execute(serde_json::from_str(&line).expect("validated saga script"))
        );
    }
}
