//! Base agent wiring. Pure declarations and host handlers remain separate.
use super::{Agent, AgentCommand, AgentError, CommandOf, SharedStateOf};
use crate::agent::compaction::{
    CompactMessage, CompactionProfile, NoCompactCommand, NoCompactMessage, NoCompaction,
    WithCompaction,
};
use crate::agent::snapshot::{
    AgentSnapshotMessages, AgentSnapshotWrite, NoSnapshotCommand, NoSnapshotMessage,
    SnapshotProfile, WithSnapshot,
};
use crate::agent::tool::{AgentToolRoutes, ToolError};
use crate::agent::turn_view::{CallSource, NativeCalls};
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
pub enum AgentMachineMsg<P, I, O, E, TM, CM = NoCompactMessage> {
    Start { run_id: JsText, at: f64 },
    Tool(TM),
    Brain(LlmMsg<P, I, O, E>),
    Compact(CM),
    Deadline(DeadlineExceeded),
    Boot { at: f64 },
    Cancel { at: f64 },
}
impl<P, I, O, E, TM, CM> AgentMachineMsg<P, I, O, E, TM, CM> {
    pub fn boot(at: f64) -> Self {
        Self::Boot { at }
    }
    pub fn cancel(at: f64) -> Self {
        Self::Cancel { at }
    }
}
pub fn agent_boot_msg<P, I, O, E, TM>(at: f64) -> AgentMachineMsg<P, I, O, E, TM> {
    AgentMachineMsg::boot(at)
}
pub fn agent_cancel_msg<P, I, O, E, TM>(at: f64) -> AgentMachineMsg<P, I, O, E, TM> {
    AgentMachineMsg::cancel(at)
}
impl<P, I, O, E, TM: Tagged, CM: Tagged> Tagged for AgentMachineMsg<P, I, O, E, TM, CM> {
    fn tag(&self) -> &str {
        match self {
            Self::Start { .. } => "agent_start",
            Self::Tool(m) => m.tag(),
            Self::Brain(m) => m.tag(),
            Self::Compact(m) => m.tag(),
            Self::Deadline(m) => m.tag(),
            Self::Boot { .. } => "agent_boot",
            Self::Cancel { .. } => "agent_cancel",
        }
    }
}
impl<P, I, O, E, R, CM: Tagged> Message for AgentMachineMsg<P, I, O, E, AgentToolMsg<R>, CM> {
    const TYPES: &'static [&'static str] = &[
        "agent_start",
        "agent_tool_ok",
        "agent_tool_err",
        "resilient_run_ok",
        "resilient_run_err",
        "deadline_exceeded",
        "agent_boot",
        "agent_cancel",
        "compact_ok",
        "compact_err",
    ];
}
impl<P, I, O, E, TM, CM> From<NoSnapshotMessage> for AgentMachineMsg<P, I, O, E, TM, CM> {
    fn from(message: NoSnapshotMessage) -> Self {
        match message {}
    }
}

pub enum AgentCompletion<B, T, CC = NoCompactMessage, SC = NoSnapshotMessage> {
    Brain(B),
    Tool(T),
    Compact(CC),
    Snapshot(SC),
}

fn classify_brain<E>(error: &RunError<E>) -> Result<PlainData, CommandContractError> {
    Ok(PlainData::Object(
        [("_tag".into(), PlainData::String(error.tag().into()))]
            .into_iter()
            .collect(),
    ))
}
impl<P, I, O, E, C: CommandFamily, CC: CommandFamily, SC: CommandFamily> CommandFamily
    for AgentCommand<P, I, O, E, C, CC, SC>
where
    C::Msg: Tagged,
    CC::Msg: Tagged,
    SC::Msg: Into<AgentMachineMsg<P, I, O, E, C::Msg, CC::Msg>>,
{
    type Msg = AgentMachineMsg<P, I, O, E, C::Msg, CC::Msg>;
    type Completion = AgentCompletion<
        Completion<RunSpec<P, I, O, E>>,
        C::Completion,
        CC::Completion,
        SC::Completion,
    >;
    fn is_defined(&self) -> bool {
        match self {
            Self::Brain(_) => true,
            Self::Tool(c) => c.is_defined(),
            Self::Compact(c) => c.is_defined(),
            Self::Snapshot(c) => c.is_defined(),
        }
    }
    fn engine_stamp(message: &Self::Msg) -> Option<&EngineStamp> {
        match message {
            AgentMachineMsg::Brain(m) => m.engine_stamp(),
            AgentMachineMsg::Tool(m) => C::engine_stamp(m),
            AgentMachineMsg::Compact(m) => CC::engine_stamp(m),
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
            (Self::Compact(c), AgentCompletion::Compact(v)) => Ok(c
                .settle(v, at)?
                .into_iter()
                .map(AgentMachineMsg::Compact)
                .collect()),
            (Self::Snapshot(c), AgentCompletion::Snapshot(v)) => {
                Ok(c.settle(v, at)?.into_iter().map(Into::into).collect())
            }
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
            (Self::Compact(c), AgentCompletion::Compact(v)) => Ok(c
                .settle_in(v, edge)?
                .into_iter()
                .map(AgentMachineMsg::Compact)
                .collect()),
            (Self::Snapshot(c), AgentCompletion::Snapshot(v)) => {
                Ok(c.settle_in(v, edge)?.into_iter().map(Into::into).collect())
            }
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
    ToolContract(CommandContractError),
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

type ToolHostMsg<P, I, S, TM, K = NoCompaction> = AgentMachineMsg<
    P,
    I,
    <S as Schema>::Output,
    <S as Schema>::Error,
    TM,
    <<K as CompactionProfile>::Command as CommandFamily>::Msg,
>;
type HostMsg<P, I, S, R, K = NoCompaction> = ToolHostMsg<P, I, S, AgentToolMsg<R>, K>;
type WiredCommand<P, I, S, C, K, SC> = AgentCommand<
    P,
    I,
    <S as Schema>::Output,
    <S as Schema>::Error,
    C,
    <K as CompactionProfile>::Command,
    SC,
>;
type WiredMachine<
    'a,
    Stage,
    P,
    I,
    S,
    R,
    A,
    T,
    C,
    V = NativeCalls,
    K = NoCompaction,
    SC = NoSnapshotCommand,
    TE = PlainData,
> = Machine<
    'a,
    SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
    ToolHostMsg<P, I, S, <C as CommandFamily>::Msg, K>,
    WiredCommand<P, I, S, C, K, SC>,
    DeadlinesSub,
    (),
    AgentMachineError,
>;

type ToolFoldResult<Stage, P, I, S, R, TE, A, T, C, V, K, Q> =
    Result<super::StepOf<Stage, P, I, S, R, TE, A, T, C, V, K, Q>, AgentMachineError>;

struct AgentInterpreter<'a, P, I, S: Schema, F, L, TI, CI, SI, M, H> {
    llm: Rc<LlmCall<'a, P, I, S>>,
    model: F,
    loader: L,
    tools: Rc<TI>,
    compact: CI,
    snapshot: SI,
    marker: PhantomData<fn() -> (M, H)>,
}
impl<P: Purpose, I, S: Schema, F, L, TI, CI, SI, M, H, C, CC, SC>
    Interpreter<AgentCommand<P, I, S::Output, S::Error, C, CC, SC>>
    for AgentInterpreter<'_, P, I, S, F, L, TI, CI, SI, M, H>
where
    C: CommandFamily,
    C::Msg: Tagged,
    CC: CommandFamily,
    CC::Msg: Tagged,
    SC: CommandFamily,
    SC::Msg: Into<AgentMachineMsg<P, I, S::Output, S::Error, C::Msg, CC::Msg>>,
    F: ModelFactory<M, S>,
    L: MessageLoader<P, I, M, S::Error>,
    TI: Interpreter<
            C,
            AgentMachineMsg<P, I, S::Output, S::Error, C::Msg, CC::Msg>,
            Error = AgentWorkError<H>,
        >,
    CI: Interpreter<
            CC,
            AgentMachineMsg<P, I, S::Output, S::Error, C::Msg, CC::Msg>,
            Error = AgentWorkError<H>,
        >,
    SI: Interpreter<
            SC,
            AgentMachineMsg<P, I, S::Output, S::Error, C::Msg, CC::Msg>,
            Error = AgentWorkError<H>,
        >,
{
    type Error = AgentWorkError<H>;
    fn interpret<'b>(
        &'b self,
        command: &'b AgentCommand<P, I, S::Output, S::Error, C, CC, SC>,
        context: CommandContext<
            AgentMachineMsg<P, I, S::Output, S::Error, C::Msg, CC::Msg>,
            Self::Error,
        >,
    ) -> Option<
        CommandWork<
            'b,
            <AgentCommand<P, I, S::Output, S::Error, C, CC, SC> as CommandFamily>::Completion,
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
            AgentCommand::Compact(cmd) => {
                let work = self.compact.interpret(cmd, context)?;
                Some(CommandWork {
                    future: work
                        .future
                        .map(|r| r.map(AgentCompletion::Compact))
                        .boxed_local(),
                    cleanup: work.cleanup,
                    detached: work.detached,
                    uninterruptible: work.uninterruptible,
                })
            }
            AgentCommand::Snapshot(cmd) => {
                let work = self.snapshot.interpret(cmd, context)?;
                Some(CommandWork {
                    future: work
                        .future
                        .map(|r| r.map(AgentCompletion::Snapshot))
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

impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>>,
    R,
    TE,
    A,
    T,
    Provider,
    C,
    V: CallSource<A>,
    K: CompactionProfile,
    Q: SnapshotProfile,
> Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, K, Q>
where
    C: CommandFamily,
    C::Msg: Tagged,
    <K::Command as CommandFamily>::Msg: Tagged,
{
    /// Owns the host ports beside a pure base-agent machine. Loaded init emits no
    /// commands: dispatch Boot explicitly after ready to resume. Model/loader/
    /// schema services and state-only data may borrow locally. The owned timer
    /// callback already requires the message family and host-error channel to
    /// be 'static; actor launch additionally requires the whole machine/state
    /// and handlers to be 'static. The pure agent verbs retain their wider
    /// borrowed payload/cause interface.
    #[expect(
        clippy::type_complexity,
        clippy::too_many_arguments,
        reason = "The one wire retains independent host services and its tool fold/metadata without another runtime."
    )]
    fn wire<F, L, TI, CI, SI, SC, M, H, TM, TF>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        compact: CI,
        snapshot: SI,
        timer: Rc<TM>,
        routed_types: Vec<String>,
        fold_tool: TF,
    ) -> AgentWired<
        WiredMachine<'a, Stage, P, I, S, R, A, T, C, V, K, SC, TE>,
        impl Interpreter<WiredCommand<P, I, S, C, K, SC>, Error = AgentWorkError<H>> + 'a,
        impl Subscriptions<DeadlinesSub, ToolHostMsg<P, I, S, C::Msg, K>, Error = AgentWorkError<H>>,
    >
    where
        TF: Fn(
                &Self,
                &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
                &C::Msg,
                &TI,
            ) -> ToolFoldResult<Stage, P, I, S, R, TE, A, T, C, V, K, Q>
            + 'a,
        F: ModelFactory<M, S> + 'a,
        L: MessageLoader<P, I, M, S::Error> + 'a,
        TI: Interpreter<C, ToolHostMsg<P, I, S, C::Msg, K>, Error = AgentWorkError<H>> + 'a,
        CI: Interpreter<K::Command, ToolHostMsg<P, I, S, C::Msg, K>, Error = AgentWorkError<H>>
            + 'a,
        SI: Interpreter<SC, ToolHostMsg<P, I, S, C::Msg, K>, Error = AgentWorkError<H>> + 'a,
        SC: CommandFamily + From<Q::Command> + 'a,
        SC::Msg: Into<ToolHostMsg<P, I, S, C::Msg, K>>,
        TM: Timer + 'static,
        H: 'static,
        M: 'a,
        ToolHostMsg<P, I, S, C::Msg, K>: 'static,
        Stage: 'a,
        P: 'a,
        I: 'a,
        S: 'a,
        R: 'a,
        TE: 'a,
        A: 'a,
        T: 'a,
        Provider: 'a,
        C: 'a,
        V: 'a,
        K: 'a,
        K::Command: 'a,
        Q: 'a,
        Q::Command: 'a,
    {
        let mut accepted_types = <HostMsg<P, I, S, R, K> as Message>::TYPES
            .iter()
            .map(|name| (*name).to_owned())
            .collect::<Vec<_>>();
        accepted_types.extend(routed_types);
        let tools = Rc::new(tools);
        let tool_reader = Rc::clone(&tools);
        let init = Rc::clone(&self);
        let reduce = Rc::clone(&self);
        let project = Rc::clone(&self);
        let machine = Machine {
            init: Box::new(move |loaded, _| {
                Step::new(loaded.unwrap_or_else(|| init.init()), vec![])
            }),
            update: TryUpdate::try_reducer_with_types(accepted_types, move |state, message| {
                let step = match message {
                    AgentMachineMsg::Start { run_id, at } => reduce
                        .start(state, run_id, *at)
                        .map_err(AgentMachineError::Agent),
                    AgentMachineMsg::Tool(msg) => {
                        fold_tool(reduce.as_ref(), state, msg, tool_reader.as_ref())
                    }
                    AgentMachineMsg::Brain(msg) => {
                        let at = msg
                            .at()
                            .and_then(NumberOrNull::number)
                            .ok_or(AgentMachineError::UnsupportedStamp { at: msg.at() })?;
                        match msg.outcome() {
                            Settlement::Ok(_) => reduce
                                .succeed(state, msg, at)
                                .map_err(AgentMachineError::Agent),
                            Settlement::Err(_) => reduce
                                .fail(state, msg, at)
                                .map_err(AgentMachineError::Agent),
                        }
                    }
                    AgentMachineMsg::Compact(msg) => match K::message(msg) {
                        CompactMessage::Ok(msg) => reduce
                            .compact_ok(state, &msg.key, msg, msg.at)
                            .map_err(AgentMachineError::Agent),
                        CompactMessage::Err(msg) => reduce
                            .compact_err(state, &msg.key, msg, msg.at)
                            .map_err(AgentMachineError::Agent),
                    },
                    AgentMachineMsg::Deadline(msg) => reduce
                        .on_timer(state, msg)
                        .map_err(AgentMachineError::Agent),
                    AgentMachineMsg::Boot { at } => {
                        reduce.boot(state, *at).map_err(AgentMachineError::Agent)
                    }
                    AgentMachineMsg::Cancel { at } => {
                        reduce.cancel(state, *at).map_err(AgentMachineError::Agent)
                    }
                };
                step.map(|step| {
                    step.map(std::convert::identity, |command| {
                        command.map_snapshot(SC::from)
                    })
                })
            }),
            subscriptions: Box::new(SubscriptionEntries::new(vec![SubEntry::try_new(
                "deadline",
                move |state: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>| {
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
                compact,
                snapshot,
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

impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>>,
    R,
    A,
    T,
    Provider,
    C,
    V: CallSource<A>,
    K: CompactionProfile,
    Q: SnapshotProfile,
> Agent<'a, Stage, P, I, S, R, PlainData, A, T, Provider, C, V, K, Q>
where
    C: CommandFamily<Msg = AgentToolMsg<R>>,
    <K::Command as CommandFamily>::Msg: Tagged,
{
    fn fold_legacy_tool<TI>(
        &self,
        state: &SharedStateOf<Stage, P, I, S, R, PlainData, A, T, V, K>,
        message: &AgentToolMsg<R>,
        _: &TI,
    ) -> ToolFoldResult<Stage, P, I, S, R, PlainData, A, T, C, V, K, Q> {
        match message {
            AgentToolMsg::Ok {
                call_id,
                result,
                at,
            } => self.tool_ok(state, call_id, Rc::clone(result), *at),
            AgentToolMsg::Err {
                call_id,
                reason,
                at,
            } => self.tool_err_reason(state, call_id, reason, *at),
        }
        .map_err(AgentMachineError::Agent)
    }
}
impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>>, R, TE, A, T, Provider, C>
    Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C, NativeCalls>
where
    C: CommandFamily,
    C::Msg: Tagged,
{
    /// Serial routed tools over the same wire. Loaded init stays commandless;
    /// dispatch Boot explicitly. The timer/actor retain their existing static limits.
    /// This initial profile uses native calls without compaction, snapshots or tool policies.
    /// Missing/null stamps refuse; it does not add a full routed-state persistence codec.
    #[expect(
        clippy::type_complexity,
        reason = "Machine, model, original tool families and host ports retain their independent inferred owners."
    )]
    pub fn to_machine_with_tools<F, L, TI, M, TM>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        timer: Rc<TM>,
    ) -> AgentWired<
        WiredMachine<
            'a,
            Stage,
            P,
            I,
            S,
            R,
            A,
            T,
            C,
            NativeCalls,
            NoCompaction,
            NoSnapshotCommand,
            TE,
        >,
        impl Interpreter<CommandOf<P, I, S, C>, Error = AgentWorkError<ToolError>> + 'a,
        impl Subscriptions<
            DeadlinesSub,
            ToolHostMsg<P, I, S, C::Msg>,
            Error = AgentWorkError<ToolError>,
        >,
    >
    where
        F: ModelFactory<M, S> + 'a,
        L: MessageLoader<P, I, M, S::Error> + 'a,
        TI: Interpreter<C, ToolHostMsg<P, I, S, C::Msg>, Error = AgentWorkError<ToolError>>
            + AgentToolRoutes<C, R, TE>
            + 'a,
        TM: Timer + 'static,
        ToolHostMsg<P, I, S, C::Msg>: 'static,
        M: 'a,
        Stage: 'a,
        P: 'a,
        I: 'a,
        S: 'a,
        R: 'a,
        TE: 'a,
        A: 'a,
        T: 'a,
        Provider: 'a,
        C: 'a,
    {
        let names = tools.settlement_types();
        self.wire(
            model,
            loader,
            tools,
            NoCompactInterpreter(PhantomData),
            NoSnapshotInterpreter(PhantomData),
            timer,
            names,
            |agent, state, message, tools| {
                let first_at = tools.at(message);
                first_at
                    .and_then(NumberOrNull::number)
                    .ok_or(AgentMachineError::UnsupportedStamp { at: first_at })?;
                let Some(settled) = tools
                    .outcome_of(message)
                    .map_err(AgentMachineError::ToolContract)?
                else {
                    return Ok(Step::new(Rc::clone(state), vec![]));
                };
                let at = tools.at(message);
                let time = at
                    .and_then(NumberOrNull::number)
                    .ok_or(AgentMachineError::UnsupportedStamp { at })?;
                match settled.outcome {
                    crate::agent::types::ToolOutcome::Ok(result) => {
                        agent.tool_ok(state, settled.call_id, result, time)
                    }
                    crate::agent::types::ToolOutcome::Error(error) => {
                        agent.tool_err(state, settled.call_id, error, time)
                    }
                }
                .map_err(AgentMachineError::Agent)
            },
        )
    }
}

struct NoCompactInterpreter<H>(PhantomData<fn() -> H>);
impl<H, M> Interpreter<NoCompactCommand, M> for NoCompactInterpreter<H> {
    type Error = AgentWorkError<H>;
    fn interpret<'b>(
        &'b self,
        command: &'b NoCompactCommand,
        _: CommandContext<M, Self::Error>,
    ) -> Option<CommandWork<'b, NoCompactMessage, Self::Error>> {
        match *command {}
    }
}
impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>>, R, A, T, Provider, C, V: CallSource<A>>
    Agent<'a, Stage, P, I, S, R, PlainData, A, T, Provider, C, V>
where
    C: CommandFamily<Msg = AgentToolMsg<R>>,
{
    /// Loaded init is commandless. Dispatch Boot after ready. Borrowed host
    /// services/state may be constructed locally; owned timer messages/errors
    /// and eventual actor launch retain their existing static boundaries.
    #[expect(
        clippy::type_complexity,
        reason = "The inferred machine, interpreter and subscription runner retain independent concrete owners."
    )]
    pub fn to_machine<F, L, TI, M, H, TM>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        timer: Rc<TM>,
    ) -> AgentWired<
        WiredMachine<'a, Stage, P, I, S, R, A, T, C, V>,
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
        V: 'a,
    {
        self.wire(
            model,
            loader,
            tools,
            NoCompactInterpreter(PhantomData),
            NoSnapshotInterpreter(PhantomData),
            timer,
            Vec::new(),
            Self::fold_legacy_tool::<TI>,
        )
    }
}
impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>>,
    R,
    A,
    T,
    Provider,
    C,
    V: CallSource<A>,
    CI,
    CO,
    CE,
> Agent<'a, Stage, P, I, S, R, PlainData, A, T, Provider, C, V, WithCompaction<CI, CO, CE>>
where
    C: CommandFamily<Msg = AgentToolMsg<R>>,
{
    /// The enabled profile requires the caller-owned plain compact handler.
    /// Tea owns retry/fold orchestration, not summarize IO or its message time.
    #[expect(
        clippy::type_complexity,
        reason = "The inferred machine, interpreter and subscription runner retain independent concrete owners."
    )]
    pub fn to_machine_with_compaction<F, L, TI, CT, M, H, TM>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        compact: CT,
        timer: Rc<TM>,
    ) -> AgentWired<
        WiredMachine<'a, Stage, P, I, S, R, A, T, C, V, WithCompaction<CI, CO, CE>>,
        impl Interpreter<CommandOf<P, I, S, C, WithCompaction<CI, CO, CE>>, Error = AgentWorkError<H>>
        + 'a,
        impl Subscriptions<
            DeadlinesSub,
            HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
            Error = AgentWorkError<H>,
        >,
    >
    where
        F: ModelFactory<M, S> + 'a,
        L: MessageLoader<P, I, M, S::Error> + 'a,
        TI: Interpreter<
                C,
                HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
                Error = AgentWorkError<H>,
            > + 'a,
        CT: Interpreter<
                crate::agent::compaction::CompactRun<CI, CO, CE>,
                HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
                Error = AgentWorkError<H>,
            > + 'a,
        TM: Timer + 'static,
        H: 'static,
        M: 'a,
        HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>: 'static,
        Stage: 'a,
        P: 'a,
        I: 'a,
        S: 'a,
        R: 'a,
        A: 'a,
        T: 'a,
        Provider: 'a,
        C: 'a,
        V: 'a,
        CI: 'a,
        CO: 'a,
        CE: 'a,
    {
        self.wire(
            model,
            loader,
            tools,
            compact,
            NoSnapshotInterpreter(PhantomData),
            timer,
            Vec::new(),
            Self::fold_legacy_tool::<TI>,
        )
    }
}

struct NoSnapshotInterpreter<H>(PhantomData<fn() -> H>);
impl<H, M> Interpreter<NoSnapshotCommand, M> for NoSnapshotInterpreter<H> {
    type Error = AgentWorkError<H>;
    fn interpret<'b>(
        &'b self,
        command: &'b NoSnapshotCommand,
        _: CommandContext<M, Self::Error>,
    ) -> Option<CommandWork<'b, NoSnapshotMessage, Self::Error>> {
        match *command {}
    }
}

impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>>, R, A, T, Provider, C, V: CallSource<A>>
    Agent<'a, Stage, P, I, S, R, PlainData, A, T, Provider, C, V, NoCompaction, WithSnapshot>
where
    C: CommandFamily<Msg = AgentToolMsg<R>>,
{
    /// The enabled checkpoint profile requires actual caller-owned named IO.
    /// Progress-only commands stay discarded, and loaded init stays commandless.
    #[expect(
        clippy::type_complexity,
        reason = "The inferred machine, interpreter and subscription runner retain independent concrete owners."
    )]
    pub fn to_machine_with_snapshot<F, L, TI, SI, M, H, TM>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        snapshot: SI,
        timer: Rc<TM>,
    ) -> AgentWired<
        WiredMachine<'a, Stage, P, I, S, R, A, T, C, V, NoCompaction, AgentSnapshotWrite>,
        impl Interpreter<CommandOf<P, I, S, C, NoCompaction, WithSnapshot>, Error = AgentWorkError<H>>
        + 'a,
        impl Subscriptions<DeadlinesSub, HostMsg<P, I, S, R, NoCompaction>, Error = AgentWorkError<H>>,
    >
    where
        F: ModelFactory<M, S> + 'a,
        L: MessageLoader<P, I, M, S::Error> + 'a,
        TI: Interpreter<C, HostMsg<P, I, S, R, NoCompaction>, Error = AgentWorkError<H>> + 'a,
        SI: Interpreter<
                AgentSnapshotWrite,
                HostMsg<P, I, S, R, NoCompaction>,
                Error = AgentWorkError<H>,
            > + 'a,
        TM: Timer + 'static,
        H: 'static,
        M: 'a,
        HostMsg<P, I, S, R, NoCompaction>: 'static,
        Stage: 'a,
        P: 'a,
        I: 'a,
        S: 'a,
        R: 'a,
        A: 'a,
        T: 'a,
        Provider: 'a,
        C: 'a,
        V: 'a,
    {
        self.wire(
            model,
            loader,
            tools,
            NoCompactInterpreter(PhantomData),
            snapshot,
            timer,
            Vec::new(),
            Self::fold_legacy_tool::<TI>,
        )
    }
}

impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>>,
    R,
    A,
    T,
    Provider,
    C,
    V: CallSource<A>,
    CI,
    CO,
    CE,
>
    Agent<
        'a,
        Stage,
        P,
        I,
        S,
        R,
        PlainData,
        A,
        T,
        Provider,
        C,
        V,
        WithCompaction<CI, CO, CE>,
        WithSnapshot,
    >
where
    C: CommandFamily<Msg = AgentToolMsg<R>>,
{
    /// The enabled checkpoint profile requires actual caller-owned named IO.
    /// Progress-only commands stay discarded, and loaded init stays commandless.
    #[expect(
        clippy::type_complexity,
        reason = "The inferred machine, interpreter and subscription runner retain independent concrete owners."
    )]
    pub fn to_machine_with_snapshot_and_compaction<F, L, TI, SI, CT, M, H, TM>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        snapshot: SI,
        compact: CT,
        timer: Rc<TM>,
    ) -> AgentWired<
        WiredMachine<
            'a,
            Stage,
            P,
            I,
            S,
            R,
            A,
            T,
            C,
            V,
            WithCompaction<CI, CO, CE>,
            AgentSnapshotWrite,
        >,
        impl Interpreter<
            CommandOf<P, I, S, C, WithCompaction<CI, CO, CE>, WithSnapshot>,
            Error = AgentWorkError<H>,
        > + 'a,
        impl Subscriptions<
            DeadlinesSub,
            HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
            Error = AgentWorkError<H>,
        >,
    >
    where
        F: ModelFactory<M, S> + 'a,
        L: MessageLoader<P, I, M, S::Error> + 'a,
        TI: Interpreter<
                C,
                HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
                Error = AgentWorkError<H>,
            > + 'a,
        SI: Interpreter<
                AgentSnapshotWrite,
                HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
                Error = AgentWorkError<H>,
            > + 'a,
        CT: Interpreter<
                crate::agent::compaction::CompactRun<CI, CO, CE>,
                HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
                Error = AgentWorkError<H>,
            > + 'a,
        TM: Timer + 'static,
        H: 'static,
        M: 'a,
        HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>: 'static,
        Stage: 'a,
        P: 'a,
        I: 'a,
        S: 'a,
        R: 'a,
        A: 'a,
        T: 'a,
        Provider: 'a,
        C: 'a,
        V: 'a,
        CI: 'a,
        CO: 'a,
        CE: 'a,
    {
        self.wire(
            model,
            loader,
            tools,
            compact,
            snapshot,
            timer,
            Vec::new(),
            Self::fold_legacy_tool::<TI>,
        )
    }
}

impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>>, R, A, T, Provider, C, V: CallSource<A>>
    Agent<'a, Stage, P, I, S, R, PlainData, A, T, Provider, C, V, NoCompaction, WithSnapshot>
where
    C: CommandFamily<Msg = AgentToolMsg<R>>,
{
    /// A plain checkpoint writer returns original messages to the serial tail.
    /// Entries are queued in order; they never update State reentrantly.
    /// See [`AgentSnapshotMessages`] for the runtime-only Source type boundary.
    #[expect(
        clippy::type_complexity,
        reason = "The inferred machine, interpreter and subscription runner retain independent concrete owners."
    )]
    pub fn to_machine_with_snapshot_messages<F, L, TI, SI, M, H, TM>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        snapshot: SI,
        timer: Rc<TM>,
    ) -> AgentWired<
        WiredMachine<
            'a,
            Stage,
            P,
            I,
            S,
            R,
            A,
            T,
            C,
            V,
            NoCompaction,
            AgentSnapshotMessages<HostMsg<P, I, S, R, NoCompaction>>,
        >,
        impl Interpreter<
            WiredCommand<
                P,
                I,
                S,
                C,
                NoCompaction,
                AgentSnapshotMessages<HostMsg<P, I, S, R, NoCompaction>>,
            >,
            Error = AgentWorkError<H>,
        > + 'a,
        impl Subscriptions<DeadlinesSub, HostMsg<P, I, S, R, NoCompaction>, Error = AgentWorkError<H>>,
    >
    where
        F: ModelFactory<M, S> + 'a,
        L: MessageLoader<P, I, M, S::Error> + 'a,
        TI: Interpreter<C, HostMsg<P, I, S, R, NoCompaction>, Error = AgentWorkError<H>> + 'a,
        SI: Interpreter<
                AgentSnapshotMessages<HostMsg<P, I, S, R, NoCompaction>>,
                HostMsg<P, I, S, R, NoCompaction>,
                Error = AgentWorkError<H>,
            > + 'a,
        TM: Timer + 'static,
        H: 'static,
        M: 'a,
        HostMsg<P, I, S, R, NoCompaction>: 'static,
        Stage: 'a,
        P: 'a,
        I: 'a,
        S: 'a,
        R: 'a,
        A: 'a,
        T: 'a,
        Provider: 'a,
        C: 'a,
        V: 'a,
    {
        self.wire(
            model,
            loader,
            tools,
            NoCompactInterpreter(PhantomData),
            snapshot,
            timer,
            Vec::new(),
            Self::fold_legacy_tool::<TI>,
        )
    }
}

impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>>,
    R,
    A,
    T,
    Provider,
    C,
    V: CallSource<A>,
    CI,
    CO,
    CE,
>
    Agent<
        'a,
        Stage,
        P,
        I,
        S,
        R,
        PlainData,
        A,
        T,
        Provider,
        C,
        V,
        WithCompaction<CI, CO, CE>,
        WithSnapshot,
    >
where
    C: CommandFamily<Msg = AgentToolMsg<R>>,
{
    /// A plain checkpoint writer returns original messages to the serial tail.
    /// Entries are queued in order; they never update State reentrantly.
    /// See [`AgentSnapshotMessages`] for the runtime-only Source type boundary.
    #[expect(
        clippy::type_complexity,
        reason = "The inferred machine, interpreter and subscription runner retain independent concrete owners."
    )]
    pub fn to_machine_with_snapshot_messages_and_compaction<F, L, TI, SI, CT, M, H, TM>(
        self: Rc<Self>,
        model: F,
        loader: L,
        tools: TI,
        snapshot: SI,
        compact: CT,
        timer: Rc<TM>,
    ) -> AgentWired<
        WiredMachine<
            'a,
            Stage,
            P,
            I,
            S,
            R,
            A,
            T,
            C,
            V,
            WithCompaction<CI, CO, CE>,
            AgentSnapshotMessages<HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>>,
        >,
        impl Interpreter<
            WiredCommand<
                P,
                I,
                S,
                C,
                WithCompaction<CI, CO, CE>,
                AgentSnapshotMessages<HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>>,
            >,
            Error = AgentWorkError<H>,
        > + 'a,
        impl Subscriptions<
            DeadlinesSub,
            HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
            Error = AgentWorkError<H>,
        >,
    >
    where
        F: ModelFactory<M, S> + 'a,
        L: MessageLoader<P, I, M, S::Error> + 'a,
        TI: Interpreter<
                C,
                HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
                Error = AgentWorkError<H>,
            > + 'a,
        SI: Interpreter<
                AgentSnapshotMessages<HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>>,
                HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
                Error = AgentWorkError<H>,
            > + 'a,
        CT: Interpreter<
                crate::agent::compaction::CompactRun<CI, CO, CE>,
                HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>,
                Error = AgentWorkError<H>,
            > + 'a,
        TM: Timer + 'static,
        H: 'static,
        M: 'a,
        HostMsg<P, I, S, R, WithCompaction<CI, CO, CE>>: 'static,
        Stage: 'a,
        P: 'a,
        I: 'a,
        S: 'a,
        R: 'a,
        A: 'a,
        T: 'a,
        Provider: 'a,
        C: 'a,
        V: 'a,
        CI: 'a,
        CO: 'a,
        CE: 'a,
    {
        self.wire(
            model,
            loader,
            tools,
            compact,
            snapshot,
            timer,
            Vec::new(),
            Self::fold_legacy_tool::<TI>,
        )
    }
}
