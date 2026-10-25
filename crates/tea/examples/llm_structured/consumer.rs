use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    command::{CommandContractError, CommandEdge, CommandFamily, EngineStamp, Settlement},
    core::Message,
    data::JsText,
    describe_error::{ErrorView, describe_error},
    llm_call::{self as llm, Config, LlmCall, LlmCause, Request, Schema},
    resilience::resilient_call::{CallFailure, CallPhase, CallValue},
    runtime::{self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile},
};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    time::Duration,
};

pub type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));result}};}
macro_rules! observe_async{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*).await;$calls.borrow_mut().push(stringify!($function));result}};}
#[derive(Clone, Copy)]
enum Purpose {
    Plan,
    Report,
}
impl llm::Purpose for Purpose {
    fn key(&self) -> JsText {
        match self {
            Self::Plan => "plan".into(),
            Self::Report => "report".into(),
        }
    }
}
struct Context {
    token: Rc<()>,
    provider_calls: Cell<usize>,
}
enum Prompt {
    Plan(&'static str),
    Report(Rc<Plan>),
}
struct Plan {
    steps: Vec<&'static str>,
    token: Rc<()>,
}
struct Report {
    summary: String,
    plan: Rc<Plan>,
}
enum Output {
    Plan(Rc<Plan>),
    Report(Rc<Report>),
}
enum Raw {
    Plan,
    Report(Rc<Plan>),
    Wrong,
}
struct OpaqueCause {
    message: JsText,
    token: Rc<()>,
}
// This application-owned projection is an explicit command-wire boundary.
// The command still carries the original, non-Serialize cause beside its data.
struct ProjectedError {
    original: Rc<OpaqueCause>,
    projection: PlainData,
}
impl Serialize for ProjectedError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.projection.serialize(s)
    }
}
struct Parser {
    purpose: Purpose,
    cause: Rc<ProjectedError>,
}
impl Schema for Parser {
    type Raw = Raw;
    type Output = Output;
    type Error = ProjectedError;
    fn parse(&self, raw: Raw) -> Result<Output, CallValue<ProjectedError>> {
        match (self.purpose, raw) {
            (Purpose::Plan, Raw::Plan) => Ok(Output::Plan(Rc::new(Plan {
                steps: vec!["inspect", "explain"],
                token: Rc::new(()),
            }))),
            (Purpose::Report, Raw::Report(plan)) => Ok(Output::Report(Rc::new(Report {
                summary: format!("{} steps verified", plan.steps.len()),
                plan,
            }))),
            _ => Err(CallValue::shared(self.cause.clone())),
        }
    }
}
type Knob = LlmCall<'static, Purpose, Prompt, Parser>;
type CmdInner = llm::RunCmd<Purpose, Prompt, Output, ProjectedError>;
enum Msg {
    Settled(llm::LlmMsg<Purpose, Prompt, Output, ProjectedError>),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Settled(msg) => msg.tag(),
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] = &["resilient_run_ok", "resilient_run_err"];
}
struct Cmd(CmdInner);
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        self.0.tag()
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Option<llm::LlmOutcome<Purpose, Output, ProjectedError>>;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Settled(msg) => msg.engine_stamp(),
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
        Ok(self
            .0
            .settle_in(completion, edge)?
            .into_iter()
            .map(Msg::Settled)
            .collect())
    }
}
struct Model {
    call: llm::State<Purpose, Prompt, Output, ProjectedError>,
    context: Rc<Context>,
    events: Rc<Vec<Value>>,
    done: bool,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
struct Provider {
    knob: Rc<Knob>,
    mode: String,
    context: Rc<Context>,
    cause: Rc<ProjectedError>,
    calls: Calls,
}
impl Interpreter<Cmd> for Provider {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, SelfCompletion, Infallible>> {
        Some(CommandWork::new(async move {
            self.context
                .provider_calls
                .set(self.context.provider_calls.get() + 1);
            let CallValue::Shared(input) = &cmd.0.input().input else {
                panic!("typed request")
            };
            if self.mode == "provider" {
                return Ok(Some(observe!(
                    &self.calls,
                    LlmCall::rejected,
                    &self.knob,
                    CallValue::shared(self.cause.clone())
                )));
            }
            let raw = match &input.payload {
                Prompt::Plan(prompt) => {
                    assert_eq!(*prompt, "explain a local port");
                    if self.mode == "schema" {
                        Raw::Wrong
                    } else {
                        Raw::Plan
                    }
                }
                Prompt::Report(plan) => Raw::Report(plan.clone()),
            };
            Ok(Some(
                observe!(&self.calls, LlmCall::decode, &self.knob, &cmd.0, raw).unwrap(),
            ))
        }))
    }
}
type SelfCompletion = Option<llm::LlmOutcome<Purpose, Output, ProjectedError>>;

pub async fn run(profile: Profile, mode: &str) -> Value {
    let calls = Calls::default();
    let raw_cause = Rc::new(OpaqueCause {
        message: if mode == "schema" {
            "schema rejected"
        } else {
            "provider rejected"
        }
        .into(),
        token: Rc::new(()),
    });
    let cause = Rc::new(ProjectedError {
        original: raw_cause.clone(),
        projection: demlik_tea::data::decode_json(if mode == "schema" {
            "{\"code\":\"schema\"}"
        } else {
            "{\"code\":\"provider\"}"
        })
        .unwrap(),
    });
    let plan = Rc::new(Parser {
        purpose: Purpose::Plan,
        cause: cause.clone(),
    });
    let report = Rc::new(Parser {
        purpose: Purpose::Report,
        cause: cause.clone(),
    });
    let knob: Rc<Knob> = Rc::new(observe!(
        &calls,
        LlmCall::new,
        Config::new(move |purpose| match purpose {
            Purpose::Plan => plan.clone(),
            Purpose::Report => report.clone(),
        }),
        |error: &ProjectedError| describe_error(ErrorView::ErrorMessage(&error.original.message))
    ));
    let context = Rc::new(Context {
        token: Rc::new(()),
        provider_calls: Cell::new(0),
    });
    let initial = knob.clone();
    let updates = knob.clone();
    let initial_context = context.clone();
    let update_calls = calls.clone();
    let init_calls = calls.clone();
    let original = cause.clone();
    let machine: Machine<'static, Model, Msg, Cmd, Sub<PlainData>> = Machine {
        init: Box::new(move |loaded, _| {
            assert!(loaded.is_none());
            let call = observe!(&init_calls, LlmCall::init, &initial);
            let started = observe!(
                &init_calls,
                LlmCall::attempt,
                &initial,
                &call,
                Rc::new(Request::new(
                    Purpose::Plan,
                    None,
                    Prompt::Plan("explain a local port")
                )),
                100.0
            )
            .unwrap();
            Step::new(
                Model {
                    call: started.state,
                    context: initial_context.clone(),
                    events: Rc::new(vec![]),
                    done: false,
                },
                started.commands.into_iter().map(Cmd).collect(),
            )
        }),
        update: Update::reducer(move |model: &Model, Msg::Settled(msg): &Msg| {
            let mut events = (*model.events).clone();
            match msg.outcome() {
                Settlement::Ok(CallValue::Shared(value)) => {
                    let settled =
                        observe!(&update_calls, LlmCall::succeed, &updates, &model.call, msg)
                            .unwrap();
                    match &value.output {
                        Output::Plan(plan) => {
                            events.push(json!({"tag":"resilient_run_ok","purpose":"plan","key":"plan","steps":plan.steps,"token":Rc::strong_count(&plan.token)>0}));
                            let next = observe!(
                                &update_calls,
                                LlmCall::attempt,
                                &updates,
                                &settled.state,
                                Rc::new(Request::new(
                                    Purpose::Report,
                                    Some("local".into()),
                                    Prompt::Report(plan.clone())
                                )),
                                101.0
                            )
                            .unwrap();
                            Step::new(
                                Model {
                                    call: next.state,
                                    context: model.context.clone(),
                                    events: Rc::new(events),
                                    done: false,
                                },
                                next.commands.into_iter().map(Cmd).collect(),
                            )
                        }
                        Output::Report(report) => {
                            events.push(json!({"tag":"resilient_run_ok","purpose":"report","key":"report","summary":report.summary,"samePlan":matches!(model.call.call("plan"),Some(CallPhase::Succeeded{result:CallValue::Shared(value)})if matches!(&value.output,Output::Plan(plan)if Rc::ptr_eq(plan,&report.plan)))}));
                            Step::new(
                                Model {
                                    call: settled.state,
                                    context: model.context.clone(),
                                    events: Rc::new(events),
                                    done: true,
                                },
                                settled.commands.into_iter().map(Cmd).collect(),
                            )
                        }
                    }
                }
                Settlement::Err(_) => {
                    let error = observe!(&update_calls, LlmCall::err_of, &updates, msg).unwrap();
                    let same = matches!(&error.error,LlmCause::Value(value)if Rc::ptr_eq(value,&original)&&Rc::ptr_eq(&value.original,&original.original)&&Rc::ptr_eq(&value.original.token,&original.original.token));
                    events.push(json!({"tag":"resilient_run_err","purpose":"plan","key":"plan","reason":error.reason.as_utf8(),"sameCause":same}));
                    let failed =
                        observe!(&update_calls, LlmCall::fail, &updates, &model.call, msg).unwrap();
                    assert!(
                        matches!(failed.state.call("plan"),Some(CallPhase::Failed{error})if matches!(error.as_ref(),CallFailure::External(error)if matches!(&error.error,LlmCause::Value(value)if Rc::ptr_eq(&value.original,&original.original))))
                    );
                    Step::new(
                        Model {
                            call: failed.state,
                            context: model.context.clone(),
                            events: Rc::new(events),
                            done: true,
                        },
                        failed.commands.into_iter().map(Cmd).collect(),
                    )
                }
                _ => panic!("defined parsed success"),
            }
        }),
        subscriptions: demlik_tea::core::subscriptions(|_: &Model| vec![]),
    };
    let mut options: Options<Model, Msg, Infallible, Infallible> = Options::new(profile);
    options.clock = Rc::new(|| 100.0);
    options.terminal = Some(Rc::new(|state: &Model| state.done));
    let runtime = observe!(
        &calls,
        runtime::launch,
        machine,
        (),
        Provider {
            knob,
            mode: mode.into(),
            context: context.clone(),
            cause,
            calls: calls.clone()
        },
        NoSubscriptions::new(),
        options
    );
    observe_async!(&calls, runtime::Runtime::ready, &runtime).unwrap();
    let final_state = tokio::time::timeout(Duration::from_secs(2), async {
        observe_async!(&calls, runtime::Runtime::done, &runtime)
    })
    .await
    .unwrap()
    .unwrap();
    let result = json!({"events":final_state.events.as_ref(),"providerCalls":context.provider_calls.get(),"sameContext":Rc::ptr_eq(&final_state.context,&context)&&Rc::ptr_eq(&final_state.context.token,&context.token),"done":final_state.done});
    observe_async!(&calls, runtime::Runtime::stop, &runtime);
    json!({"value":result,"calls":calls.borrow().as_slice()})
}
