use super::scenario::{
    self as app, Answer, Calls, Cause, Client, Context, Knob, Loader, Message, Parser, Payload,
    Script, Style,
};
use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    agent::model::{BrainPorts, Messages, ModelFactory},
    command::{CommandContractError, CommandEdge, CommandFamily, EngineStamp, Settlement},
    core::Message as TeaMessage,
    data::JsText,
    llm_call::{self, LlmCall, LlmCallError, LlmCause, Request},
    resilience::resilient_call::{CallPhase, CallValue},
    runtime::{self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile},
};
use std::{cell::RefCell, convert::Infallible, rc::Rc, time::Duration};
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let value=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));value}};}
macro_rules! observe_async {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let value=$function($($arg),*).await;$calls.borrow_mut().push(stringify!($function));value}};}
type Inner = app::Command;
enum Msg {
    Settled(llm_call::LlmMsg<JsText, Payload, Rc<Answer>, Cause>),
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Settled(msg) => msg.tag(),
        }
    }
}
impl TeaMessage for Msg {
    const TYPES: &'static [&'static str] = &["resilient_run_ok", "resilient_run_err"];
}
struct Cmd(Inner);
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        self.0.tag()
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Option<llm_call::LlmOutcome<JsText, Rc<Answer>, Cause>>;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(msg: &Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Settled(msg) => msg.engine_stamp(),
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
    call: llm_call::State<JsText, Payload, Rc<Answer>, Cause>,
    context: Rc<Context>,
    settled: Option<PlainData>,
    done: bool,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
struct Host<F> {
    llm: Rc<Knob>,
    model: F,
    loader: Loader,
    context: Rc<Context>,
    calls: Calls,
}
impl<F: ModelFactory<Message, Parser>> Interpreter<Cmd> for Host<F> {
    type Error = LlmCallError;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        _: CommandContext<Msg, LlmCallError>,
    ) -> Option<CommandWork<'a, <Cmd as CommandFamily>::Completion, LlmCallError>> {
        Some(CommandWork::new(async move {
            let outcome = if self.context.script.no_loader {
                let handler = observe!(
                    &self.calls,
                    demlik_tea::agent::model::brain_handler,
                    self.llm.as_ref(),
                    BrainPorts::new(&self.model)
                );
                observe_async!(
                    &self.calls,
                    demlik_tea::agent::model::BrainHandler::handle,
                    &handler,
                    &cmd.0
                )?
            } else {
                let ports = observe!(
                    &self.calls,
                    demlik_tea::agent::model::BrainPorts::with_loader,
                    BrainPorts::new(&self.model),
                    &self.loader
                );
                let handler = observe!(
                    &self.calls,
                    demlik_tea::agent::model::brain_handler,
                    self.llm.as_ref(),
                    ports
                );
                observe_async!(
                    &self.calls,
                    demlik_tea::agent::model::BrainHandler::handle,
                    &handler,
                    &cmd.0
                )?
            };
            Ok(Some(outcome))
        }))
    }
}
fn machine(
    llm: Rc<Knob>,
    ctx: Rc<Context>,
    calls: Calls,
) -> Machine<'static, Model, Msg, Cmd, Sub<()>> {
    let init_llm = Rc::clone(&llm);
    let init_ctx = Rc::clone(&ctx);
    let init_calls = Rc::clone(&calls);
    let mut row: demlik_tea::core::Row<'static, Model, Msg, Cmd> = Default::default();
    for tag in ["resilient_run_ok", "resilient_run_err"] {
        let llm = Rc::clone(&llm);
        let calls = Rc::clone(&calls);
        row.insert(
            tag.into(),
            Box::new(move |state: &Model, message: &Msg| {
                let Msg::Settled(msg) = message;
                let at = msg.at().unwrap();
                let ctx = &state.context;
                let (step, settled) = match msg.outcome() {
                    Settlement::Ok(CallValue::Shared(ok)) => {
                        let step =
                            observe!(&calls, LlmCall::succeed, llm.as_ref(), &state.call, msg)
                                .unwrap();
                        (
                            step,
                            app::object([
                                ("tag", app::string(msg.tag())),
                                ("key", app::string(ok.key.clone())),
                                ("purpose", app::string(ok.purpose.clone())),
                                ("output", app::answer(&ok.output)),
                                ("sameRaw", PlainData::Bool(Rc::ptr_eq(&ok.output, &ctx.raw))),
                                (
                                    "sameToken",
                                    PlainData::Bool(Rc::ptr_eq(&ok.output.token, &ctx.token)),
                                ),
                                ("at", at.number().map_or(PlainData::Null, PlainData::Number)),
                            ]),
                        )
                    }
                    Settlement::Err(_) => {
                        let error = observe!(&calls, LlmCall::err_of, llm.as_ref(), msg).unwrap();
                        let same = match &error.error {
                            LlmCause::Value(cause) => {
                                Rc::ptr_eq(cause, &ctx.cause) && Rc::ptr_eq(&cause.0, &ctx.cause.0)
                            }
                            LlmCause::Undefined => ctx.script.undefined_cause,
                            _ => false,
                        };
                        let step = observe!(&calls, LlmCall::fail, llm.as_ref(), &state.call, msg)
                            .unwrap();
                        (
                            step,
                            app::object([
                                ("tag", app::string(msg.tag())),
                                ("key", app::string(error.key)),
                                ("purpose", app::string(error.purpose)),
                                ("reason", app::string(error.reason)),
                                ("sameCause", PlainData::Bool(same)),
                                ("at", at.number().map_or(PlainData::Null, PlainData::Number)),
                            ]),
                        )
                    }
                    _ => panic!("typed completion"),
                };
                Step::new(
                    Model {
                        call: step.state,
                        context: Rc::clone(ctx),
                        settled: Some(settled),
                        done: true,
                    },
                    step.commands.into_iter().map(Cmd).collect(),
                )
            }),
        );
    }
    Machine {
        init: Box::new(move |_, _| {
            let input = Rc::new(Request::new(
                init_ctx.script.purpose.clone(),
                init_ctx.script.model.clone(),
                Payload(Rc::clone(&init_ctx.token)),
            ));
            *init_ctx.expected_request.borrow_mut() = Rc::downgrade(&input);
            let step = observe!(
                &init_calls,
                LlmCall::attempt_keyed,
                init_llm.as_ref(),
                &init_llm.init(),
                init_ctx
                    .script
                    .key
                    .clone()
                    .unwrap_or_else(|| init_ctx.script.purpose.clone()),
                input,
                0.0
            )
            .unwrap();
            Step::new(
                Model {
                    call: step.state,
                    context: Rc::clone(&init_ctx),
                    settled: None,
                    done: false,
                },
                step.commands.into_iter().map(Cmd).collect(),
            )
        }),
        update: Update::raw_reducer(row),
        subscriptions: demlik_tea::core::subscriptions(|_: &Model| vec![]),
    }
}
async fn run_port<F: ModelFactory<Message, Parser> + 'static>(
    ctx: Rc<Context>,
    llm: Rc<Knob>,
    model: F,
    profile: Profile,
    calls: Calls,
) -> PlainData {
    let errors = Rc::new(RefCell::new(Vec::new()));
    let errors_sink = Rc::clone(&errors);
    let mut options: Options<Model, Msg, Infallible, LlmCallError> = Options::new(profile);
    options.clock = Rc::new(|| 100.25);
    options.terminal = Some(Rc::new(|model: &Model| model.done));
    options.on_error = Some(Rc::new(move |_, phase| {
        errors_sink.borrow_mut().push(format!("{:?}", phase))
    }));
    let runtime = observe!(
        &calls,
        runtime::launch,
        machine(Rc::clone(&llm), Rc::clone(&ctx), Rc::clone(&calls)),
        (),
        Host {
            llm,
            model,
            loader: Loader(Rc::clone(&ctx)),
            context: Rc::clone(&ctx),
            calls: Rc::clone(&calls)
        },
        NoSubscriptions::new(),
        options
    );
    observe_async!(&calls, runtime::Runtime::ready, &runtime).unwrap();
    let state = tokio::time::timeout(Duration::from_secs(2), async {
        observe_async!(&calls, runtime::Runtime::done, &runtime)
    })
    .await
    .unwrap()
    .unwrap();
    let key = ctx
        .script
        .key
        .clone()
        .unwrap_or_else(|| ctx.script.purpose.clone());
    let phase = state
        .call
        .call(key)
        .map(|call| match call {
            CallPhase::Succeeded { .. } => "succeeded",
            CallPhase::Failed { .. } => "failed",
            _ => "other",
        })
        .unwrap();
    let result = app::object([
        ("ports", app::snapshot(&ctx, vec![])),
        ("settled", state.settled.clone().unwrap()),
        ("phase", app::string(phase)),
        (
            "contextSame",
            PlainData::Bool(Rc::ptr_eq(&state.context, &ctx)),
        ),
        ("done", PlainData::Bool(state.done)),
        (
            "errors",
            PlainData::Array(
                errors
                    .borrow()
                    .iter()
                    .map(|x| app::string(x.clone()))
                    .collect(),
            ),
        ),
    ]);
    observe_async!(&calls, runtime::Runtime::stop, &runtime);
    result
}
pub async fn run(script: Script, profile: Profile, calls: &Calls) -> PlainData {
    let ctx = Context::new(script);
    let llm = app::knob(&ctx);
    let client = Rc::new(Client(Rc::clone(&ctx)));
    *ctx.model.borrow_mut() = Rc::downgrade(&client);
    let state = Rc::clone(&ctx);
    match ctx.script.style {
        Style::Factory => {
            let model = observe!(
                calls,
                demlik_tea::agent::model::model_factory,
                move |id: Option<&JsText>| {
                    state.record("factory");
                    state.factory_ids.borrow_mut().push(id.cloned());
                    if state.script.failure == Some(app::FailureAt::Factory) {
                        Err(state.fail())
                    } else {
                        Ok(Rc::clone(&client))
                    }
                }
            );
            run_port(ctx, llm, model, profile, Rc::clone(calls)).await
        }
        Style::Plain => {
            let model = observe!(
                calls,
                demlik_tea::agent::model::plain_model,
                async move |messages: Messages<'_, Message>| state.invoke(messages, true)
            );
            run_port(ctx, llm, model, profile, Rc::clone(calls)).await
        }
        Style::Wrapped => {
            let model = observe!(
                calls,
                demlik_tea::agent::model::plain_model,
                move |messages: Messages<'_, Message>| std::future::ready(
                    state.invoke(messages, true)
                )
            );
            run_port(ctx, llm, model, profile, Rc::clone(calls)).await
        }
    }
}
