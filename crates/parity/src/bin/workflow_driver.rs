use demlik_tea::durable_effects::{
    self as ledger, DeliveryId, EffectConfirmed, EffectLedgerEvent, EffectOwed, LedgerRestore,
};
use demlik_tea::flow::workflow::{
    self as workflow, ActivityErr, ActivityOk, CompensationErr, CompensationOk, InFlightActivity,
    Workflow, WorkflowCmd, WorkflowMsg, WorkflowPhase, WorkflowState, WorkflowStep, WorkflowSteps,
    WorkflowValue,
};
use demlik_tea::{
    PlainData,
    data::{plain_data, stringify_json},
    work_queue::QueueField,
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
use wire::{Number, data, number, snapshot};
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));result}};}
#[path = "workflow_driver/runtime.rs"]
mod workflow_runtime;
type State = WorkflowState<PlainData, PlainData, PlainData>;
type Flow = Workflow<PlainData, PlainData, PlainData>;
type Event = EffectLedgerEvent<WorkflowCmd<PlainData>>;
type Id = Option<Number>;
fn id(value: Id) -> DeliveryId {
    DeliveryId(value.map(Number::value))
}
fn slot(value: QueueField<Value>) -> WorkflowValue<Rc<PlainData>> {
    match value {
        QueueField::Absent => WorkflowValue::Absent,
        QueueField::Undefined => WorkflowValue::Undefined,
        QueueField::Value(value) => match data(&value) {
            PlainData::Undefined => WorkflowValue::Undefined,
            value => WorkflowValue::Value(Rc::new(value)),
        },
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Seed {
    Undefined {
        #[serde(rename = "$undefined")]
        _value: bool,
    },
    Number(Id),
}
fn last_id(value: QueueField<Seed>) -> QueueField<DeliveryId> {
    match value {
        QueueField::Absent => QueueField::Absent,
        QueueField::Undefined | QueueField::Value(Seed::Undefined { .. }) => QueueField::Undefined,
        QueueField::Value(Seed::Number(value)) => QueueField::Value(id(value)),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StepInput {
    name: Value,
    #[serde(default)]
    activity: QueueField<Value>,
    #[serde(default)]
    compensation: QueueField<Value>,
}
impl From<StepInput> for Rc<WorkflowStep<PlainData>> {
    fn from(step: StepInput) -> Self {
        let PlainData::String(name) = data(&step.name) else {
            panic!("validated step name")
        };
        Rc::new(WorkflowStep {
            name,
            activity: slot(step.activity),
            compensation: slot(step.compensation),
        })
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum MessageInput {
    ActivityOk {
        id: Id,
        #[serde(default)]
        result: QueueField<Value>,
    },
    ActivityErr {
        id: Id,
        #[serde(default)]
        failure: QueueField<Value>,
    },
    CompensationOk {
        id: Id,
    },
    CompensationErr {
        id: Id,
        #[serde(default)]
        failure: QueueField<Value>,
    },
}
impl From<MessageInput> for WorkflowMsg<PlainData, PlainData> {
    fn from(message: MessageInput) -> Self {
        match message {
            MessageInput::ActivityOk { id: value, result } => Self::ActivityOk(ActivityOk {
                id: id(value),
                result: slot(result),
            }),
            MessageInput::ActivityErr { id: value, failure } => Self::ActivityErr(ActivityErr {
                id: id(value),
                failure: slot(failure),
            }),
            MessageInput::CompensationOk { id: value } => {
                Self::CompensationOk(CompensationOk { id: id(value) })
            }
            MessageInput::CompensationErr { id: value, failure } => {
                Self::CompensationErr(CompensationErr {
                    id: id(value),
                    failure: slot(failure),
                })
            }
        }
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
    Init,
    Deliver {
        message: MessageInput,
        route: bool,
    },
    AutoOk {
        #[serde(default)]
        result: QueueField<Value>,
    },
    AutoErr {
        #[serde(default)]
        failure: QueueField<Value>,
    },
    RoundTrip,
    Recreate {
        #[serde(default)]
        last_id: QueueField<Seed>,
    },
    Current {
        index: Id,
        id: Id,
    },
    Fold {
        messages: Vec<MessageInput>,
    },
    Surviving,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum EventInput {
    EffectOwed {
        id: Id,
        #[serde(default)]
        effect: QueueField<Value>,
    },
    EffectConfirmed {
        id: Id,
    },
}
impl From<EventInput> for Rc<EffectLedgerEvent<PlainData>> {
    fn from(event: EventInput) -> Self {
        Rc::new(match event {
            EventInput::EffectOwed { id: value, effect } => {
                EffectLedgerEvent::Owed(EffectOwed::new(
                    id(value),
                    Rc::new(match effect {
                        QueueField::Value(value) => data(&value),
                        QueueField::Absent | QueueField::Undefined => PlainData::Undefined,
                    }),
                ))
            }
            EventInput::EffectConfirmed { id: value } => {
                EffectLedgerEvent::Confirmed(EffectConfirmed { id: id(value) })
            }
        })
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum LedgerAction {
    Owe {
        effect: Value,
    },
    Confirm {
        id: Id,
    },
    Apply {
        event: EventInput,
    },
    Fold {
        events: Vec<EventInput>,
    },
    Recreate {
        #[serde(default)]
        last_id: QueueField<Seed>,
    },
    RoundTrip,
    Query {
        id: Id,
    },
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Script {
    Transport {
        profile: workflow_runtime::HostProfile,
        command: workflow_runtime::Kind,
        mode: workflow_runtime::Mode,
        index: Number,
        id: Number,
        payload: Value,
        at: Number,
    },
    Workflow {
        steps: Vec<StepInput>,
        #[serde(default)]
        last_id: QueueField<Seed>,
        actions: Vec<Action>,
    },
    Ledger {
        events: Vec<EventInput>,
        #[serde(default)]
        last_id: QueueField<Seed>,
        actions: Vec<LedgerAction>,
    },
}
fn encoded(value: &impl serde::Serialize) -> String {
    stringify_json(&plain_data(value).unwrap()).unwrap()
}
fn run_workflow(
    steps: Vec<StepInput>,
    seed: QueueField<Seed>,
    actions: Vec<Action>,
    calls: &Calls,
) -> Value {
    let mut steps = steps.into_iter().map(Rc::from);
    let first = steps.next().expect("nonempty workflow steps");
    let steps = observe!(calls, WorkflowSteps::new, first, steps);
    let mut flow: Flow = observe!(
        calls,
        workflow::create_workflow,
        LedgerRestore {
            events: vec![],
            last_id: last_id(seed)
        }
    );
    let mut state: Option<Rc<State>> = None;
    let mut log: Vec<Rc<Event>> = vec![];
    let mut rows = vec![];
    for action in actions {
        let previous = state.clone();
        let before = previous.as_ref().map(snapshot);
        let mut delta = vec![];
        let mut commands = vec![];
        let mut error = Value::Null;
        let mut folded = Value::Null;
        let result = match action {
            Action::Init => Some(observe!(calls, Workflow::init, &flow, &steps)),
            Action::Deliver { message, route } => {
                let message = message.into();
                let state = state.as_ref().expect("init before delivery");
                Some(if route {
                    observe!(calls, workflow::route_workflow_msg, &flow, state, &message)
                } else {
                    match message {
                        WorkflowMsg::ActivityOk(message) => {
                            observe!(calls, Workflow::on_activity_ok, &flow, state, &message)
                        }
                        WorkflowMsg::ActivityErr(message) => {
                            observe!(calls, Workflow::on_activity_err, &flow, state, &message)
                        }
                        WorkflowMsg::CompensationOk(message) => {
                            observe!(calls, Workflow::on_compensation_ok, &flow, state, &message)
                        }
                        WorkflowMsg::CompensationErr(message) => {
                            observe!(calls, Workflow::on_compensation_err, &flow, state, &message)
                        }
                    }
                })
            }
            Action::AutoOk { result } => state.as_ref().and_then(|state| {
                state.current().map(|current| {
                    let message = if matches!(state.status, WorkflowPhase::Running { .. }) {
                        WorkflowMsg::ActivityOk(ActivityOk {
                            id: current.id,
                            result: slot(result),
                        })
                    } else {
                        WorkflowMsg::CompensationOk(CompensationOk { id: current.id })
                    };
                    observe!(calls, workflow::route_workflow_msg, &flow, state, &message)
                })
            }),
            Action::AutoErr { failure } => state.as_ref().and_then(|state| {
                state.current().map(|current| {
                    let message = if matches!(state.status, WorkflowPhase::Running { .. }) {
                        WorkflowMsg::ActivityErr(ActivityErr {
                            id: current.id,
                            failure: slot(failure),
                        })
                    } else {
                        WorkflowMsg::CompensationErr(CompensationErr {
                            id: current.id,
                            failure: slot(failure),
                        })
                    };
                    observe!(calls, workflow::route_workflow_msg, &flow, state, &message)
                })
            }),
            Action::RoundTrip => {
                if let Some(current) = &state {
                    state = Some(Rc::new(serde_json::from_str(&encoded(current)).unwrap()));
                }
                log = serde_json::from_str(&encoded(&log)).unwrap();
                flow = observe!(
                    calls,
                    workflow::create_workflow,
                    LedgerRestore::from_events(log.iter().cloned())
                );
                None
            }
            Action::Recreate { last_id: seed } => {
                flow = observe!(
                    calls,
                    workflow::create_workflow,
                    LedgerRestore {
                        events: log.clone(),
                        last_id: last_id(seed)
                    }
                );
                None
            }
            Action::Current { index, id: value } => {
                let previous = state.as_ref().expect("active state");
                let old = previous.current().expect("in flight");
                let current = Rc::new(InFlightActivity {
                    index: id(index),
                    id: id(value),
                    step: Rc::clone(&old.step),
                });
                let status = match &previous.status {
                    WorkflowPhase::Running { .. } => WorkflowPhase::Running { current },
                    WorkflowPhase::Compensating {
                        failure,
                        compensated,
                        ..
                    } => WorkflowPhase::Compensating {
                        current,
                        failure: Rc::clone(failure),
                        compensated: Rc::clone(compensated),
                    },
                    _ => unreachable!(),
                };
                state = Some(Rc::new(State {
                    status,
                    steps: Rc::clone(&previous.steps),
                    completed: Rc::clone(&previous.completed),
                }));
                None
            }
            Action::Fold { messages } => {
                let messages = messages
                    .into_iter()
                    .map(WorkflowMsg::from)
                    .collect::<Vec<_>>();
                match observe!(calls, workflow::fold_workflow, &steps, &messages) {
                    Ok(state) => folded = snapshot(&state),
                    Err(cause) => error = json!({"name":"Error","message":cause.to_string()}),
                };
                None
            }
            Action::Surviving => None,
        };
        if let Some(result) = result {
            match result {
                Ok(step) => {
                    state = Some(step.state);
                    delta = step.ledger;
                    commands = step.cmds;
                    log.extend(delta.iter().cloned());
                }
                Err(cause) => error = json!({"name":"Error","message":cause.to_string()}),
            }
        }
        let same = match (&previous, &state) {
            (None, None) => true,
            (Some(previous), Some(state)) => Rc::ptr_eq(previous, state),
            _ => false,
        };
        let prior_unchanged = before == previous.as_ref().map(snapshot);
        let same_commands=commands.iter().all(|command|delta.iter().any(|event|matches!(event.as_ref(),EffectLedgerEvent::Owed(owed)if Rc::ptr_eq(command,&owed.effect))));
        let survivors = observe!(calls, Workflow::surviving_activities, &flow, &log);
        rows.push(json!({"state":state.as_ref().map(snapshot),"ledger":snapshot(&delta),"cmds":snapshot(&commands),"sameState":same,"priorUnchanged":prior_unchanged,"commandsAreOwed":same_commands,"survivors":snapshot(&survivors),"serialized":state.as_ref().map(encoded),"folded":folded,"error":error}));
    }
    json!(rows)
}
fn run_ledger(
    events: Vec<EventInput>,
    seed: QueueField<Seed>,
    actions: Vec<LedgerAction>,
    calls: &Calls,
) -> Value {
    let mut events = events.into_iter().map(Rc::from).collect::<Vec<_>>();
    let mut recorder = observe!(
        calls,
        ledger::pending_effects_ledger,
        LedgerRestore {
            events: events.clone(),
            last_id: last_id(seed)
        }
    );
    let mut pure = observe!(calls, ledger::empty_ledger);
    let mut rows = vec![];
    for action in actions {
        let previous = observe!(calls, ledger::PendingEffectsRecorder::ledger, &recorder);
        let mut result = Value::Null;
        match action {
            LedgerAction::Owe { effect } => {
                let effect = Rc::new(data(&effect));
                let owed = observe!(
                    calls,
                    ledger::PendingEffectsRecorder::owe,
                    &recorder,
                    Rc::clone(&effect)
                );
                let EffectLedgerEvent::Owed(event) = owed.event.as_ref() else {
                    unreachable!()
                };
                result = json!({"id":owed.id.number().map_or(Value::Null,number),"event":snapshot(&owed.event),"sameEffect":Rc::ptr_eq(&effect,&event.effect)});
                events.push(owed.event);
            }
            LedgerAction::Confirm { id: value } => {
                let confirmed = observe!(
                    calls,
                    ledger::PendingEffectsRecorder::confirm,
                    &recorder,
                    id(value)
                );
                result =
                    json!({"confirmed":confirmed.confirmed,"event":snapshot(&confirmed.event)});
                events.push(confirmed.event);
            }
            LedgerAction::Apply { event } => {
                let event: Rc<EffectLedgerEvent<PlainData>> = event.into();
                pure = observe!(calls, ledger::apply_effect_event, &pure, event.as_ref());
            }
            LedgerAction::Fold { events } => {
                let events = events.into_iter().map(Rc::from).collect::<Vec<_>>();
                pure = observe!(calls, ledger::fold_ledger, events.into_iter());
            }
            LedgerAction::Recreate { last_id: seed } => {
                recorder = observe!(
                    calls,
                    ledger::pending_effects_ledger,
                    LedgerRestore {
                        events: events.clone(),
                        last_id: last_id(seed)
                    }
                )
            }
            LedgerAction::RoundTrip => {
                events = serde_json::from_str(&encoded(&events)).unwrap();
                recorder = observe!(
                    calls,
                    ledger::pending_effects_ledger,
                    LedgerRestore::from_events(events.iter().cloned())
                );
            }
            LedgerAction::Query { id: value } => {
                result = json!(observe!(calls, ledger::is_owed, &previous, id(value)))
            }
        }
        let next = observe!(calls, ledger::PendingEffectsRecorder::ledger, &recorder);
        let survivors = observe!(calls, ledger::PendingEffectsRecorder::surviving, &recorder);
        let pure = observe!(calls, ledger::surviving_effects, &pure);
        let last = observe!(calls, ledger::PendingEffectsRecorder::last_id, &recorder);
        rows.push(json!({"lastId":number(last),"survivors":snapshot(&survivors),"pure":snapshot(&pure),"sameLedger":Rc::ptr_eq(&previous,&next),"previous":snapshot(&ledger::surviving_effects(&previous)),"result":result,"serializedEvents":encoded(&events)}));
    }
    json!(rows)
}
async fn execute(script: Script) -> Value {
    let calls = Calls::default();
    let comparison = match script {
        Script::Transport {
            profile,
            command,
            mode,
            index,
            id,
            payload,
            at,
        } => {
            workflow_runtime::execute(
                workflow_runtime::Input {
                    profile,
                    kind: command,
                    mode,
                    index,
                    id,
                    payload,
                    at: at.value(),
                },
                &calls,
            )
            .await
        }
        Script::Workflow {
            steps,
            last_id,
            actions,
        } => run_workflow(steps, last_id, actions, &calls),
        Script::Ledger {
            events,
            last_id,
            actions,
        } => run_ledger(events, last_id, actions, &calls),
    };
    json!({"comparison":comparison,"observedRustCalls":*calls.borrow()})
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
                let script: Script =
                    serde_json::from_str(&line).expect("validated workflow script");
                println!("{}", execute(script).await);
            }
        })
        .await;
}
