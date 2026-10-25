use demlik_tea::command::{
    CommandContractError, CommandEdge, CommandFamily, Completion, EngineStamp, Outcome, Settled,
    Settlement,
};
use demlik_tea::core::Message;
use demlik_tea::durable_effects::{EffectLedgerEvent, LedgerRestore, fold_ledger, is_owed};
use demlik_tea::flow::workflow::{
    self as workflow, ActivityOk, Workflow, WorkflowActivityInput, WorkflowActivitySpec,
    WorkflowCmd, WorkflowCompensationInput, WorkflowCompensationSpec, WorkflowMsg, WorkflowPhase,
    WorkflowState, WorkflowStep, WorkflowSteps,
};
use demlik_tea::runtime::{
    self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence, Profile,
};
use demlik_tea::storage::{MemoryStore, MemoryStoreError, Store, memory_store};
use demlik_tea::{Machine, PlainData, Step, Sub, Tagged, Update};
use std::{cell::RefCell, convert::Infallible, rc::Rc};

struct Activity {
    name: &'static str,
    _local: Rc<()>,
}
struct Answer(Box<u32>);
struct BusinessFailure;
type FlowState = WorkflowState<Activity, Answer, BusinessFailure>;
type Flow = Workflow<Activity, Answer, BusinessFailure>;
enum Msg {
    Business(WorkflowMsg<Answer, BusinessFailure>),
    Activity(Settled<WorkflowActivitySpec<Activity>>),
    Compensation(Settled<WorkflowCompensationSpec<Activity>>),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Business(message) => message.tag(),
            Self::Activity(message) => message.tag(),
            Self::Compensation(message) => message.tag(),
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &[
        "activity_ok",
        "activity_err",
        "compensation_ok",
        "compensation_err",
        "workflow_activity_ok",
        "workflow_activity_err",
        "workflow_compensation_ok",
        "workflow_compensation_err",
    ];
}
struct Cmd(Rc<WorkflowCmd<Activity>>);
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        self.0.tag()
    }
}
enum Completed {
    Activity(Completion<WorkflowActivitySpec<Activity>>),
    Compensation(Completion<WorkflowCompensationSpec<Activity>>),
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Completed;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(message: &Msg) -> Option<&EngineStamp> {
        match message {
            Msg::Activity(message) => message.engine_stamp(),
            Msg::Compensation(message) => message.engine_stamp(),
            Msg::Business(_) => None,
        }
    }
    fn settle(self, outcome: Completed, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        self.settle_in(outcome, &CommandEdge::new(move || at))
    }
    fn settle_in(
        self,
        outcome: Completed,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        // The event log retains the original command. Its local adapter copies
        // only Rc handles, so the effect, model and messages need no Clone bound.
        match (self.0.as_ref(), outcome) {
            (WorkflowCmd::Activity(command), Completed::Activity(outcome)) => {
                let input = command.input();
                let command = command.definition().from_record(WorkflowActivityInput {
                    index: input.index,
                    id: input.id,
                    activity: input.activity.clone(),
                });
                Ok(command
                    .settle_in(outcome, edge)?
                    .into_iter()
                    .map(Msg::Activity)
                    .collect())
            }
            (WorkflowCmd::Compensation(command), Completed::Compensation(outcome)) => {
                let input = command.input();
                let command = command.definition().from_record(WorkflowCompensationInput {
                    index: input.index,
                    id: input.id,
                    compensation: input.compensation.clone(),
                });
                Ok(command
                    .settle_in(outcome, edge)?
                    .into_iter()
                    .map(Msg::Compensation)
                    .collect())
            }
            (command, _) => Err(CommandContractError::mismatched(
                command.tag(),
                "wrong workflow completion",
            )),
        }
    }
}
#[derive(Clone)]
struct Model {
    flow: Rc<FlowState>,
    ledger: Rc<Vec<Rc<EffectLedgerEvent<WorkflowCmd<Activity>>>>>,
    acknowledgements: Rc<Vec<PlainData>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
fn machine() -> Machine<'static, Model, Msg, Cmd, Sub> {
    let owner: Rc<RefCell<Option<Flow>>> = Rc::new(RefCell::new(None));
    let init = Rc::clone(&owner);
    Machine {
        init: Box::new(move |loaded: Option<Model>, _| {
            let flow =
                workflow::create_workflow(loaded.as_ref().map_or_else(Default::default, |model| {
                    LedgerRestore::from_events(model.ledger.iter().cloned())
                }));
            let (model, commands) = match loaded {
                Some(model) => {
                    let commands = flow.surviving_activities(model.ledger.as_ref());
                    (model, commands)
                }
                None => {
                    let activity = |name| {
                        Rc::new(Activity {
                            name,
                            _local: Rc::new(()),
                        })
                    };
                    let steps = WorkflowSteps::new(
                        Rc::new(WorkflowStep::new("reserve", activity("reserve"))),
                        [Rc::new(WorkflowStep::new("charge", activity("charge")))],
                    );
                    let step = flow.init(&steps).unwrap();
                    (
                        Model {
                            flow: step.state,
                            ledger: Rc::new(step.ledger),
                            acknowledgements: Rc::new(vec![]),
                        },
                        step.cmds,
                    )
                }
            };
            *init.borrow_mut() = Some(flow);
            Step::new(model, commands.into_iter().map(Cmd).collect())
        }),
        update: Update::reducer(move |model: &Model, message: &Msg| match message {
            Msg::Business(message) => {
                let owner = owner.borrow();
                let step =
                    workflow::route_workflow_msg(owner.as_ref().unwrap(), &model.flow, message)
                        .unwrap();
                let mut ledger = model.ledger.as_ref().clone();
                ledger.extend(step.ledger);
                Step::new(
                    Model {
                        flow: step.state,
                        ledger: Rc::new(ledger),
                        acknowledgements: Rc::clone(&model.acknowledgements),
                    },
                    step.cmds.into_iter().map(Cmd).collect(),
                )
            }
            Msg::Activity(message) => {
                let mut acknowledgements = model.acknowledgements.as_ref().clone();
                acknowledgements.push(match message.outcome() {
                    Settlement::Ok(_) => PlainData::Undefined,
                    Settlement::Err(error) => demlik_tea::data::plain_data(error).unwrap(),
                });
                Step::new(
                    Model {
                        acknowledgements: Rc::new(acknowledgements),
                        ..model.clone()
                    },
                    vec![],
                )
            }
            Msg::Compensation(message) => {
                let mut acknowledgements = model.acknowledgements.as_ref().clone();
                acknowledgements.push(match message.outcome() {
                    Settlement::Ok(_) => PlainData::Undefined,
                    Settlement::Err(error) => demlik_tea::data::plain_data(error).unwrap(),
                });
                Step::new(
                    Model {
                        acknowledgements: Rc::new(acknowledgements),
                        ..model.clone()
                    },
                    vec![],
                )
            }
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
struct Host {
    store: MemoryStore<Model>,
    delivered: Rc<RefCell<Vec<(f64, &'static str)>>>,
    malformed_first: bool,
}
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Completed, Infallible>> {
        Some(CommandWork::new(async move {
            match command.0.as_ref() {
                WorkflowCmd::Activity(command) => {
                    let id = command.input().id;
                    let saved = self.store.load().await.unwrap().unwrap();
                    assert!(is_owed(&fold_ledger(saved.ledger.as_ref()), id));
                    assert_eq!(saved.flow.current().unwrap().id, id);
                    self.delivered.borrow_mut().push((
                        id.number().unwrap(),
                        command.input().activity.value().unwrap().name,
                    ));
                    Ok(Completed::Activity(Some(Outcome::ok(
                        if self.malformed_first && id.number() == Some(1.0) {
                            PlainData::Null
                        } else {
                            PlainData::Undefined
                        },
                    ))))
                }
                WorkflowCmd::Compensation(_) => Ok(Completed::Compensation(Some(Outcome::ok(
                    PlainData::Undefined,
                )))),
            }
        }))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn transport_acks_do_not_complete_business_work_and_relaunch_resumes_the_saved_delivery() {
    tokio::task::LocalSet::new().run_until(async{
        for profile in[Profile::Promise,Profile::Effect]{for malformed_first in[false,true]{
            let store=memory_store(None);let delivered=Rc::new(RefCell::new(vec![]));
            let options=||{let mut options:Options<Model,Msg,MemoryStoreError,Infallible>=Options::new(profile);options.store=Some(Persistence::new(store.clone()));options.clock=Rc::new(||17.25);options.terminal=Some(Rc::new(|model|matches!(model.flow.status,WorkflowPhase::Completed{..})));options};
            let host=||Host{store:store.clone(),delivered:Rc::clone(&delivered),malformed_first};
            let first=runtime::launch(machine(),(),host(),NoSubscriptions::new(),options());first.ready().await.unwrap();first.idle().await.unwrap();
            let state=first.get_state().unwrap();assert!(matches!(state.flow.status,WorkflowPhase::Running{..}));assert_eq!(state.ledger.len(),1);assert_eq!(state.acknowledgements.len(),1);
            if malformed_first{let PlainData::Object(error)=&state.acknowledgements[0]else{panic!("malformed transport result")};assert!(matches!(error.get("_tag"),Some(PlainData::String(tag))if tag.as_utf8()==Some("malformed_result")));}
            let first_answer=Rc::new(Answer(Box::new(7)));
            first.dispatch(Msg::Business(WorkflowMsg::ActivityOk(ActivityOk::new(1.0.into(),first_answer)))).await.unwrap();
            assert_eq!(first.get_state().unwrap().flow.current().unwrap().id.number(),Some(2.0));first.stop().await;
            let restored=runtime::launch(machine(),(),host(),NoSubscriptions::new(),options());restored.ready().await.unwrap();restored.idle().await.unwrap();
            assert_eq!(&*delivered.borrow(),&vec![(1.0,"reserve"),(2.0,"charge"),(2.0,"charge")]);
            let result=Rc::new(Answer(Box::new(9)));restored.dispatch(Msg::Business(WorkflowMsg::ActivityOk(ActivityOk::new(2.0.into(),Rc::clone(&result))))).await.unwrap();
            let done=restored.done().await.unwrap();let WorkflowPhase::Completed{output}=&done.flow.status else{panic!("business completion")};assert!(Rc::ptr_eq(output.value().unwrap(),&result));assert_eq!(*output.value().unwrap().0,9);
            assert_eq!(done.ledger.iter().map(|event|event.tag()).collect::<Vec<_>>(),vec!["effect_owed","effect_confirmed","effect_owed","effect_confirmed"]);
            let saved=store.load().await.unwrap().unwrap();assert!(matches!(saved.flow.status,WorkflowPhase::Completed{..}));assert!(fold_ledger(saved.ledger.as_ref()).is_empty());
            restored.stop().await;
        }}
    }).await;
}
