//! Base agent wiring. Pure declarations and host handlers remain separate.
use super::{Agent, AgentCommand, AgentError, CommandOf, SharedStateOf};
use crate::{
    Machine, PlainData, Step, Tagged, TryUpdate,
    agent::model::{BrainPorts, MessageLoader, ModelFactory, brain_handler},
    command::{
        CommandContractError, CommandEdge, CommandFamily, Completion, EngineStamp, Settlement,
    },
    core::{Message, SubEntry, SubscriptionEntries},
    data::{JsText, NumberOrNull},
    llm_call::{LlmCall, LlmCallError, LlmMsg, Purpose, RunSpec, Schema},
    resilience::{
        deadline::{self, DeadlineExceeded, DeadlinesSub},
        resilient_call::RunError,
    },
    runtime::{
        CommandContext, CommandWork, Interpreter, Producer, SubscriptionWork, Subscriptions,
    },
    timing::{Timer, TimerError},
};
use futures::FutureExt;
use std::{fmt, marker::PhantomData, rc::Rc};

pub enum AgentToolMsg<R> {
    Ok {
        call_id: JsText,
        result: Rc<R>,
        at: f64,
    },
    Err {
        call_id: JsText,
        reason: JsText,
        at: f64,
    },
}
impl<R> Tagged for AgentToolMsg<R> {
    fn tag(&self) -> &str {
        match self {
            Self::Ok { .. } => "agent_tool_ok",
            Self::Err { .. } => "agent_tool_err",
        }
    }
}
/// Brain retains the actual Settled; no separately cached phase, time or payload.
/// Tool wraps the independent tool follow-up family, avoiding recursive associated types.
pub enum AgentMachineMsg<P, I, O, E, TM> {
    Start { run_id: JsText, at: f64 },
    Tool(TM),
    Brain(LlmMsg<P, I, O, E>),
    Deadline(DeadlineExceeded),
    Boot { at: f64 },
    Cancel { at: f64 },
}
pub fn agent_boot_msg<P, I, O, E, TM>(at: f64) -> AgentMachineMsg<P, I, O, E, TM> {
    AgentMachineMsg::Boot { at }
}
pub fn agent_cancel_msg<P, I, O, E, TM>(at: f64) -> AgentMachineMsg<P, I, O, E, TM> {
    AgentMachineMsg::Cancel { at }
}
impl<P, I, O, E, TM: Tagged> Tagged for AgentMachineMsg<P, I, O, E, TM> {
    fn tag(&self) -> &str {
        match self {
            Self::Start { .. } => "agent_start",
            Self::Tool(m) => m.tag(),
            Self::Brain(m) => m.tag(),
            Self::Deadline(m) => m.tag(),
            Self::Boot { .. } => "agent_boot",
            Self::Cancel { .. } => "agent_cancel",
        }
    }
}
impl<P, I, O, E, R> Message for AgentMachineMsg<P, I, O, E, AgentToolMsg<R>> {
    const TYPES: &'static [&'static str] = &[
        "agent_start",
        "agent_tool_ok",
        "agent_tool_err",
        "resilient_run_ok",
        "resilient_run_err",
        "deadline_exceeded",
        "agent_boot",
        "agent_cancel",
    ];
}
pub enum AgentCompletion<B, T> {
    Brain(B),
    Tool(T),
}

fn classify_brain<E>(error: &RunError<E>) -> Result<PlainData, CommandContractError> {
    Ok(PlainData::Object(
        [("_tag".into(), PlainData::String(error.tag().into()))]
            .into_iter()
            .collect(),
    ))
}
impl<P, I, O, E, C: CommandFamily> CommandFamily for AgentCommand<P, I, O, E, C>
where
    C::Msg: Tagged,
{
    type Msg = AgentMachineMsg<P, I, O, E, C::Msg>;
    type Completion = AgentCompletion<Completion<RunSpec<P, I, O, E>>, C::Completion>;
    fn is_defined(&self) -> bool {
        match self {
            Self::Brain(_) => true,
            Self::Tool(c) => c.is_defined(),
        }
    }
    fn engine_stamp(message: &Self::Msg) -> Option<&EngineStamp> {
        match message {
            AgentMachineMsg::Brain(m) => m.engine_stamp(),
            AgentMachineMsg::Tool(m) => C::engine_stamp(m),
            _ => None,
        }
    }
    fn settle(
        self,
        completion: Self::Completion,
        at: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        match (self, completion) {
            (Self::Brain(c), AgentCompletion::Brain(v)) => Ok(c
                .with_error_classifier(classify_brain)
                .settle(v, at)?
                .into_iter()
                .map(AgentMachineMsg::Brain)
                .collect()),
            (Self::Tool(c), AgentCompletion::Tool(v)) => Ok(c
                .settle(v, at)?
                .into_iter()
                .map(AgentMachineMsg::Tool)
                .collect()),
            (c, _) => Err(CommandContractError::mismatched(
                c.tag(),
                "different agent command family",
            )),
        }
    }
    fn settle_in(
        self,
        completion: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        match (self, completion) {
            (Self::Brain(c), AgentCompletion::Brain(v)) => Ok(c
                .with_error_classifier(classify_brain)
                .settle_in(v, edge)?
                .into_iter()
                .map(AgentMachineMsg::Brain)
                .collect()),
            (Self::Tool(c), AgentCompletion::Tool(v)) => Ok(c
                .settle_in(v, edge)?
                .into_iter()
                .map(AgentMachineMsg::Tool)
                .collect()),
            (c, _) => Err(CommandContractError::mismatched(
                c.tag(),
                "different agent command family",
            )),
        }
    }
}

/// One host channel preserves an application-owned failure without formatting it.
pub enum AgentWorkError<H> {
    Brain(LlmCallError),
    Tool(H),
    Timer(TimerError),
}
impl<H> fmt::Debug for AgentWorkError<H> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Brain(e) => f.debug_tuple("Brain").field(e).finish(),
            Self::Tool(_) => f.write_str("Tool(..)"),
            Self::Timer(e) => f.debug_tuple("Timer").field(e).finish(),
        }
    }
}
#[derive(Debug)]
pub enum AgentMachineError {
    Agent(AgentError),
    /// Direct missing/null restored message stamps are an OPEN compatibility profile.
    /// Refuse observably rather than inventing a timestamp for existing numeric verbs.
    UnsupportedStamp {
        at: Option<NumberOrNull>,
    },
}
impl From<AgentError> for AgentMachineError {
    fn from(value: AgentError) -> Self {
        Self::Agent(value)
    }
}
pub struct AgentWired<M, I, S> {
    pub machine: M,
    pub interpret: I,
    pub subscribe: S,
}

type HostMsg<P, I, S, R> =
    AgentMachineMsg<P, I, <S as Schema>::Output, <S as Schema>::Error, AgentToolMsg<R>>;
type WiredMachine<'a, Stage, P, I, S, R, A, T, C> = Machine<
    'a,
    SharedStateOf<Stage, P, I, S, R, PlainData, A, T>,
    HostMsg<P, I, S, R>,
    CommandOf<P, I, S, C>,
    DeadlinesSub,
    (),
    AgentMachineError,
>;

struct AgentInterpreter<'a, P, I, S: Schema, F, L, TI, M, H> {
    llm: Rc<LlmCall<'a, P, I, S>>,
    model: F,
    loader: L,
    tools: TI,
    marker: PhantomData<fn() -> (M, H)>,
}
impl<P: Purpose, I, S: Schema, F, L, TI, M, H, C>
    Interpreter<AgentCommand<P, I, S::Output, S::Error, C>>
    for AgentInterpreter<'_, P, I, S, F, L, TI, M, H>
where
    C: CommandFamily,
    C::Msg: Tagged,
    F: ModelFactory<M, S>,
    L: MessageLoader<P, I, M, S::Error>,
    TI: Interpreter<
            C,
            AgentMachineMsg<P, I, S::Output, S::Error, C::Msg>,
            Error = AgentWorkError<H>,
        >,
{
    type Error = AgentWorkError<H>;
    fn interpret<'b>(
        &'b self,
        command: &'b AgentCommand<P, I, S::Output, S::Error, C>,
        context: CommandContext<AgentMachineMsg<P, I, S::Output, S::Error, C::Msg>, Self::Error>,
    ) -> Option<
        CommandWork<
            'b,
            <AgentCommand<P, I, S::Output, S::Error, C> as CommandFamily>::Completion,
            Self::Error,
        >,
    > {
        match command {
            AgentCommand::Brain(cmd) => Some(CommandWork::new(async move {
                let handler = brain_handler(
                    self.llm.as_ref(),
                    BrainPorts::new(&self.model).with_loader(&self.loader),
                );
                handler
                    .handle(cmd)
                    .await
                    .map(|v| AgentCompletion::Brain(Some(v)))
                    .map_err(AgentWorkError::Brain)
            })),
            AgentCommand::Tool(cmd) => {
                let work = self.tools.interpret(cmd, context)?;
                Some(CommandWork {
                    future: work
                        .future
                        .map(|r| r.map(AgentCompletion::Tool))
                        .boxed_local(),
                    cleanup: work.cleanup,
                    detached: work.detached,
                    uninterruptible: work.uninterruptible,
                })
            }
        }
    }
}
struct DeadlineRunner<T, H, M> {
    timer: Rc<T>,
    wrap: fn(DeadlineExceeded) -> M,
    marker: PhantomData<fn() -> H>,
}
impl<T: Timer + 'static, H: 'static, M: Tagged + 'static> Subscriptions<DeadlinesSub, M>
    for DeadlineRunner<T, H, M>
{
    type Error = AgentWorkError<H>;
    fn has_runner(&self, kind: &str) -> bool {
        kind == "deadline"
    }
    fn start(
        &self,
        sub: DeadlinesSub,
        producer: Producer<M>,
    ) -> Result<Option<SubscriptionWork<Self::Error>>, Self::Error> {
        let wrap = self.wrap;
        let running = deadline::subscribe_deadline(
            &sub,
            Rc::clone(&self.timer),
            Rc::new(move |msg| {
                let _ = producer.emit(wrap(msg));
            }),
        )
        .map_err(AgentWorkError::Timer)?;
        Ok(Some(SubscriptionWork::new(move || {
            let result = running.cancel().map_err(AgentWorkError::Timer);
            async move { result }
        })))
    }
}

impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>>, R, A, T, Provider, C>
    Agent<'a, Stage, P, I, S, R, PlainData, A, T, Provider, C>
where
    C: CommandFamily<Msg = AgentToolMsg<R>>,
{
    /// Owns the host ports beside a pure base-agent machine. Loaded init emits no
    /// commands: dispatch Boot explicitly after ready to resume. Runtime launch,
    /// rather than the pure agent, requires owned 'static services/state.
    pub fn to_machine<F, L, TI, M, H, TM>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        timer: Rc<TM>,
    ) -> AgentWired<
        WiredMachine<'a, Stage, P, I, S, R, A, T, C>,
        impl Interpreter<CommandOf<P, I, S, C>, Error = AgentWorkError<H>> + 'a,
        impl Subscriptions<DeadlinesSub, HostMsg<P, I, S, R>, Error = AgentWorkError<H>>,
    >
    where
        F: ModelFactory<M, S> + 'a,
        L: MessageLoader<P, I, M, S::Error> + 'a,
        TI: Interpreter<C, HostMsg<P, I, S, R>, Error = AgentWorkError<H>> + 'a,
        TM: Timer + 'static,
        H: 'static,
        M: 'a,
        HostMsg<P, I, S, R>: 'static,
        Stage: 'a,
        P: 'a,
        I: 'a,
        S: 'a,
        R: 'a,
        A: 'a,
        T: 'a,
        Provider: 'a,
        C: 'a,
    {
        let init = Rc::clone(&self);
        let reduce = Rc::clone(&self);
        let project = Rc::clone(&self);
        let machine = Machine {
            init: Box::new(move |loaded, _| {
                Step::new(loaded.unwrap_or_else(|| init.init()), vec![])
            }),
            update: TryUpdate::try_reducer(move |state, message| {
                let step = match message {
                    AgentMachineMsg::Start { run_id, at } => reduce.start(state, run_id, *at),
                    AgentMachineMsg::Tool(AgentToolMsg::Ok {
                        call_id,
                        result,
                        at,
                    }) => reduce.tool_ok(state, call_id, Rc::clone(result), *at),
                    AgentMachineMsg::Tool(AgentToolMsg::Err {
                        call_id,
                        reason,
                        at,
                    }) => reduce.tool_err_reason(state, call_id, reason, *at),
                    AgentMachineMsg::Brain(msg) => {
                        let at = msg
                            .at()
                            .and_then(NumberOrNull::number)
                            .ok_or(AgentMachineError::UnsupportedStamp { at: msg.at() })?;
                        match msg.outcome() {
                            Settlement::Ok(_) => reduce.succeed(state, msg, at),
                            Settlement::Err(_) => reduce.fail(state, msg, at),
                        }
                    }
                    AgentMachineMsg::Deadline(msg) => reduce.on_timer(state, msg),
                    AgentMachineMsg::Boot { at } => reduce.boot(state, *at),
                    AgentMachineMsg::Cancel { at } => reduce.cancel(state, *at),
                };
                step.map_err(AgentMachineError::Agent)
            }),
            subscriptions: Box::new(SubscriptionEntries::new(vec![SubEntry::try_new(
                "deadline",
                move |state: &SharedStateOf<Stage, P, I, S, R, PlainData, A, T>| {
                    project
                        .subs(state)
                        .map(|list| (!list.is_empty()).then_some(list))
                        .map_err(AgentMachineError::Agent)
                },
            )])),
        };
        AgentWired {
            machine,
            interpret: AgentInterpreter {
                llm: Rc::clone(&self.config.llm),
                model,
                loader,
                tools,
                marker: PhantomData,
            },
            subscribe: DeadlineRunner {
                timer,
                wrap: AgentMachineMsg::Deadline,
                marker: PhantomData,
            },
        }
    }
}
