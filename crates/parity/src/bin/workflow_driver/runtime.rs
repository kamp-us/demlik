use super::{Calls, Number, data, snapshot};
use demlik_tea::command::{
    CommandContractError, CommandEdge, CommandFamily, Completion, EngineStamp, Outcome, Settled,
};
use demlik_tea::core::Message;
use demlik_tea::flow::workflow::{
    self, WorkflowActivityInput, WorkflowActivitySpec, WorkflowCmd, WorkflowCompensationInput,
    WorkflowCompensationSpec, WorkflowTransportFailure, WorkflowValue,
};
use demlik_tea::runtime::{
    self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence, Profile,
    Runtime,
};
use demlik_tea::storage::{MemoryStore, MemoryStoreError, Migrated, Store, memory_store};
use demlik_tea::{Machine, PlainData, Step, Sub, Tagged, Update};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{cell::RefCell, convert::Infallible, rc::Rc};
macro_rules! observe_async{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*).await;$calls.borrow_mut().push(stringify!($function));result}};}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostProfile {
    Promise,
    Effect,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Activity,
    Compensation,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Success,
    Malformed,
    Undefined,
}
enum Msg {
    Activity(Settled<WorkflowActivitySpec<PlainData>>),
    Compensation(Settled<WorkflowCompensationSpec<PlainData>>),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Activity(msg) => msg.tag(),
            Self::Compensation(msg) => msg.tag(),
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &[
        "workflow_activity_ok",
        "workflow_activity_err",
        "workflow_compensation_ok",
        "workflow_compensation_err",
    ];
}
impl Serialize for Msg {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Activity(msg) => msg.serialize(serializer),
            Self::Compensation(msg) => msg.serialize(serializer),
        }
    }
}
struct Cmd(WorkflowCmd<PlainData>);
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        self.0.tag()
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Option<Outcome<PlainData, WorkflowTransportFailure>>;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(message: &Msg) -> Option<&EngineStamp> {
        match message {
            Msg::Activity(msg) => msg.engine_stamp(),
            Msg::Compensation(msg) => msg.engine_stamp(),
        }
    }
    fn settle(
        self,
        completion: Self::Completion,
        at: f64,
    ) -> Result<Vec<Msg>, CommandContractError> {
        self.settle_in(completion, &CommandEdge::new(move || at))
    }
    fn settle_in(
        self,
        completion: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        match self.0 {
            WorkflowCmd::Activity(command) => Ok(command
                .settle_in(completion, edge)?
                .into_iter()
                .map(Msg::Activity)
                .collect()),
            WorkflowCmd::Compensation(command) => Ok(command
                .settle_in(completion, edge)?
                .into_iter()
                .map(Msg::Compensation)
                .collect()),
        }
    }
}
#[derive(Clone, Serialize)]
struct Model {
    messages: Vec<PlainData>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
#[derive(Clone)]
struct TraceStore {
    memory: MemoryStore<Model>,
    trace: Rc<RefCell<Vec<Value>>>,
}
impl Store<Model> for TraceStore {
    type Raw = Option<Model>;
    type Error = MemoryStoreError;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        self.memory.load().await
    }
    async fn save(&self, state: &Model) -> Result<(), Self::Error> {
        self.trace
            .borrow_mut()
            .push(json!({"kind":"save","state":snapshot(state)}));
        self.memory.save(state).await
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Model> {
        self.memory.migrate(raw)
    }
}
struct Host {
    profile: HostProfile,
    mode: Mode,
    trace: Rc<RefCell<Vec<Value>>>,
}
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Completion<WorkflowActivitySpec<PlainData>>, Infallible>> {
        Some(CommandWork::new(async move {
            self.trace
                .borrow_mut()
                .push(json!({"kind":"handler","command":snapshot(&command.0)}));
            Ok(match (self.profile, self.mode) {
                (HostProfile::Promise, Mode::Undefined) => None,
                (_, Mode::Malformed) => Some(Outcome::ok(PlainData::Null)),
                _ => Some(Outcome::ok(PlainData::Undefined)),
            })
        }))
    }
}
pub struct Input {
    pub profile: HostProfile,
    pub kind: Kind,
    pub mode: Mode,
    pub index: Number,
    pub id: Number,
    pub payload: Value,
    pub at: f64,
}
pub async fn execute(input: Input, calls: &Calls) -> Value {
    let Input {
        profile,
        kind,
        mode,
        index,
        id,
        payload,
        at,
    } = input;
    let slot = match data(&payload) {
        PlainData::Undefined => WorkflowValue::Undefined,
        value => WorkflowValue::Value(Rc::new(value)),
    };
    let command = match kind {
        Kind::Activity => {
            let definition = observe!(calls, workflow::workflow_activity_def);
            Cmd(WorkflowCmd::Activity(observe!(
                calls,
                demlik_tea::command::CmdDef::from_record,
                &definition,
                WorkflowActivityInput {
                    index: index.value().into(),
                    id: id.value().into(),
                    activity: slot
                }
            )))
        }
        Kind::Compensation => {
            let definition = observe!(calls, workflow::workflow_compensation_def);
            Cmd(WorkflowCmd::Compensation(observe!(
                calls,
                demlik_tea::command::CmdDef::from_record,
                &definition,
                WorkflowCompensationInput {
                    index: index.value().into(),
                    id: id.value().into(),
                    compensation: slot
                }
            )))
        }
    };
    let Cmd(command) = command;
    let machine: Machine<'static, Model, Msg, Cmd, Sub> = Machine {
        init: Box::new(move |_, _| {
            Step::new(
                Model { messages: vec![] },
                vec![Cmd(match &command {
                    WorkflowCmd::Activity(command) => {
                        let input = command.input();
                        WorkflowCmd::Activity(command.definition().from_record(
                            WorkflowActivityInput {
                                index: input.index,
                                id: input.id,
                                activity: input.activity.clone(),
                            },
                        ))
                    }
                    WorkflowCmd::Compensation(command) => {
                        let input = command.input();
                        WorkflowCmd::Compensation(command.definition().from_record(
                            WorkflowCompensationInput {
                                index: input.index,
                                id: input.id,
                                compensation: input.compensation.clone(),
                            },
                        ))
                    }
                })],
            )
        }),
        update: Update::reducer(|model: &Model, msg: &Msg| {
            let mut messages = model.messages.clone();
            messages.push(demlik_tea::data::plain_data(msg).unwrap());
            Step::new(Model { messages }, vec![])
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let trace = Rc::new(RefCell::new(vec![]));
    let store = TraceStore {
        memory: memory_store(None),
        trace: Rc::clone(&trace),
    };
    let mut options: Options<Model, Msg, MemoryStoreError, Infallible> =
        Options::new(match profile {
            HostProfile::Promise => Profile::Promise,
            HostProfile::Effect => Profile::Effect,
        });
    options.clock = Rc::new(move || at);
    options.store = Some(Persistence::new(store.clone()));
    let commits = Rc::clone(&trace);
    options.on_commit.push(Rc::new(move |msg, state| {
        commits
            .borrow_mut()
            .push(json!({"kind":"commit","msg":msg.map(snapshot),"state":snapshot(state)}))
    }));
    let runtime = observe!(
        calls,
        runtime::launch,
        machine,
        (),
        Host {
            profile,
            mode,
            trace: Rc::clone(&trace)
        },
        NoSubscriptions::new(),
        options
    );
    observe_async!(calls, Runtime::ready, &runtime).unwrap();
    observe_async!(calls, Runtime::idle, &runtime).unwrap();
    let state = observe!(calls, Runtime::get_state, &runtime).unwrap();
    let saved = observe_async!(calls, Store::load, &store).unwrap();
    let result = json!([{"state":snapshot(state.as_ref()),"saved":saved.as_ref().map(snapshot),"trace":*trace.borrow()}]);
    observe_async!(calls, Runtime::stop, &runtime);
    result
}
