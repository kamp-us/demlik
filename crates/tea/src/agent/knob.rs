//! Base pure agent knob over the canonical run, brain and tool ledgers.
//! Optional snapshot/compaction/tool-policy and Runtime wiring are separate profiles.
use crate::{
    PlainData, Tagged,
    agent::{
        compaction::{
            CompactionPolicy, CompactionProfile, CompactionPurpose, NoCompaction, WithCompaction,
        },
        conversation::shared_no_usage,
        turn_view::{
            CallOf, CallSource, NativeCalls, PlainCalls, PlainToolCall, TurnReader, read_native,
            read_plain,
        },
        types::{AgentField, AgentState, AgentTurn, Conversation, ToolCall, ToolOutcome},
    },
    command::CmdDef,
    data::JsText,
    flow::{
        fan_out::{FanOut, FanOutConfig},
        monitored_run::{MonitoredRun, MonitoredRunConfig},
    },
    js_record::JsRecord,
    llm_call::{self, LlmCall, LlmErr, LlmOk, Purpose, Request, Schema},
    resilience::resilient_call::ResilientCall,
};
use std::rc::Rc;

mod command;
mod error;
mod runtime;
pub use command::AgentCommand;
pub use error::{AgentError, OptionalProfile};
pub use runtime::{
    AgentCompletion, AgentMachineError, AgentMachineMsg, AgentToolMsg, AgentWired, AgentWorkError,
    agent_boot_msg, agent_cancel_msg,
};
pub type CommandOf<P, I, S, C, K = NoCompaction> = AgentCommand<
    P,
    I,
    <S as Schema>::Output,
    <S as Schema>::Error,
    C,
    <K as CompactionProfile>::Command,
>;
pub type StepOf<Stage, P, I, S, R, TE, A, T, C, V = NativeCalls, K = NoCompaction> =
    crate::Step<SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>, CommandOf<P, I, S, C, K>>;
type MaybeStepOf<Stage, P, I, S, R, TE, A, T, C, V, K> =
    Option<StepOf<Stage, P, I, S, R, TE, A, T, C, V, K>>;
type ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> =
    Result<StepOf<Stage, P, I, S, R, TE, A, T, C, V, K>, AgentError>;
type StopWhen<'a, Stage, P, I, S, R, TE, A, T, V, K> =
    Option<Box<dyn Fn(&SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>) -> bool + 'a>>;

pub type StateOf<Stage, P, I, S, R, TE, A, T, V = NativeCalls, K = NoCompaction> = AgentState<
    Stage,
    P,
    <S as Schema>::Output,
    R,
    I,
    <S as Schema>::Error,
    TE,
    PlainData,
    A,
    T,
    <K as CompactionProfile>::Input,
    <K as CompactionProfile>::Output,
    <K as CompactionProfile>::Error,
    LlmErr<P, <S as Schema>::Error>,
    V,
>;
/// Retained state returned by the pure agent verbs.
pub type SharedStateOf<Stage, P, I, S, R, TE, A, T, V = NativeCalls, K = NoCompaction> =
    Rc<StateOf<Stage, P, I, S, R, TE, A, T, V, K>>;
pub type BrainCommandOf<P, I, S> =
    llm_call::RunCmd<P, I, <S as Schema>::Output, <S as Schema>::Error>;
pub type BrainMessageOf<P, I, S> =
    llm_call::LlmMsg<P, I, <S as Schema>::Output, <S as Schema>::Error>;
type StageOf<'s, S> = Option<&'s Rc<S>>;
type TurnOf<'a, S, P> = Box<dyn Fn(StageOf<'_, S>) -> P + 'a>;
type PayloadOf<'a, Stage, R, T, TE, A, I, V> =
    Box<dyn Fn(StageOf<'_, Stage>, &Rc<Conversation<R, T, TE, A, V>>, Option<&JsText>) -> I + 'a>;
type ToolOf<'a, A, C, V> = Rc<dyn Fn(&Rc<CallOf<A, V>>) -> C + 'a>;
pub type TurnView<T, A, Provider> = for<'t> fn(&'t T) -> &'t AgentTurn<A, Provider>;

type PolicyOf<'a, R, T, TE, A, V, K> = CompactionPolicy<
    'a,
    Conversation<R, T, TE, A, V>,
    T,
    <K as CompactionProfile>::Input,
    <K as CompactionProfile>::Output,
    <K as CompactionProfile>::Error,
>;

pub struct AgentConfig<
    'a,
    Stage,
    P,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    TE,
    A,
    T,
    Provider,
    C,
    V: CallSource<A> = NativeCalls,
    K: CompactionProfile = NoCompaction,
> {
    llm: Rc<LlmCall<'a, P, I, S>>,
    stages: Vec<Rc<Stage>>,
    turn_of: TurnOf<'a, Stage, P>,
    payload_of: PayloadOf<'a, Stage, R, T, TE, A, I, V>,
    tool_of: ToolOf<'a, A, C, V>,
    turn_view: TurnReader<T, A, Provider, V>,
    instructions: Option<JsText>,
    model_id: Option<JsText>,
    deadline_ms: Option<f64>,
    tool_concurrency: f64,
    max_turns: Option<f64>,
    max_elapsed_ms: Option<f64>,
    compaction: Option<PolicyOf<'a, R, T, TE, A, V, K>>,
    stop_when: StopWhen<'a, Stage, P, I, S, R, TE, A, T, V, K>,
}
impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>> + ?Sized, R, TE, A, T, Provider, C: Tagged>
    AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C, NativeCalls>
{
    pub fn new(
        llm: Rc<LlmCall<'a, P, I, S>>,
        stages: Vec<Rc<Stage>>,
        turn_of: impl Fn(StageOf<'_, Stage>) -> P + 'a,
        tool_of: impl Fn(&Rc<ToolCall<A>>) -> C + 'a,
        payload_of: impl Fn(StageOf<'_, Stage>, &Rc<Conversation<R, T, TE, A>>, Option<&JsText>) -> I
        + 'a,
        turn_view: TurnView<T, A, Provider>,
    ) -> Self {
        Self::from_reader(
            llm,
            stages,
            turn_of,
            tool_of,
            payload_of,
            TurnReader {
                native: Some(turn_view),
                read: read_native,
            },
        )
    }
}
impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<PlainData>> + ?Sized, R, TE, C: Tagged>
    AgentConfig<'a, Stage, P, I, S, R, TE, PlainData, PlainData, PlainData, C, PlainCalls>
{
    /// Read the actual guarded plain turn; no DTO or schema conversion occurs.
    pub fn from_plain_turns(
        llm: Rc<LlmCall<'a, P, I, S>>,
        stages: Vec<Rc<Stage>>,
        turn_of: impl Fn(StageOf<'_, Stage>) -> P + 'a,
        tool_of: impl Fn(&Rc<PlainToolCall>) -> C + 'a,
        payload_of: impl Fn(
            StageOf<'_, Stage>,
            &Rc<Conversation<R, PlainData, TE, PlainData, PlainCalls>>,
            Option<&JsText>,
        ) -> I
        + 'a,
    ) -> Self {
        Self::from_reader(
            llm,
            stages,
            turn_of,
            tool_of,
            payload_of,
            TurnReader {
                native: None,
                read: |value, _| read_plain(value),
            },
        )
    }
}
impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    TE,
    A,
    T,
    Provider,
    C: Tagged,
    V: CallSource<A>,
    K: CompactionProfile,
> AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, K>
{
    fn from_reader(
        llm: Rc<LlmCall<'a, P, I, S>>,
        stages: Vec<Rc<Stage>>,
        turn_of: impl Fn(StageOf<'_, Stage>) -> P + 'a,
        tool_of: impl Fn(&Rc<CallOf<A, V>>) -> C + 'a,
        payload_of: impl Fn(StageOf<'_, Stage>, &Rc<Conversation<R, T, TE, A, V>>, Option<&JsText>) -> I
        + 'a,
        turn_view: TurnReader<T, A, Provider, V>,
    ) -> Self {
        Self {
            llm,
            stages,
            turn_of: Box::new(turn_of),
            payload_of: Box::new(payload_of),
            tool_of: Rc::new(tool_of),
            turn_view,
            instructions: None,
            model_id: None,
            deadline_ms: None,
            tool_concurrency: 1.0,
            max_turns: None,
            max_elapsed_ms: None,
            stop_when: None,
            compaction: None,
        }
    }
    pub fn instructions(mut self, value: impl Into<JsText>) -> Self {
        self.instructions = Some(value.into());
        self
    }
    pub fn model_id(mut self, value: impl Into<JsText>) -> Self {
        self.model_id = Some(value.into());
        self
    }
    pub fn tool_concurrency(mut self, value: f64) -> Self {
        self.tool_concurrency = value;
        self
    }
    pub fn max_turns(mut self, value: f64) -> Self {
        self.max_turns = Some(value);
        self
    }
    pub fn max_elapsed_ms(mut self, value: f64) -> Self {
        self.max_elapsed_ms = Some(value);
        self
    }
    pub fn stop_when(
        mut self,
        predicate: impl Fn(&SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>) -> bool + 'a,
    ) -> Self {
        self.stop_when = Some(Box::new(predicate));
        self
    }
    pub fn deadline_ms(mut self, ms: f64) -> Self {
        self.deadline_ms = Some(ms);
        self
    }
}

pub struct Agent<
    'a,
    Stage,
    P,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    TE,
    A,
    T,
    Provider,
    C,
    V: CallSource<A> = NativeCalls,
    K: CompactionProfile = NoCompaction,
> {
    config: AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, K>,
    run: MonitoredRun<Stage, ()>,
    fan: FanOut<'a, CallOf<A, V>, ToolOutcome<R, TE>, C, TE>,
    compact: CompactCall<'a, K>,
}
pub fn create_agent<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    TE,
    A: 'a,
    T,
    Provider,
    C: Tagged + 'a,
    V: CallSource<A>,
    K: CompactionProfile,
>(
    config: AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, K>,
) -> Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, K>
where
    CallOf<A, V>: 'a,
{
    let tool = Rc::clone(&config.tool_of);
    let run = MonitoredRun::new(MonitoredRunConfig {
        stages: config.stages.clone(),
        deadline_ms: config.deadline_ms,
        ..Default::default()
    });
    let fan = FanOut::new(FanOutConfig::new(
        config.tool_concurrency,
        |call: &CallOf<A, V>| V::call_id(call).clone(),
        move |call| tool(call),
    ));
    let compact = config.llm.retry_sibling();
    Agent {
        config,
        run,
        fan,
        compact,
    }
}
impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    TE,
    A,
    T,
    Provider,
    C: Tagged,
    V: CallSource<A>,
    K: CompactionProfile,
> Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, K>
{
    pub fn init(&self) -> SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K> {
        Rc::new(AgentState {
            run: self.run.init(),
            resilience: self.config.llm.init(),
            tools: self.fan.init(),
            conversation: None,
            usage: AgentField::Value(Some(shared_no_usage())),
            compaction: AgentField::Value(self.compact.init()),
            tool_resilience: AgentField::Value(Rc::new(JsRecord::default())),
            refused_calls: AgentField::Value(Rc::new(Vec::new())),
            lifecycle: AgentField::Value(Rc::new(Vec::new())),
            failure: AgentField::Value(None),
            output: AgentField::Value(None),
            instructions: AgentField::Value(self.config.instructions.clone()),
        })
    }
    pub fn brain(&self) -> &CmdDef<llm_call::RunSpec<P, I, Rc<T>, S::Error>> {
        self.config.llm.run()
    }
    pub fn brain_call(
        &self,
        state: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
    ) -> Rc<Request<P, I>> {
        let stage = state.current_stage();
        let conversation = state
            .conversation
            .as_ref()
            .map(Rc::clone)
            .unwrap_or_else(|| Rc::new(Conversation::fresh()));
        let instructions = match &state.instructions {
            AgentField::Value(Some(value)) => Some(value),
            _ => None,
        };
        let purpose = (self.config.turn_of)(stage.as_ref());
        let payload = (self.config.payload_of)(stage.as_ref(), &conversation, instructions);
        Rc::new(Request::new(purpose, self.config.model_id.clone(), payload))
    }
}

use crate::{
    Step,
    agent::{
        conversation::{add_usage, dedupe_calls},
        types::{
            AgentFailure, AgentLifecycleNote, AgentNumber, Awaiting, AwaitingKind, ToolRecordOf,
        },
    },
    command::Settlement,
    flow::monitored_run::{MonitoredRunState, RunPhase, StageResult},
    resilience::{
        deadline::{Deadline, DeadlineExceeded},
        resilient_call::{CallPhase, CallValue},
    },
};
use std::collections::HashSet;

type CompactState<K> = llm_call::State<
    CompactionPurpose,
    <K as CompactionProfile>::Input,
    <K as CompactionProfile>::Output,
    <K as CompactionProfile>::Error,
>;
type CompactCall<'a, K> = ResilientCall<
    'a,
    Request<CompactionPurpose, <K as CompactionProfile>::Input>,
    LlmOk<CompactionPurpose, <K as CompactionProfile>::Output>,
    LlmErr<CompactionPurpose, <K as CompactionProfile>::Error>,
>;
type ToolState<A, E, V> =
    Rc<JsRecord<crate::resilience::resilient_call::State<CallOf<A, V>, (), E>>>;
impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    TE,
    A,
    T,
    Provider,
    C: Tagged,
    V: CallSource<A>,
    K: CompactionProfile,
> Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, K>
{
    fn empty_compaction(&self) -> CompactState<K> {
        self.compact.init()
    }
    fn supported(&self, s: &StateOf<Stage, P, I, S, R, TE, A, T, V, K>) -> Result<(), AgentError> {
        if !K::ENABLED {
            if matches!(
                s.conversation.as_ref().map(|c| &c.awaiting),
                Some(Awaiting::Compacting { .. })
            ) {
                return Err(AgentError::UnsupportedRestoredProfile {
                    profile: OptionalProfile::Compaction,
                    keys: vec!["$compact".into()],
                });
            }
            if let AgentField::Value(compact) = &s.compaction {
                let keys = compact
                    .snapshot()
                    .calls
                    .own_entries()
                    .map(|(k, _)| k.clone())
                    .collect::<Vec<_>>();
                if !keys.is_empty() {
                    return Err(AgentError::UnsupportedRestoredProfile {
                        profile: OptionalProfile::Compaction,
                        keys,
                    });
                }
            }
        }
        if let AgentField::Value(tools) = &s.tool_resilience {
            let keys = tools
                .own_entries()
                .map(|(k, _)| k.clone())
                .collect::<Vec<_>>();
            if !keys.is_empty() {
                return Err(AgentError::UnsupportedRestoredProfile {
                    profile: OptionalProfile::ToolResilience,
                    keys,
                });
            }
        }
        Ok(())
    }
    fn transition(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        at: AgentNumber,
        verb: impl FnOnce(
            &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K>,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.supported(s)?;
        let current = s.with_usage_defaults();
        let entered = if current
            .lifecycle
            .value()
            .is_some_and(|notes| !notes.is_empty())
        {
            let mut entered = current.as_ref().clone();
            entered.lifecycle = AgentField::Value(Rc::new(vec![]));
            Rc::new(entered)
        } else {
            current
        };
        let was_settled = entered.is_settled();
        let mut step = verb(&entered)?;
        if !was_settled && step.state.is_settled() {
            step.state = self.noted(&step.state, vec![AgentLifecycleNote::RunEnded { at }]);
        }
        Ok(step)
    }
    fn noted(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        notes: Vec<AgentLifecycleNote<A, TE, V>>,
    ) -> SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K> {
        if notes.is_empty() {
            return Rc::clone(s);
        }
        let mut all = s
            .lifecycle
            .value()
            .map_or_else(Vec::new, |old| old.as_ref().clone());
        all.extend(notes.into_iter().map(Rc::new));
        let mut next = s.as_ref().clone();
        next.lifecycle = AgentField::Value(Rc::new(all));
        Rc::new(next)
    }
    fn tool_started(
        &self,
        calls: &[Rc<CallOf<A, V>>],
        at: f64,
    ) -> Vec<AgentLifecycleNote<A, TE, V>> {
        calls
            .iter()
            .map(|call| AgentLifecycleNote::ToolStarted {
                call: Rc::clone(call),
                at: at.into(),
            })
            .collect()
    }
    fn run_state(
        &self,
        step: Step<Rc<MonitoredRunState<Stage>>, crate::flow::monitored_run::MonitoredRunCmd<()>>,
    ) -> Result<Rc<MonitoredRunState<Stage>>, AgentError> {
        if !step.commands.is_empty() {
            return Err(AgentError::UnsupportedRestoredProfile {
                profile: OptionalProfile::SnapshotCommand,
                keys: vec![],
            });
        }
        Ok(step.state)
    }
    fn fire_brain(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        let call = self.brain_call(s);
        let step = self
            .config
            .llm
            .attempt(&s.resilience, Rc::clone(&call), at)?;
        let noted = self.noted(
            s,
            vec![AgentLifecycleNote::BrainStarted {
                turn: s
                    .conversation
                    .as_ref()
                    .map_or(0.0, |c| c.turn_count.number_or_zero())
                    .into(),
                purpose: call.purpose.key(),
                model: call.model.clone(),
                at: at.into(),
            }],
        );
        let mut next = noted.as_ref().clone();
        next.resilience = step.state;
        Ok(Step::new(
            Rc::new(next),
            step.commands.into_iter().map(AgentCommand::Brain).collect(),
        ))
    }
    pub fn start(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        run_id: impl Into<JsText>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, at.into(), |s| {
            let mut next = s.as_ref().clone();
            next.run = self.run_state(self.run.start(&s.run, run_id, at))?;
            next.conversation = Some(Rc::new(Conversation::fresh()));
            next.usage = AgentField::Value(Some(shared_no_usage()));
            next.failure = AgentField::Value(None);
            next.output = AgentField::Value(None);
            next.tools = self.fan.init();
            next.compaction = AgentField::Value(self.empty_compaction());
            next.refused_calls = AgentField::Value(Rc::new(vec![]));
            self.fire_brain(&Rc::new(next), at)
        })
    }
    pub fn turn(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        result: Rc<T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, at.into(), |s| self.turn_body(s, result, at))
    }
    fn turn_body(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        result: Rc<T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        let Some(conv) = s.require_awaiting(AwaitingKind::Llm) else {
            return Ok(Step::new(Rc::clone(s), vec![]));
        };
        let fields = self
            .config
            .turn_view
            .read(&result)
            .map_err(AgentError::TurnRead)?;
        let mut measured = conv.as_ref().clone();
        let usage = match &fields.usage {
            None => {
                measured.context_tokens = AgentField::Value(AgentNumber(None));
                s.usage.clone()
            }
            Some(usage) => {
                let Some(total) = s.usage.value().and_then(Option::as_ref) else {
                    return Err(AgentError::NullUsage);
                };
                measured.context_tokens = AgentField::Value(
                    (usage.input_tokens.number_or_zero() + usage.output_tokens.number_or_zero())
                        .into(),
                );
                AgentField::Value(Some(Rc::new(add_usage(total, usage))))
            }
        };
        let mut turns = conv.turns.as_ref().clone();
        turns.push(Rc::clone(&result));
        measured.turns = Rc::new(turns);
        let mut counted = s.as_ref().clone();
        counted.usage = usage;
        if fields.calls.is_empty() {
            counted.conversation = Some(Rc::new(measured));
            return self.advance_stage(&Rc::new(counted), result, at);
        }
        let batch = dedupe_calls(&fields.calls, V::call_id);
        let scattered = self.fan.scatter(&self.fan.init(), batch);
        // FanOut invokes toolOf for its data commands; Source discards these,
        // then invokes the same callback again for every authorized launch.
        drop(scattered.commands);
        measured.awaiting = Awaiting::Tools {
            batch_turn: measured.turn_count,
        };
        counted.run = self.run_state(self.run.progress(&s.run, Rc::new(()), at))?;
        counted.tool_resilience = AgentField::Value(self.tool_slice(s));
        let commands = scattered
            .state
            .running
            .iter()
            .map(|call| AgentCommand::Tool((self.config.tool_of)(call)))
            .collect();
        let notes = self.tool_started(&scattered.state.running, at);
        counted.tools = scattered.state;
        counted.conversation = Some(Rc::new(measured));
        Ok(Step::new(self.noted(&Rc::new(counted), notes), commands))
    }
    fn advance_stage(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        terminating: Rc<T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        let run = self.run_state(self.run.advance(&s.run, Rc::new(()), StageResult::Ok, at))?;
        let mut next = s.as_ref().clone();
        let done = matches!(run.phase, RunPhase::Done { .. });
        next.run = run;
        if done {
            next.conversation = None;
            next.output = AgentField::Value(Some(terminating));
            return Ok(Step::new(Rc::new(next), vec![]));
        }
        next.conversation = Some(Rc::new(Conversation::fresh()));
        next.tools = self.fan.init();
        self.fire_brain(&Rc::new(next), at)
    }
    fn tool_slice(&self, s: &StateOf<Stage, P, I, S, R, TE, A, T, V, K>) -> ToolState<A, TE, V> {
        s.tool_resilience
            .value()
            .map_or_else(|| Rc::new(JsRecord::default()), Rc::clone)
    }
    fn in_flight(
        &self,
        s: &StateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        id: &JsText,
    ) -> Option<Rc<CallOf<A, V>>> {
        s.tools
            .running
            .iter()
            .find(|c| V::call_id(c) == id)
            .map(Rc::clone)
    }
    pub fn tool_ok(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        id: impl Into<JsText>,
        result: Rc<R>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        let id = id.into();
        self.transition(s, at.into(), |s| {
            let before = if self.in_flight(s, &id).is_some() {
                let mut next = s.as_ref().clone();
                next.tool_resilience = AgentField::Value(self.tool_slice(s));
                Rc::new(next)
            } else {
                Rc::clone(s)
            };
            self.settle_tool(&before, &id, Rc::new(ToolOutcome::Ok(result)), at)
        })
    }
    pub fn tool_err(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        id: impl Into<JsText>,
        failure: Rc<TE>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        let id = id.into();
        self.transition(s, at.into(), |s| {
            let before = if self.in_flight(s, &id).is_some() {
                let mut next = s.as_ref().clone();
                next.tool_resilience = AgentField::Value(self.tool_slice(s));
                Rc::new(next)
            } else {
                Rc::clone(s)
            };
            self.settle_tool(&before, &id, Rc::new(ToolOutcome::Error(failure)), at)
        })
    }
    fn settle_tool(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        id: &JsText,
        outcome: Rc<ToolOutcome<R, TE>>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        let Some(conv) = s.require_awaiting(AwaitingKind::Tools) else {
            return Ok(Step::new(Rc::clone(s), vec![]));
        };
        let Some(call) = self.in_flight(s, id) else {
            return Ok(Step::new(Rc::clone(s), vec![]));
        };
        let settled = match outcome.as_ref() {
            ToolOutcome::Ok(_) => self.fan.item_ok(&s.tools, id, Rc::clone(&outcome)),
            ToolOutcome::Error(failure) => self.fan.item_err(&s.tools, id, Rc::clone(failure)),
        };
        drop(settled.commands);
        let known = s
            .tools
            .running
            .iter()
            .map(|c| V::call_id(c).clone())
            .collect::<HashSet<_>>();
        let launched = settled
            .state
            .running
            .iter()
            .filter(|call| !known.contains(V::call_id(call)))
            .map(Rc::clone)
            .collect::<Vec<_>>();
        let launch_commands = launched
            .iter()
            .map(|call| AgentCommand::Tool((self.config.tool_of)(call)))
            .collect::<Vec<_>>();
        let mut next = s.as_ref().clone();
        next.tool_resilience = AgentField::Value(self.tool_slice(s));
        let mut notes = vec![];
        if let ToolOutcome::Error(failure) = outcome.as_ref() {
            let mut refused = s
                .refused_calls
                .value()
                .map_or_else(Vec::new, |v| v.as_ref().clone());
            refused.push(id.clone());
            next.refused_calls = AgentField::Value(Rc::new(refused));
            notes.push(AgentLifecycleNote::ToolFailed {
                call: Rc::clone(&call),
                failure: Rc::clone(failure),
                at: at.into(),
            });
        }
        notes.extend(self.tool_started(&launched, at));
        let noted = self.noted(&Rc::new(next), notes);
        let mut conversation = conv.as_ref().clone();
        let mut records = conv.tool_records.as_ref().clone();
        records.push(Rc::new(ToolRecordOf {
            call,
            outcome,
            turn: conv.turn_count,
        }));
        conversation.tool_records = Rc::new(records);
        let mut next = noted.as_ref().clone();
        next.tools = settled.state;
        if !self.fan.is_complete(&next.tools) {
            next.run = self.run_state(self.run.progress(&next.run, Rc::new(()), at))?;
            next.conversation = Some(Rc::new(conversation));
            return Ok(Step::new(Rc::new(next), launch_commands));
        }
        conversation.turn_count = (conversation.turn_count.number_or_zero() + 1.0).into();
        conversation.awaiting = Awaiting::Llm;
        next.conversation = Some(Rc::new(conversation));
        let turned = Rc::new(next);
        if let Some(stopped) = self.stop_conditions(&turned, at) {
            return Ok(stopped);
        }
        let mut drained = turned.as_ref().clone();
        drained.tools = self.fan.init();
        let drained = Rc::new(drained);
        if let Some(compacting) = self.maybe_compact(&drained, at)? {
            return Ok(compacting);
        }
        let mut drained = drained.as_ref().clone();
        drained.run = self.run_state(self.run.progress(&drained.run, Rc::new(()), at))?;
        let mut fired = self.fire_brain(&Rc::new(drained), at)?;
        let mut commands = launch_commands;
        commands.append(&mut fired.commands);
        fired.commands = commands;
        Ok(fired)
    }
    fn stop_conditions(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        at: f64,
    ) -> MaybeStepOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        let count = s
            .conversation
            .as_ref()
            .map_or(0.0, |c| c.turn_count.number_or_zero());
        let reason = if self.config.max_turns.is_some_and(|limit| count >= limit) {
            Some(AgentFailure::TurnLimit { at: at.into() })
        } else if self
            .config
            .max_elapsed_ms
            .is_some_and(|limit| at - s.run.started_at.number_or_zero() >= limit)
        {
            Some(AgentFailure::ElapsedLimit { at: at.into() })
        } else {
            None
        };
        if let Some(failure) = reason {
            let mut next = s.as_ref().clone();
            next.failure = AgentField::Value(Some(Rc::new(failure)));
            return Some(Step::new(Rc::new(next), vec![]));
        }
        if self.config.stop_when.as_ref().is_some_and(|stop| stop(s)) {
            return Some(self.cancel_body(s, at));
        }
        None
    }
    pub fn succeed(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        msg: &BrainMessageOf<P, I, S>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, at.into(), |s| {
            let retry = self.config.llm.succeed(&s.resilience, msg)?;
            let Settlement::Ok(CallValue::Shared(value)) = msg.outcome() else {
                return Err(AgentError::MissingBrainOutput);
            };
            let mut next = s.as_ref().clone();
            next.resilience = retry.state;
            let mut step = self.turn_body(&Rc::new(next), Rc::clone(&value.output), at)?;
            let mut commands = retry
                .commands
                .into_iter()
                .map(AgentCommand::Brain)
                .collect::<Vec<_>>();
            commands.append(&mut step.commands);
            step.commands = commands;
            Ok(step)
        })
    }
    pub fn fail(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        msg: &BrainMessageOf<P, I, S>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, at.into(), |s| {
            let retry = self.config.llm.fail(&s.resilience, msg)?;
            let mut next = s.as_ref().clone();
            if matches!(
                retry.state.call(msg.cmd().input().key.clone()),
                Some(CallPhase::Failed { .. })
            ) {
                let error = self.config.llm.err_of(msg)?;
                next.failure = AgentField::Value(Some(Rc::new(AgentFailure::Llm {
                    error: AgentField::Value(Rc::new(error)),
                    at: at.into(),
                })));
            }
            next.resilience = retry.state;
            Ok(Step::new(
                Rc::new(next),
                retry
                    .commands
                    .into_iter()
                    .map(AgentCommand::Brain)
                    .collect(),
            ))
        })
    }
    /// Hand-driving convenience for the same fold as the Source wired cancel Msg.
    pub fn cancel(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, at.into(), |s| Ok(self.cancel_body(s, at)))
    }
    fn cancel_body(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        at: f64,
    ) -> StepOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        let mut next = s.as_ref().clone();
        next.run = self.run.cancel(&s.run, at).state;
        Step::new(Rc::new(next), vec![])
    }
    pub fn boot(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, at.into(), |s| {
            let mut resumed = s.as_ref().clone();
            resumed.run = self.run.boot(&s.run, at).state;
            let resumed = Rc::new(resumed);
            if resumed.is_settled() {
                return Ok(Step::new(resumed, vec![]));
            }
            let Some(conv) = &resumed.conversation else {
                return Ok(Step::new(resumed, vec![]));
            };
            if matches!(conv.awaiting, Awaiting::Llm) {
                return self.fire_brain(&resumed, at);
            }
            if let Awaiting::Compacting { folding } = conv.awaiting {
                let call = self.compaction_call(conv, folding)?;
                let step = self
                    .compact
                    .attempt(
                        self.compact_slice(&resumed)?,
                        "$compact",
                        CallValue::shared(call),
                        at,
                    )
                    .map_err(llm_call::LlmCallError::from)?;
                let commands = self.compact_commands(step.commands)?;
                let mut next = resumed.as_ref().clone();
                next.compaction = AgentField::Value(step.state);
                return Ok(Step::new(Rc::new(next), commands));
            }
            let commands = resumed
                .tools
                .running
                .iter()
                .map(|call| AgentCommand::Tool((self.config.tool_of)(call)))
                .collect();
            let noted = self.noted(&resumed, self.tool_started(&resumed.tools.running, at));
            let mut next = noted.as_ref().clone();
            next.tool_resilience = AgentField::Value(self.tool_slice(&resumed));
            Ok(Step::new(Rc::new(next), commands))
        })
    }
    pub fn on_timer(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        msg: &DeadlineExceeded,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, msg.at_ms, |s| {
            let has = |prefix: &str| {
                msg.id
                    .as_units()
                    .starts_with(&prefix.encode_utf16().collect::<Vec<_>>())
            };
            if has("monitored:") {
                let mut next = s.as_ref().clone();
                next.run = self.run.on_deadline(&s.run, msg).state;
                return Ok(Step::new(Rc::new(next), vec![]));
            }
            if msg
                .id
                .as_units()
                .ends_with(&":$compact".encode_utf16().collect::<Vec<_>>())
            {
                if !K::ENABLED {
                    return Err(AgentError::UnsupportedRestoredProfile {
                        profile: OptionalProfile::Compaction,
                        keys: vec![msg.id.clone()],
                    });
                }
                let step = self
                    .compact
                    .on_timer(self.compact_slice(s)?, msg)
                    .map_err(llm_call::LlmCallError::from)?;
                let commands = self.compact_commands(step.commands)?;
                let mut next = s.as_ref().clone();
                next.compaction = AgentField::Value(step.state);
                return Ok(Step::new(Rc::new(next), commands));
            }
            if has("resilient:retry:$tool:") || has("resilient:deadline:$tool:") {
                return Err(AgentError::UnsupportedRestoredProfile {
                    profile: OptionalProfile::ToolResilience,
                    keys: vec![msg.id.clone()],
                });
            }
            let step = self.config.llm.on_timer(&s.resilience, msg)?;
            let mut next = s.as_ref().clone();
            next.resilience = step.state;
            Ok(Step::new(
                Rc::new(next),
                step.commands.into_iter().map(AgentCommand::Brain).collect(),
            ))
        })
    }
    pub fn subs(
        &self,
        s: &StateOf<Stage, P, I, S, R, TE, A, T, V, K>,
    ) -> Result<Vec<Deadline>, AgentError> {
        self.supported(s)?;
        if !matches!(s.compaction, AgentField::Value(_)) {
            return Err(AgentError::UnsupportedRestoredProfile {
                profile: OptionalProfile::MissingCompaction,
                keys: vec![],
            });
        }
        let mut list = self.config.llm.deadlines(&s.resilience);
        list.extend(self.compact.deadlines(self.compact_slice(s)?));
        list.extend(self.run.deadlines(&s.run));
        Ok(list)
    }
    pub fn current_stage(
        &self,
        s: &StateOf<Stage, P, I, S, R, TE, A, T, V, K>,
    ) -> Option<Rc<Stage>> {
        s.current_stage()
    }
    pub fn is_settled(&self, s: &StateOf<Stage, P, I, S, R, TE, A, T, V, K>) -> bool {
        s.is_settled()
    }
}
impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    A,
    T,
    Provider,
    C: Tagged,
    V: CallSource<A>,
    K: CompactionProfile,
> Agent<'a, Stage, P, I, S, R, PlainData, A, T, Provider, C, V, K>
{
    pub fn tool_err_reason(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, PlainData, A, T, V, K>,
        id: impl Into<JsText>,
        reason: impl Into<JsText>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, PlainData, A, T, C, V, K> {
        let fields = [
            ("kind".into(), PlainData::String("error".into())),
            ("reason".into(), PlainData::String(reason.into())),
        ]
        .into_iter()
        .collect();
        self.tool_err(s, id, Rc::new(PlainData::Object(fields)), at)
    }
}

pub struct CompactionConfigError<C, P> {
    pub config: Box<C>,
    pub policy: Box<P>,
}
impl<C, P> std::fmt::Debug for CompactionConfigError<C, P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("select compaction before configuring stop_when")
    }
}
impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    TE,
    A,
    T,
    Provider,
    C: Tagged,
    V: CallSource<A>,
> AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V>
{
    /// Select compaction before a state-dependent stop predicate. A refusal
    /// retains both original owners instead of reprojecting a different state.
    pub fn with_compaction<CI, CO, CE>(
        self,
        policy: CompactionPolicy<'a, Conversation<R, T, TE, A, V>, T, CI, CO, CE>,
    ) -> Result<
        AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, WithCompaction<CI, CO, CE>>,
        CompactionConfigError<
            Self,
            CompactionPolicy<'a, Conversation<R, T, TE, A, V>, T, CI, CO, CE>,
        >,
    > {
        if self.stop_when.is_some() {
            return Err(CompactionConfigError {
                config: Box::new(self),
                policy: Box::new(policy),
            });
        }
        Ok(AgentConfig {
            llm: self.llm,
            stages: self.stages,
            turn_of: self.turn_of,
            payload_of: self.payload_of,
            tool_of: self.tool_of,
            turn_view: self.turn_view,
            instructions: self.instructions,
            model_id: self.model_id,
            deadline_ms: self.deadline_ms,
            tool_concurrency: self.tool_concurrency,
            max_turns: self.max_turns,
            max_elapsed_ms: self.max_elapsed_ms,
            stop_when: None,
            compaction: Some(policy),
        })
    }
}

impl<
    'a,
    Stage,
    P: Purpose,
    I,
    S: Schema<Output = Rc<T>> + ?Sized,
    R,
    TE,
    A,
    T,
    Provider,
    C: Tagged,
    V: CallSource<A>,
    K: CompactionProfile,
> Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C, V, K>
{
    fn compaction_call(
        &self,
        conv: &Rc<Conversation<R, T, TE, A, V>>,
        folding: AgentNumber,
    ) -> Result<Rc<Request<CompactionPurpose, K::Input>>, AgentError> {
        let policy =
            self.config
                .compaction
                .as_ref()
                .ok_or(AgentError::UnsupportedRestoredProfile {
                    profile: OptionalProfile::Compaction,
                    keys: vec!["$compact".into()],
                })?;
        Ok(Rc::new(Request::new(
            CompactionPurpose::Compact,
            self.config.model_id.clone(),
            (policy.payload)(conv, folding),
        )))
    }
    fn maybe_compact(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        at: f64,
    ) -> Result<MaybeStepOf<Stage, P, I, S, R, TE, A, T, C, V, K>, AgentError> {
        let Some(policy) = self.config.compaction.as_ref() else {
            return Ok(None);
        };
        let Some(conv) = s.conversation.as_ref() else {
            return Ok(None);
        };
        let folding = crate::js_math::min((policy.plan)(conv), conv.turns.len() as f64);
        if folding < 2.0 {
            return Ok(None);
        }
        let run = self.run_state(self.run.progress(&s.run, Rc::new(()), at))?;
        let input = self.compaction_call(conv, folding.into())?;
        let step = self
            .compact
            .attempt(
                self.compact_slice(s)?,
                "$compact",
                CallValue::shared(input),
                at,
            )
            .map_err(llm_call::LlmCallError::from)?;
        let commands = self.compact_commands(step.commands)?;
        let mut compacting = conv.as_ref().clone();
        compacting.awaiting = Awaiting::Compacting {
            folding: folding.into(),
        };
        let mut next = s.as_ref().clone();
        next.run = run;
        next.conversation = Some(Rc::new(compacting));
        next.compaction = AgentField::Value(step.state);
        Ok(Some(Step::new(Rc::new(next), commands)))
    }
    fn compact_slice<'s>(
        &self,
        s: &'s StateOf<Stage, P, I, S, R, TE, A, T, V, K>,
    ) -> Result<&'s CompactState<K>, AgentError> {
        s.compaction
            .value()
            .ok_or(AgentError::UnsupportedRestoredProfile {
                profile: OptionalProfile::MissingCompaction,
                keys: vec![],
            })
    }
    fn compact_commands(
        &self,
        commands: Vec<
            crate::resilience::resilient_call::RunCommand<
                Request<CompactionPurpose, K::Input>,
                LlmOk<CompactionPurpose, K::Output>,
                LlmErr<CompactionPurpose, K::Error>,
            >,
        >,
    ) -> Result<Vec<CommandOf<P, I, S, C, K>>, AgentError> {
        commands
            .into_iter()
            .map(|command| {
                let input = command.into_input();
                let CallValue::Shared(request) = input.input else {
                    return Err(AgentError::MissingCompactionInput);
                };
                K::command(crate::agent::compaction::CompactRun::new(
                    input.key, request,
                ))
                .map(AgentCommand::Compact)
            })
            .collect()
    }
    pub fn compact_ok(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        key: &JsText,
        msg: &crate::agent::compaction::CompactOk<K::Output>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, at.into(), |s| {
            use crate::resilience::resilient_call::SettleInput;
            let settled = self
                .compact
                .settle(
                    self.compact_slice(s)?,
                    SettleInput::Ok {
                        key: key.clone(),
                        value: CallValue::shared(Rc::clone(&msg.result)),
                        at: msg.at.into(),
                    },
                )
                .map_err(llm_call::LlmCallError::from)?;
            let commands = self.compact_commands(settled.commands)?;
            let mut next = s.as_ref().clone();
            next.compaction = AgentField::Value(settled.call);
            let next = Rc::new(next);
            let Some(conv) = next.require_awaiting(AwaitingKind::Compacting) else {
                return Ok(Step::new(next, commands));
            };
            let Awaiting::Compacting { folding } = conv.awaiting else {
                return Ok(Step::new(next, commands));
            };
            let policy =
                self.config
                    .compaction
                    .as_ref()
                    .ok_or(AgentError::UnsupportedRestoredProfile {
                        profile: OptionalProfile::Compaction,
                        keys: vec![key.clone()],
                    })?;
            let summary =
                (policy.summary_turn)(&msg.result.output).map_err(AgentError::Compaction)?;
            let mut folded = next.as_ref().clone();
            folded.conversation = Some(Rc::new(
                crate::agent::conversation::fold_summary_with_calls(
                    conv,
                    folding.number_or_zero(),
                    summary,
                ),
            ));
            let mut fired = self.fire_brain(&Rc::new(folded), at)?;
            let mut all = commands;
            all.append(&mut fired.commands);
            fired.commands = all;
            Ok(fired)
        })
    }
    pub fn compact_err(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T, V, K>,
        key: &JsText,
        msg: &crate::agent::compaction::CompactErr<K::Error>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C, V, K> {
        self.transition(s, at.into(), |s| {
            use crate::resilience::resilient_call::{CallFailure, SettleInput, SettleOutcome};
            let settled = self
                .compact
                .settle(
                    self.compact_slice(s)?,
                    SettleInput::Err {
                        key: key.clone(),
                        error: Rc::new(CallFailure::External(Rc::clone(&msg.error))),
                        at: msg.at.into(),
                    },
                )
                .map_err(llm_call::LlmCallError::from)?;
            let commands = self.compact_commands(settled.commands)?;
            let mut next = s.as_ref().clone();
            next.compaction = AgentField::Value(settled.call);
            let next = Rc::new(next);
            if matches!(settled.outcome, SettleOutcome::Retrying) {
                return Ok(Step::new(next, commands));
            }
            let Some(conv) = next.require_awaiting(AwaitingKind::Compacting) else {
                return Ok(Step::new(next, commands));
            };
            let mut conversation = conv.as_ref().clone();
            conversation.awaiting = Awaiting::Llm;
            let mut resumed = next.as_ref().clone();
            resumed.conversation = Some(Rc::new(conversation));
            let mut fired = self.fire_brain(&Rc::new(resumed), at)?;
            let mut all = commands;
            all.append(&mut fired.commands);
            fired.commands = all;
            Ok(fired)
        })
    }
}
impl<C, P> std::fmt::Display for CompactionConfigError<C, P> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(self, f)
    }
}
impl<C, P> std::error::Error for CompactionConfigError<C, P> {}
