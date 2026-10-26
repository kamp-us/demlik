//! Base pure agent knob over the canonical run, brain and tool ledgers.
//! Optional snapshot/compaction/tool-policy and Runtime wiring are separate profiles.
use crate::{
    PlainData, Tagged,
    agent::{
        compaction::{CompactionPurpose, CompactionSummary},
        conversation::shared_no_usage,
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
pub use command::AgentCommand;
pub use error::{AgentError, OptionalProfile};
pub type CommandOf<P, I, S, C> = AgentCommand<P, I, <S as Schema>::Output, <S as Schema>::Error, C>;
pub type StepOf<Stage, P, I, S, R, TE, A, T, C> =
    crate::Step<SharedStateOf<Stage, P, I, S, R, TE, A, T>, CommandOf<P, I, S, C>>;
type MaybeStepOf<Stage, P, I, S, R, TE, A, T, C> = Option<StepOf<Stage, P, I, S, R, TE, A, T, C>>;
type ResultOf<Stage, P, I, S, R, TE, A, T, C> =
    Result<StepOf<Stage, P, I, S, R, TE, A, T, C>, AgentError>;
type StopWhen<'a, Stage, P, I, S, R, TE, A, T> =
    Option<Box<dyn Fn(&SharedStateOf<Stage, P, I, S, R, TE, A, T>) -> bool + 'a>>;

pub type StateOf<Stage, P, I, S, R, TE, A, T> = AgentState<
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
    PlainData,
    CompactionSummary,
    PlainData,
    LlmErr<P, <S as Schema>::Error>,
>;
/// Retained state returned by the pure agent verbs.
pub type SharedStateOf<Stage, P, I, S, R, TE, A, T> = Rc<StateOf<Stage, P, I, S, R, TE, A, T>>;
pub type BrainCommandOf<P, I, S> =
    llm_call::RunCmd<P, I, <S as Schema>::Output, <S as Schema>::Error>;
pub type BrainMessageOf<P, I, S> =
    llm_call::LlmMsg<P, I, <S as Schema>::Output, <S as Schema>::Error>;
type StageOf<'s, S> = Option<&'s Rc<S>>;
type TurnOf<'a, S, P> = Box<dyn Fn(StageOf<'_, S>) -> P + 'a>;
type PayloadOf<'a, Stage, R, T, TE, A, I> =
    Box<dyn Fn(StageOf<'_, Stage>, &Rc<Conversation<R, T, TE, A>>, Option<&JsText>) -> I + 'a>;
type ToolOf<'a, A, C> = Rc<dyn Fn(&Rc<ToolCall<A>>) -> C + 'a>;
pub type TurnView<T, A, Provider> = for<'t> fn(&'t T) -> &'t AgentTurn<A, Provider>;

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
> {
    llm: Rc<LlmCall<'a, P, I, S>>,
    stages: Vec<Rc<Stage>>,
    turn_of: TurnOf<'a, Stage, P>,
    payload_of: PayloadOf<'a, Stage, R, T, TE, A, I>,
    tool_of: ToolOf<'a, A, C>,
    turn_view: TurnView<T, A, Provider>,
    instructions: Option<JsText>,
    model_id: Option<JsText>,
    deadline_ms: Option<f64>,
    tool_concurrency: f64,
    max_turns: Option<f64>,
    max_elapsed_ms: Option<f64>,
    stop_when: StopWhen<'a, Stage, P, I, S, R, TE, A, T>,
}
impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>> + ?Sized, R, TE, A, T, Provider, C: Tagged>
    AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C>
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
        predicate: impl Fn(&SharedStateOf<Stage, P, I, S, R, TE, A, T>) -> bool + 'a,
    ) -> Self {
        self.stop_when = Some(Box::new(predicate));
        self
    }
    pub fn deadline_ms(mut self, ms: f64) -> Self {
        self.deadline_ms = Some(ms);
        self
    }
}

pub struct Agent<'a, Stage, P, I, S: Schema<Output = Rc<T>> + ?Sized, R, TE, A, T, Provider, C> {
    config: AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C>,
    run: MonitoredRun<Stage, ()>,
    fan: FanOut<'a, ToolCall<A>, ToolOutcome<R, TE>, C, TE>,
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
>(
    config: AgentConfig<'a, Stage, P, I, S, R, TE, A, T, Provider, C>,
) -> Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C> {
    let tool = Rc::clone(&config.tool_of);
    let run = MonitoredRun::new(MonitoredRunConfig {
        stages: config.stages.clone(),
        deadline_ms: config.deadline_ms,
        ..Default::default()
    });
    let fan = FanOut::new(FanOutConfig::new(
        config.tool_concurrency,
        |call: &ToolCall<A>| call.call_id.clone(),
        move |call| tool(call),
    ));
    Agent { config, run, fan }
}
impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>> + ?Sized, R, TE, A, T, Provider, C: Tagged>
    Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C>
{
    pub fn init(&self) -> SharedStateOf<Stage, P, I, S, R, TE, A, T> {
        let compact: ResilientCall<
            '_,
            Request<CompactionPurpose, PlainData>,
            LlmOk<CompactionPurpose, CompactionSummary>,
            LlmErr<CompactionPurpose, PlainData>,
        > = ResilientCall::new(Default::default());
        Rc::new(AgentState {
            run: self.run.init(),
            resilience: self.config.llm.init(),
            tools: self.fan.init(),
            conversation: None,
            usage: AgentField::Value(Some(shared_no_usage())),
            compaction: AgentField::Value(compact.init()),
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
        state: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
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
        conversation::{add_usage, dedupe_by_call_id},
        types::{
            AgentFailure, AgentLifecycleNote, AgentNumber, Awaiting, AwaitingKind, ToolRecord,
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

type CompactState = llm_call::State<CompactionPurpose, PlainData, CompactionSummary, PlainData>;
type ToolState<A, E> = Rc<JsRecord<crate::resilience::resilient_call::State<ToolCall<A>, (), E>>>;
impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>> + ?Sized, R, TE, A, T, Provider, C: Tagged>
    Agent<'a, Stage, P, I, S, R, TE, A, T, Provider, C>
{
    fn empty_compaction(&self) -> CompactState {
        let compact: ResilientCall<
            '_,
            Request<CompactionPurpose, PlainData>,
            LlmOk<CompactionPurpose, CompactionSummary>,
            LlmErr<CompactionPurpose, PlainData>,
        > = ResilientCall::new(Default::default());
        compact.init()
    }
    fn supported(&self, s: &StateOf<Stage, P, I, S, R, TE, A, T>) -> Result<(), AgentError> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        at: AgentNumber,
        verb: impl FnOnce(
            &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C>,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        notes: Vec<AgentLifecycleNote<A, TE>>,
    ) -> SharedStateOf<Stage, P, I, S, R, TE, A, T> {
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
    fn tool_started(&self, calls: &[Rc<ToolCall<A>>], at: f64) -> Vec<AgentLifecycleNote<A, TE>> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        run_id: impl Into<JsText>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        result: Rc<T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
        self.transition(s, at.into(), |s| self.turn_body(s, result, at))
    }
    fn turn_body(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        result: Rc<T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
        let Some(conv) = s.require_awaiting(AwaitingKind::Llm) else {
            return Ok(Step::new(Rc::clone(s), vec![]));
        };
        let fields = (self.config.turn_view)(&result);
        let mut measured = conv.as_ref().clone();
        let usage = match &fields.usage {
            AgentField::Absent | AgentField::Undefined => {
                measured.context_tokens = AgentField::Value(AgentNumber(None));
                s.usage.clone()
            }
            AgentField::Value(usage) => {
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
        if fields.tool_calls.is_empty() {
            counted.conversation = Some(Rc::new(measured));
            return self.advance_stage(&Rc::new(counted), result, at);
        }
        let batch = dedupe_by_call_id(&fields.tool_calls);
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        terminating: Rc<T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
    fn tool_slice(&self, s: &StateOf<Stage, P, I, S, R, TE, A, T>) -> ToolState<A, TE> {
        s.tool_resilience
            .value()
            .map_or_else(|| Rc::new(JsRecord::default()), Rc::clone)
    }
    fn in_flight(
        &self,
        s: &StateOf<Stage, P, I, S, R, TE, A, T>,
        id: &JsText,
    ) -> Option<Rc<ToolCall<A>>> {
        s.tools
            .running
            .iter()
            .find(|c| c.call_id == *id)
            .map(Rc::clone)
    }
    pub fn tool_ok(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        id: impl Into<JsText>,
        result: Rc<R>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        id: impl Into<JsText>,
        failure: Rc<TE>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        id: &JsText,
        outcome: Rc<ToolOutcome<R, TE>>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
            .map(|c| c.call_id.clone())
            .collect::<HashSet<_>>();
        let launched = settled
            .state
            .running
            .iter()
            .filter(|call| !known.contains(&call.call_id))
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
        records.push(Rc::new(ToolRecord {
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
        drained.run = self.run_state(self.run.progress(&drained.run, Rc::new(()), at))?;
        let mut fired = self.fire_brain(&Rc::new(drained), at)?;
        let mut commands = launch_commands;
        commands.append(&mut fired.commands);
        fired.commands = commands;
        Ok(fired)
    }
    fn stop_conditions(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        at: f64,
    ) -> MaybeStepOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        msg: &BrainMessageOf<P, I, S>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        msg: &BrainMessageOf<P, I, S>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
        self.transition(s, at.into(), |s| Ok(self.cancel_body(s, at)))
    }
    fn cancel_body(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        at: f64,
    ) -> StepOf<Stage, P, I, S, R, TE, A, T, C> {
        let mut next = s.as_ref().clone();
        next.run = self.run.cancel(&s.run, at).state;
        Step::new(Rc::new(next), vec![])
    }
    pub fn boot(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
        s: &SharedStateOf<Stage, P, I, S, R, TE, A, T>,
        msg: &DeadlineExceeded,
    ) -> ResultOf<Stage, P, I, S, R, TE, A, T, C> {
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
                return Err(AgentError::UnsupportedRestoredProfile {
                    profile: OptionalProfile::Compaction,
                    keys: vec![msg.id.clone()],
                });
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
        s: &StateOf<Stage, P, I, S, R, TE, A, T>,
    ) -> Result<Vec<Deadline>, AgentError> {
        self.supported(s)?;
        if !matches!(s.compaction, AgentField::Value(_)) {
            return Err(AgentError::UnsupportedRestoredProfile {
                profile: OptionalProfile::MissingCompaction,
                keys: vec![],
            });
        }
        let mut list = self.config.llm.deadlines(&s.resilience);
        list.extend(self.run.deadlines(&s.run));
        Ok(list)
    }
    pub fn current_stage(&self, s: &StateOf<Stage, P, I, S, R, TE, A, T>) -> Option<Rc<Stage>> {
        s.current_stage()
    }
    pub fn is_settled(&self, s: &StateOf<Stage, P, I, S, R, TE, A, T>) -> bool {
        s.is_settled()
    }
}
impl<'a, Stage, P: Purpose, I, S: Schema<Output = Rc<T>> + ?Sized, R, A, T, Provider, C: Tagged>
    Agent<'a, Stage, P, I, S, R, PlainData, A, T, Provider, C>
{
    pub fn tool_err_reason(
        &self,
        s: &SharedStateOf<Stage, P, I, S, R, PlainData, A, T>,
        id: impl Into<JsText>,
        reason: impl Into<JsText>,
        at: f64,
    ) -> ResultOf<Stage, P, I, S, R, PlainData, A, T, C> {
        let fields = [
            ("kind".into(), PlainData::String("error".into())),
            ("reason".into(), PlainData::String(reason.into())),
        ]
        .into_iter()
        .collect();
        self.tool_err(s, id, Rc::new(PlainData::Object(fields)), at)
    }
}
