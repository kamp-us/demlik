use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    command::{CommandContractError, CommandEdge, CommandFamily, EngineStamp, Settlement},
    core::Message,
    data::{JsText, plain_data, stringify_json},
    describe_error::{ErrorView, describe_error},
    llm_call::{self as llm, Config, LlmCall, Request, Schema},
    resilience::{
        deadline::DeadlineExceeded,
        resilient_call::{CallPhase, CallValue},
    },
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    time::Duration,
};
#[path = "../../../parity/src/paginate_queue/wire.rs"]
pub mod wire;
pub type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));result}};}
macro_rules! observe_async{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let result=$function($($arg),*).await;$calls.borrow_mut().push(stringify!($function));result}};}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Success,
    Failure,
    Retry,
}
struct Parser;
impl Schema for Parser {
    type Raw = PlainData;
    type Output = PlainData;
    type Error = PlainData;
    fn parse(&self, raw: PlainData) -> Result<PlainData, CallValue<PlainData>> {
        Ok(raw)
    }
}
type Knob = LlmCall<'static, JsText, PlainData, Parser>;
type InnerCmd = llm::RunCmd<JsText, PlainData, PlainData, PlainData>;
type Settled = llm::LlmMsg<JsText, PlainData, PlainData, PlainData>;
enum Msg {
    Settled(Settled),
    Timer(DeadlineExceeded),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Settled(m) => m.tag(),
            Self::Timer(m) => m.tag(),
        }
    }
}
impl Message for Msg {
    const TYPES: &'static [&'static str] =
        &["resilient_run_ok", "resilient_run_err", "deadline_exceeded"];
}
struct Cmd(InnerCmd);
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        self.0.tag()
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Option<llm::LlmOutcome<JsText, PlainData, PlainData>>;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Settled(msg) => msg.engine_stamp(),
            Msg::Timer(_) => None,
        }
    }
    fn settle(self, value: Self::Completion, at: f64) -> Result<Vec<Msg>, CommandContractError> {
        self.settle_in(value, &CommandEdge::new(move || at))
    }
    fn settle_in(
        self,
        value: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Msg>, CommandContractError> {
        Ok(self
            .0
            .settle_in(value, edge)?
            .into_iter()
            .map(Msg::Settled)
            .collect())
    }
}
struct Model {
    call: llm::State<JsText, PlainData, PlainData, PlainData>,
    rows: Rc<Vec<Value>>,
    wire_strings: Rc<Vec<String>>,
    done: bool,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
struct Host {
    llm: Rc<Knob>,
    mode: Mode,
    count: Rc<Cell<usize>>,
    calls: Calls,
}
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, SelfCompletion, Infallible>> {
        Some(CommandWork::new(async move {
            let n = self.count.get();
            self.count.set(n + 1);
            let fail =
                matches!(self.mode, Mode::Failure) || matches!(self.mode, Mode::Retry) && n == 0;
            Ok(Some(if fail {
                observe!(
                    &self.calls,
                    LlmCall::rejected,
                    &self.llm,
                    CallValue::value(PlainData::String("provider error".into()))
                )
            } else {
                observe!(
                    &self.calls,
                    LlmCall::decode,
                    &self.llm,
                    &command.0,
                    wire::data(&json!("parsed"))
                )
                .unwrap()
            }))
        }))
    }
}
type SelfCompletion = Option<llm::LlmOutcome<JsText, PlainData, PlainData>>;
pub async fn run(profile: Profile, mode: Mode, at: wire::Number) -> Value {
    let at = at.value();
    let calls = Calls::default();
    let mut config = Config::new(|_| Rc::new(Parser));
    if matches!(mode, Mode::Retry) {
        config.retry = Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 1.0,
                factor: 2.0,
                cap_ms: 4.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 2.0 },
        });
    }
    let knob: Rc<Knob> = Rc::new(
        observe!(&calls, LlmCall::new, config, |error: &PlainData| {
            describe_error(ErrorView::Value(error))
        })
        .with_rng(|| 0.5),
    );
    let init = knob.clone();
    let update = knob.clone();
    let initialized = calls.clone();
    let updated = calls.clone();
    let machine: Machine<'static, Model, Msg, Cmd, Sub<PlainData>> = Machine {
        init: Box::new(move |_, _| {
            let initial = observe!(&initialized, LlmCall::init, &init);
            let step = observe!(
                &initialized,
                LlmCall::attempt,
                &init,
                &initial,
                Rc::new(Request::new(
                    JsText::from("plan"),
                    None,
                    PlainData::String("prompt".into())
                )),
                0.0
            )
            .unwrap();
            Step::new(
                Model {
                    call: step.state,
                    rows: Rc::new(vec![]),
                    wire_strings: Rc::new(vec![]),
                    done: false,
                },
                step.commands.into_iter().map(Cmd).collect(),
            )
        }),
        update: Update::reducer(move |model: &Model, msg: &Msg| {
            let mut rows = (*model.rows).clone();
            let mut wire_strings = (*model.wire_strings).clone();
            let step = match msg {
                Msg::Timer(timer) => {
                    rows.push(json!({"kind":"timer","msg":wire::snapshot(timer)}));
                    observe!(&updated, LlmCall::on_timer, &update, &model.call, timer).unwrap()
                }
                Msg::Settled(original) => {
                    assert!(original.engine_stamp().is_some());
                    // This application explicitly persists and decodes each message.
                    // The generic machine and its opaque peers gain no codec bound.
                    let encoded = stringify_json(&plain_data(original).unwrap()).unwrap();
                    wire_strings.push(encoded.clone());
                    let restored: Settled = serde_json::from_str(&encoded).unwrap();
                    assert!(restored.engine_stamp().is_none());
                    let stamp = observe!(&updated, demlik_tea::command::Settled::at, &restored)
                        .expect("null remains a present stamp");
                    let original_stamp =
                        observe!(&updated, demlik_tea::command::Settled::at, original).unwrap();
                    let number = observe!(
                        &updated,
                        demlik_tea::data::NumberOrNull::number,
                        original_stamp
                    )
                    .unwrap();
                    rows.push(json!({"kind":"settlement","original":wire::number(number),"wire":wire::normalized(&demlik_tea::data::decode_json(&encoded).unwrap()),"restored":wire::snapshot(&stamp)}));
                    match restored.outcome() {
                        Settlement::Ok(_) => {
                            observe!(&updated, LlmCall::succeed, &update, &model.call, &restored)
                                .unwrap()
                        }
                        Settlement::Err(_) => {
                            observe!(&updated, LlmCall::fail, &update, &model.call, &restored)
                                .unwrap()
                        }
                    }
                }
            };
            let done = matches!(
                step.state.call("plan"),
                Some(CallPhase::Succeeded { .. } | CallPhase::Failed { .. })
            );
            rows.push(json!({"kind":"state","clock":wire::snapshot(&step.state.snapshot().clock_ms),"state":wire::snapshot(&step.state)}));
            Step::new(
                Model {
                    call: step.state,
                    rows: Rc::new(rows),
                    wire_strings: Rc::new(wire_strings),
                    done,
                },
                step.commands.into_iter().map(Cmd).collect(),
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_: &Model| vec![]),
    };
    let count = Rc::new(Cell::new(0));
    let mut options: Options<Model, Msg, Infallible, Infallible> = Options::new(profile);
    options.clock = Rc::new(move || at);
    options.terminal = Some(Rc::new(|model: &Model| model.done));
    let runtime = observe!(
        &calls,
        runtime::launch,
        machine,
        (),
        Host {
            llm: knob.clone(),
            mode,
            count: count.clone(),
            calls: calls.clone()
        },
        NoSubscriptions::new(),
        options
    );
    observe_async!(&calls, runtime::Runtime::ready, &runtime).unwrap();
    observe_async!(&calls, runtime::Runtime::idle, &runtime).unwrap();
    let mut declared = Value::Null;
    if matches!(mode, Mode::Retry) {
        let state = observe!(&calls, runtime::Runtime::get_state, &runtime).unwrap();
        let timer = observe!(&calls, LlmCall::timer, &knob, &state.call).unwrap();
        declared = wire::snapshot(&timer);
        observe_async!(
            &calls,
            runtime::Runtime::dispatch,
            &runtime,
            Msg::Timer(timer.msg)
        )
        .unwrap();
    }
    let final_state = tokio::time::timeout(Duration::from_secs(2), async {
        observe_async!(&calls, runtime::Runtime::done, &runtime)
    })
    .await
    .unwrap()
    .unwrap();
    let result = json!({"rows":final_state.rows.as_ref(),"declaredTimer":declared,"providerCalls":count.get(),"done":final_state.done});
    observe_async!(&calls, runtime::Runtime::stop, &runtime);
    json!({"value":result,"calls":calls.borrow().as_slice(),"wireStrings":final_state.wire_strings.as_ref()})
}
