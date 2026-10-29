//! The single-stage Agent entry point, using the existing reducer and runtime.

use super::{
    AgentConfig, AgentMachineError, AgentMachineMsg, AgentPrompt, AgentWired, AgentWorkError,
    PlainCalls, PlainToolCall, StateOf, StructuredOutputError,
    content::Parts,
    create_agent,
    model::{Llm, MessageLoader, Messages, ModelFactory},
    prompt::{AgentMessage, render_prompt_with},
    tool::{AgentToolRoutes, ToolError},
    types::{AGENT_TURN_SCHEMA, Conversation, ToolOutcome},
};
use crate::{
    Machine, PlainData,
    command::CommandFamily,
    data::JsText,
    llm_call::{self, LlmCall, Request, Schema},
    resilience::{deadline::DeadlinesSub, resilient_call::CallValue},
    runtime::{self, DriveError, Interpreter, Options, Persistence, Profile, Subscriptions},
    storage::Store,
    timing::Timer,
};
use futures::{FutureExt, future::LocalBoxFuture};
use serde::{Serialize, Serializer, ser::SerializeMap};
use std::{convert::Infallible, fmt, marker::PhantomData, panic::AssertUnwindSafe, rc::Rc};

#[cfg(not(target_arch = "wasm32"))]
use super::types::AgentField;
#[cfg(not(target_arch = "wasm32"))]
use crate::{
    flow::monitored_run::RunPhase,
    runtime::{DriveOptions, DriveStart},
    timing::TokioTimer,
};
#[cfg(not(target_arch = "wasm32"))]
use std::future::Future;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolErrorContext {
    pub call_id: JsText,
    pub name: JsText,
}
pub struct DefinedToolFailure<E> {
    pub context: ToolErrorContext,
    pub outcome: Rc<E>,
}
#[doc(hidden)]
pub fn rejected_tool_failure(
    command: &crate::command::Cmd<super::tool::RejectedSpec>,
    completion: &crate::command::Completion<super::tool::RejectedSpec>,
) -> Result<
    Option<(
        ToolErrorContext,
        super::tool::FailureOf<super::tool::RejectedSpec>,
    )>,
    ToolError,
> {
    let Some(crate::command::Outcome::Err { error }) = completion else {
        return Ok(None);
    };
    let input = command.input();
    let name = match &input.error {
        super::tool::ToolRejection::UnknownTool { name }
        | super::tool::ToolRejection::MalformedArgs { name, .. } => name.clone(),
    };
    Ok(Some((
        ToolErrorContext {
            call_id: input.call_id.clone(),
            name,
        },
        super::tool::rejected_error(&crate::command::Failure::Declared(error.clone()))?,
    )))
}
type ToolErrorHook<R> = Rc<
    dyn for<'a> Fn(
        &'a DefinedToolFailure<<R as DefinedAgentTools>::Error>,
    ) -> LocalBoxFuture<'a, ()>,
>;

pub trait DefinedAgentTools: Sized + 'static {
    type Host: 'static;
    type Result: 'static;
    type Error: 'static;
    type ContentError: 'static;
    type Command: CommandFamily<Msg: crate::Tagged + 'static, Completion: 'static> + 'static;
    type Bound: AgentToolRoutes<Self::Command, Self::Result, Self::Error>
        + Interpreter<Self::Command, DefinedAgentMsg<Self>, Error = AgentWorkError<ToolError>>
        + 'static;

    fn route(&self, call: &Rc<PlainToolCall>) -> Result<Self::Command, ToolError>;
    fn parts(
        &self,
        call: &PlainToolCall,
        outcome: &ToolOutcome<Self::Result, Self::Error>,
    ) -> Result<Option<Parts>, Self::ContentError>;
    fn bind(self: Rc<Self>, host: Rc<Self::Host>) -> Self::Bound;
    fn failure(
        &self,
        command: &Self::Command,
        completion: &<Self::Command as CommandFamily>::Completion,
    ) -> Result<Option<DefinedToolFailure<Self::Error>>, ToolError>;
}

/// No provider failures are declared by an existing caller.
/// Unlike the standard library's Infallible, this empty type supports wire consumers.
#[derive(Serialize)]
pub enum NoProviderError {}

pub enum DefinedAgentModelError<E, P = NoProviderError> {
    /// A model adapter failure, retained independently of parser and content failures.
    Provider(P),
    Guard(Rc<StructuredOutputError>),
    Content(E),
}
impl<E, P> DefinedAgentModelError<E, P> {
    fn describe(
        &self,
        provider: &ProviderDescription<P>,
    ) -> Result<JsText, crate::js_record::JsAccessError> {
        match self {
            Self::Provider(error) => provider(error),
            Self::Guard(error) => error.describe(),
            Self::Content(_) => Ok("tool content callback failed".into()),
        }
    }
}
impl<E, P: Serialize> Serialize for DefinedAgentModelError<E, P> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Provider(error) => error.serialize(serializer),
            Self::Guard(error) => error.serialize(serializer),
            Self::Content(_) => serializer.serialize_map(Some(0))?.end(),
        }
    }
}
pub struct DefinedTurnSchema<E, P = NoProviderError>(PhantomData<fn() -> (E, P)>);
impl<E, P> Schema for DefinedTurnSchema<E, P> {
    type Raw = Rc<PlainData>;
    type Output = Rc<PlainData>;
    type Error = DefinedAgentModelError<E, P>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        AGENT_TURN_SCHEMA.parse(raw).map_err(|cause| match cause {
            CallValue::Shared(error) => CallValue::value(DefinedAgentModelError::Guard(error)),
            CallValue::Undefined => CallValue::Undefined,
            CallValue::Missing => CallValue::Missing,
        })
    }
}
pub type DefinedConversation<R> = Conversation<
    <R as DefinedAgentTools>::Result,
    PlainData,
    <R as DefinedAgentTools>::Error,
    PlainData,
    PlainCalls,
>;
pub struct DefinedPrompt<R: DefinedAgentTools> {
    pub instructions: Option<JsText>,
    pub input: Option<JsText>,
    pub conversation: Rc<DefinedConversation<R>>,
}
impl<R: DefinedAgentTools> Serialize for DefinedPrompt<R>
where
    R::Result: Serialize,
    R::Error: Serialize,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("instructions", &self.instructions)?;
        map.serialize_entry("input", &self.input)?;
        map.serialize_entry("conversation", &self.conversation)?;
        map.end()
    }
}
pub type DefinedAgentState<R, P = NoProviderError> = StateOf<
    JsText,
    JsText,
    Rc<DefinedPrompt<R>>,
    DefinedTurnSchema<<R as DefinedAgentTools>::ContentError, P>,
    <R as DefinedAgentTools>::Result,
    <R as DefinedAgentTools>::Error,
    PlainData,
    PlainData,
    PlainCalls,
>;
pub type DefinedAgentMsg<R, P = NoProviderError> = AgentMachineMsg<
    JsText,
    Rc<DefinedPrompt<R>>,
    Rc<PlainData>,
    DefinedAgentModelError<<R as DefinedAgentTools>::ContentError, P>,
    <<R as DefinedAgentTools>::Command as CommandFamily>::Msg,
>;
pub type DefinedAgentCommand<R, P = NoProviderError> = super::AgentCommand<
    JsText,
    Rc<DefinedPrompt<R>>,
    Rc<PlainData>,
    DefinedAgentModelError<<R as DefinedAgentTools>::ContentError, P>,
    <R as DefinedAgentTools>::Command,
>;
pub type DefinedAgentMessage<R> = AgentMessage<
    <R as DefinedAgentTools>::Result,
    PlainData,
    <R as DefinedAgentTools>::Error,
    PlainData,
    PlainCalls,
>;
pub type DefinedAgentMachine<R, P = NoProviderError> = Machine<
    'static,
    Rc<DefinedAgentState<R, P>>,
    DefinedAgentMsg<R, P>,
    DefinedAgentCommand<R, P>,
    DeadlinesSub,
    (),
    AgentMachineError,
>;
pub type DefinedAgentEvent<R, P = NoProviderError> = super::types::AgentEvent<
    <R as DefinedAgentTools>::Result,
    PlainData,
    super::types::AgentTerminalFailure<
        JsText,
        PlainData,
        crate::llm_call::LlmErr<
            JsText,
            DefinedAgentModelError<<R as DefinedAgentTools>::ContentError, P>,
        >,
    >,
    DefinedPrompt<R>,
    super::PlainToolArgs,
    <R as DefinedAgentTools>::Error,
>;
pub type DefinedAgentRunError<R, SE, P = NoProviderError> =
    DriveError<Rc<DefinedAgentState<R, P>>, SE, AgentWorkError<ToolError>, AgentMachineError>;
pub type DefinedAgentResult<R, SE, P = NoProviderError> =
    Result<Rc<DefinedAgentState<R, P>>, DefinedAgentRunError<R, SE, P>>;
type StopPredicate<R, P> = Rc<dyn Fn(&Rc<DefinedAgentState<R, P>>) -> bool>;
type EventSink<R, P> = Rc<dyn Fn(&DefinedAgentEvent<R, P>)>;
#[cfg(not(target_arch = "wasm32"))]
fn new_run_id() -> JsText {
    let mut bytes = [0_u8; 16];
    if let Err(error) = getrandom::fill(&mut bytes) {
        std::panic::panic_any(error);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
    .into()
}

type ProviderDescription<P> = dyn Fn(&P) -> Result<JsText, crate::js_record::JsAccessError>;

pub struct DefineAgentConfig<F, R: DefinedAgentTools, P = NoProviderError> {
    model: Rc<F>,
    tools: Rc<R>,
    instructions: JsText,
    on_tool_error: Option<ToolErrorHook<R>>,
    max_turns: Option<f64>,
    max_elapsed_ms: Option<f64>,
    stop_when: Option<StopPredicate<R, P>>,
    describe_provider_error: Rc<ProviderDescription<P>>,
}
impl<F, R: DefinedAgentTools, P> DefineAgentConfig<F, R, P> {
    pub fn new(model: F, tools: Rc<R>, instructions: impl Into<JsText>) -> Self {
        Self {
            model: Rc::new(model),
            tools,
            instructions: instructions.into(),
            on_tool_error: None,
            max_turns: None,
            max_elapsed_ms: None,
            stop_when: None,
            describe_provider_error: Rc::new(|_| Ok("model provider failed".into())),
        }
    }
    /// Renders a provider failure's reason without imposing traits on its owned payload.
    /// The default native reason is `model provider failed`.
    pub fn describe_provider_error(
        mut self,
        describe: impl Fn(&P) -> Result<JsText, crate::js_record::JsAccessError> + 'static,
    ) -> Self {
        self.describe_provider_error = Rc::new(describe);
        self
    }
    /// Bounds completed model round-trips at the existing reducer turn boundary.
    pub fn max_turns(mut self, value: f64) -> Self {
        self.max_turns = Some(value);
        self
    }
    /// Bounds elapsed time from the durable run's original start.
    pub fn max_elapsed_ms(mut self, value: f64) -> Self {
        self.max_elapsed_ms = Some(value);
        self
    }
    /// A pure predicate that cancels at a turn boundary after quantity guards pass.
    /// A resumed run uses the predicate supplied to this boot.
    pub fn stop_when(
        mut self,
        predicate: impl Fn(&Rc<DefinedAgentState<R, P>>) -> bool + 'static,
    ) -> Self {
        self.stop_when = Some(Rc::new(predicate));
        self
    }
    pub fn on_tool_error(
        mut self,
        hook: impl for<'a> Fn(&'a DefinedToolFailure<R::Error>) -> LocalBoxFuture<'a, ()> + 'static,
    ) -> Self {
        self.on_tool_error = Some(Rc::new(hook));
        self
    }
}
pub struct DefinedAgent<F, R: DefinedAgentTools, P = NoProviderError> {
    config: DefineAgentConfig<F, R, P>,
}
pub fn define_agent<F, R: DefinedAgentTools, P>(
    config: DefineAgentConfig<F, R, P>,
) -> DefinedAgent<F, R, P> {
    DefinedAgent { config }
}
struct SharedModel<F>(Rc<F>);
impl<M, S: Schema, F: ModelFactory<M, S>> ModelFactory<M, S> for SharedModel<F> {
    fn model_of(&self, id: Option<&JsText>) -> Result<impl Llm<M, S>, CallValue<S::Error>> {
        self.0.model_of(id)
    }
    fn kind(&self) -> super::model::ModelKind {
        self.0.kind()
    }
}
struct PromptLoader<R>(Rc<R>);
impl<R: DefinedAgentTools, P>
    MessageLoader<
        JsText,
        Rc<DefinedPrompt<R>>,
        DefinedAgentMessage<R>,
        DefinedAgentModelError<R::ContentError, P>,
    > for PromptLoader<R>
{
    async fn load<'a>(
        &'a self,
        call: &'a Rc<Request<JsText, Rc<DefinedPrompt<R>>>>,
    ) -> Result<
        Messages<'a, DefinedAgentMessage<R>>,
        CallValue<DefinedAgentModelError<R::ContentError, P>>,
    >
    where
        DefinedAgentMessage<R>: 'a,
    {
        let payload = &call.payload;
        let prompt = AgentPrompt {
            instructions: payload.instructions.as_ref(),
            input: payload.input.as_ref(),
            conversation: &payload.conversation,
        };
        render_prompt_with(&prompt, |call, outcome| self.0.parts(call, outcome))
            .map(Messages::Shared)
            .map_err(|error| CallValue::value(DefinedAgentModelError::Content(error)))
    }
}
struct HookedTools<R: DefinedAgentTools> {
    tools: Rc<R::Bound>,
    router: Rc<R>,
    hook: Option<ToolErrorHook<R>>,
}
impl<R: DefinedAgentTools> AgentToolRoutes<R::Command, R::Result, R::Error> for HookedTools<R> {
    fn settlement_types(&self) -> Vec<String> {
        self.tools.settlement_types()
    }
    fn outcome_of(
        &self,
        message: &<R::Command as CommandFamily>::Msg,
    ) -> Result<
        Option<super::tool::ToolSettlement<R::Result, R::Error>>,
        crate::command::CommandContractError,
    > {
        self.tools.outcome_of(message)
    }
    fn at(
        &self,
        message: &<R::Command as CommandFamily>::Msg,
    ) -> Option<crate::data::NumberOrNull> {
        self.tools.at(message)
    }
}
impl<R: DefinedAgentTools, P> Interpreter<R::Command, DefinedAgentMsg<R, P>> for HookedTools<R>
where
    R::Bound: Interpreter<R::Command, DefinedAgentMsg<R, P>, Error = AgentWorkError<ToolError>>,
{
    type Error = AgentWorkError<ToolError>;
    fn interpret<'a>(
        &'a self,
        command: &'a R::Command,
        context: runtime::CommandContext<DefinedAgentMsg<R, P>, Self::Error>,
    ) -> Option<runtime::CommandWork<'a, <R::Command as CommandFamily>::Completion, Self::Error>>
    {
        let work = self.tools.interpret(command, context)?;
        let Some(hook) = &self.hook else {
            return Some(work);
        };
        Some(work.and_then(move |completion| async move {
            let Some(failure) = self
                .router
                .failure(command, &completion)
                .map_err(AgentWorkError::Tool)?
            else {
                return Ok(completion);
            };
            if let Err(payload) = AssertUnwindSafe(async { hook(&failure).await })
                .catch_unwind()
                .await
            {
                eprintln!(
                    "demlik: on_tool_error hook panicked: {}",
                    crate::storage::PanicCause::new(payload).summary
                );
            }
            Ok(completion)
        }))
    }
}

pub struct DefinedAgentRunOptions<R: DefinedAgentTools, SE = Infallible, P = NoProviderError> {
    pub host: Rc<R::Host>,
    pub store: Option<Persistence<Rc<DefinedAgentState<R, P>>, SE>>,
    pub run_id: Option<JsText>,
    pub clock: Rc<dyn Fn() -> f64>,
    pub on_event: Option<EventSink<R, P>>,
}
impl<R: DefinedAgentTools, P> DefinedAgentRunOptions<R, Infallible, P> {
    pub fn new(host: Rc<R::Host>) -> Self {
        Self {
            host,
            store: None,
            run_id: None,
            clock: Options::<(), ()>::new(Profile::Promise).clock,
            on_event: None,
        }
    }
}
impl<R: DefinedAgentTools, SE, P: 'static> DefinedAgentRunOptions<R, SE, P> {
    pub fn run_id(mut self, id: impl Into<JsText>) -> Self {
        self.run_id = Some(id.into());
        self
    }
    pub fn clock(mut self, clock: impl Fn() -> f64 + 'static) -> Self {
        self.clock = Rc::new(clock);
        self
    }
    pub fn on_event(mut self, handler: impl Fn(&DefinedAgentEvent<R, P>) + 'static) -> Self {
        self.on_event = Some(Rc::new(handler));
        self
    }
    pub fn store<
        E: fmt::Display + 'static,
        ST: Store<Rc<DefinedAgentState<R, P>>, Error = E> + 'static,
    >(
        self,
        store: ST,
    ) -> DefinedAgentRunOptions<R, E, P> {
        DefinedAgentRunOptions {
            host: self.host,
            store: Some(Persistence::new(store)),
            run_id: self.run_id,
            clock: self.clock,
            on_event: self.on_event,
        }
    }
}
impl<F: 'static, R: DefinedAgentTools, P: 'static> DefinedAgent<F, R, P>
where
    F: ModelFactory<DefinedAgentMessage<R>, DefinedTurnSchema<R::ContentError, P>>,
    R::Bound: Interpreter<R::Command, DefinedAgentMsg<R, P>, Error = AgentWorkError<ToolError>>,
{
    #[expect(
        clippy::type_complexity,
        reason = "The advanced interface returns the existing machine and its independently typed host handlers."
    )]
    pub fn machine<TM: Timer + 'static>(
        &self,
        input: JsText,
        host: Rc<R::Host>,
        timer: Rc<TM>,
    ) -> AgentWired<
        DefinedAgentMachine<R, P>,
        impl Interpreter<DefinedAgentCommand<R, P>, Error = AgentWorkError<ToolError>>
        + use<F, R, P, TM>,
        impl Subscriptions<DeadlinesSub, DefinedAgentMsg<R, P>, Error = AgentWorkError<ToolError>>
        + use<F, R, P, TM>,
    > {
        self.wire(
            input,
            Rc::new(Rc::clone(&self.config.tools).bind(host)),
            timer,
        )
    }
    #[expect(
        clippy::type_complexity,
        reason = "One wire is shared by the public machine and run interfaces without erasing their handlers."
    )]
    fn wire<TM: Timer + 'static>(
        &self,
        input: JsText,
        bound: Rc<R::Bound>,
        timer: Rc<TM>,
    ) -> AgentWired<
        DefinedAgentMachine<R, P>,
        impl Interpreter<DefinedAgentCommand<R, P>, Error = AgentWorkError<ToolError>>
        + use<F, R, P, TM>,
        impl Subscriptions<DeadlinesSub, DefinedAgentMsg<R, P>, Error = AgentWorkError<ToolError>>
        + use<F, R, P, TM>,
    > {
        let tools = Rc::clone(&self.config.tools);
        let describe = Rc::clone(&self.config.describe_provider_error);
        let llm = Rc::new(LlmCall::new(
            llm_call::Config::new(|_: &JsText| Rc::new(DefinedTurnSchema(PhantomData))),
            move |error: &DefinedAgentModelError<R::ContentError, P>| {
                error.describe(describe.as_ref())
            },
        ));
        let mut config = AgentConfig::try_from_plain_turns(
            llm,
            vec![Rc::new(input)],
            |_| JsText::from("act"),
            move |call| tools.route(call).map_err(Rc::new),
            |stage, conversation, instructions| {
                Rc::new(DefinedPrompt {
                    instructions: instructions.cloned(),
                    input: stage.map(|value| value.as_ref().clone()),
                    conversation: Rc::clone(conversation),
                })
            },
        )
        .instructions(self.config.instructions.clone());
        if let Some(limit) = self.config.max_turns {
            config = config.max_turns(limit);
        }
        if let Some(limit) = self.config.max_elapsed_ms {
            config = config.max_elapsed_ms(limit);
        }
        if let Some(predicate) = self.config.stop_when.clone() {
            config = config.stop_when(move |state| predicate(state));
        }
        let agent = Rc::new(create_agent(config));
        let tools = HookedTools {
            tools: bound,
            router: Rc::clone(&self.config.tools),
            hook: self.config.on_tool_error.clone(),
        };
        agent.to_machine_with_tools(
            SharedModel(Rc::clone(&self.config.model)),
            PromptLoader(Rc::clone(&self.config.tools)),
            tools,
            timer,
        )
    }
    /// Native-only Promise-profile drive on the current Tokio LocalSet.
    /// Wasm hosts drive the portable `machine` with their own callbacks.
    /// Dropping the returned waiter leaves the owned drive running to teardown.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn run<SE: fmt::Debug + fmt::Display + 'static, I: Into<JsText>>(
        &self,
        input: I,
        options: DefinedAgentRunOptions<R, SE, P>,
    ) -> impl Future<Output = DefinedAgentResult<R, SE, P>> + 'static + use<F, R, P, SE, I> {
        let clock = Rc::clone(&options.clock);
        let projector = options
            .on_event
            .as_ref()
            .map(|_| super::plain_agent_events());
        let event_tools = Rc::new(Rc::clone(&self.config.tools).bind(options.host));
        let timer_clock = Rc::clone(&clock);
        let wired = self.wire(
            input.into(),
            Rc::clone(&event_tools),
            Rc::new(TokioTimer::with_clock(move || timer_clock(), |_| {})),
        );
        let mut runtime_options = Options::new(Profile::Promise);
        runtime_options.clock = Rc::clone(&clock);
        runtime_options.store = options.store;
        runtime_options.terminal = Some(Rc::new(|s: &Rc<DefinedAgentState<R, P>>| s.is_settled()));
        let runtime_options = runtime_options.with_checked_events(move |message, state| {
            let Some(projector) = &projector else {
                return Ok(Vec::<DefinedAgentEvent<R, P>>::new());
            };
            projector
                .project_routed::<_, _, _, _, _, _, _, _, _, _, _, R::Command, _>(
                    message,
                    state,
                    event_tools.as_ref(),
                )
                .map_err(AgentMachineError::from)
        });
        let runtime = runtime::try_launch(
            wired.machine,
            (),
            wired.interpret,
            wired.subscribe,
            runtime_options,
        );
        let listeners: Vec<_> = options
            .on_event
            .into_iter()
            .flat_map(|handler| {
                super::types::AGENT_EVENT_TYPES
                    .into_iter()
                    .map(move |kind| (kind, Rc::clone(&handler)))
            })
            .map(|(kind, handler)| runtime.on(kind, handler))
            .collect();
        let run_id = options.run_id;
        let start = DriveStart::select(move |state: &Rc<DefinedAgentState<R, P>>| {
            let at = clock();
            if matches!(
                state.run.phase,
                RunPhase::Running { .. } | RunPhase::Stale { .. }
            ) {
                AgentMachineMsg::Boot { at }
            } else {
                AgentMachineMsg::Start {
                    run_id: run_id.unwrap_or_else(new_run_id),
                    at,
                }
            }
        });
        let drive = DriveOptions {
            failed: Some(Rc::new(|state: &Rc<DefinedAgentState<R, P>>| {
                matches!(state.run.phase, RunPhase::Failed { .. })
                    || !matches!(state.failure, AgentField::Value(None))
            })),
            cancellation: None,
        };
        let task = runtime::drive_to_done(&runtime, start, |state| state.is_settled(), drive);
        async move {
            let answer = task.await.map(|state| Rc::clone(&state));
            for detach in listeners {
                detach();
            }
            answer
        }
    }
}
