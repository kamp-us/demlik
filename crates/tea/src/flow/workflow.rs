//! Workflow transitions and their owed-effect log. Transport acknowledgements
//! (`workflow_activity_ok`) are separate from business results (`activity_ok`).
mod wire;
pub use crate::durable_effects::{
    DeliveryId, EffectConfirmed, EffectLedgerEvent, EffectOwed, LedgerRestore, empty_ledger,
};
use crate::durable_effects::{PendingEffectsRecorder, pending_effects_ledger};
pub use crate::work_queue::QueueField as WorkflowValue;
pub use crate::work_queue::QueueTime as WorkflowIndex;
use crate::{
    PlainData, Tagged,
    command::{Cmd, CmdDef, CommandRecord, CommandSpec, Issue, SchemaError},
    data::{JsText, structural_hash},
};
use serde::Serialize;
use serde_json::Value;
use std::{fmt, marker::PhantomData, rc::Rc};

pub const WORKFLOW_STATUSES: [&str; 6] = [
    "running",
    "completed",
    "failed",
    "compensating",
    "failed_compensated",
    "compensation_failed",
];
pub const WORKFLOW_MSG_TYPES: [&str; 4] = [
    "activity_ok",
    "activity_err",
    "compensation_ok",
    "compensation_err",
];

fn assigned<T>(value: &WorkflowValue<Rc<T>>) -> WorkflowValue<Rc<T>> {
    match value {
        WorkflowValue::Value(value) => WorkflowValue::Value(Rc::clone(value)),
        WorkflowValue::Absent | WorkflowValue::Undefined => WorkflowValue::Undefined,
    }
}
pub struct WorkflowStep<A> {
    pub name: JsText,
    pub activity: WorkflowValue<Rc<A>>,
    pub compensation: WorkflowValue<Rc<A>>,
}
impl<A> WorkflowStep<A> {
    pub fn new(name: impl Into<JsText>, activity: Rc<A>) -> Self {
        Self {
            name: name.into(),
            activity: WorkflowValue::Value(activity),
            compensation: WorkflowValue::Absent,
        }
    }
    /// `Absent` and `Undefined` skip rollback; `Value` declares an inverse,
    /// including a present null payload. The slot owns that distinction for
    /// opaque payloads, without a serde or runtime type-inspection bound.
    pub fn with_compensation(mut self, compensation: WorkflowValue<Rc<A>>) -> Self {
        self.compensation = compensation;
        self
    }
}
/// A workflow has a first step, including when its payload is local and opaque.
/// ```
/// use demlik_tea::flow::workflow::{WorkflowStep, WorkflowSteps};
/// use std::rc::Rc;
/// struct Payload(Box<u32>);
/// let steps = WorkflowSteps::new(Rc::new(WorkflowStep::new("first", Rc::new(Payload(Box::new(1))))), []);
/// assert_eq!(steps.as_slice().len(), 1);
/// ```
/// ```compile_fail
/// use demlik_tea::flow::workflow::WorkflowSteps;
/// let empty = WorkflowSteps::<u32>::new();
/// ```
pub struct WorkflowSteps<A>(Rc<Vec<Rc<WorkflowStep<A>>>>);
impl<A> WorkflowSteps<A> {
    pub fn new(
        first: Rc<WorkflowStep<A>>,
        rest: impl IntoIterator<Item = Rc<WorkflowStep<A>>>,
    ) -> Self {
        let mut steps = vec![first];
        steps.extend(rest);
        Self(Rc::new(steps))
    }
    pub fn as_slice(&self) -> &[Rc<WorkflowStep<A>>] {
        &self.0
    }
}
pub struct CompletedStep<A, R> {
    pub step: Rc<WorkflowStep<A>>,
    pub result: WorkflowValue<Rc<R>>,
}
pub struct InFlightActivity<A> {
    pub index: WorkflowIndex,
    pub step: Rc<WorkflowStep<A>>,
    pub id: DeliveryId,
}
pub type InFlightCompensation<A> = InFlightActivity<A>;
pub struct WorkflowFailure<A, F> {
    pub failed_step: Rc<WorkflowStep<A>>,
    pub failure: WorkflowValue<Rc<F>>,
}
impl<A, F> WorkflowFailure<A, F> {
    fn assigned(&self) -> Rc<Self> {
        Rc::new(Self {
            failed_step: Rc::clone(&self.failed_step),
            failure: assigned(&self.failure),
        })
    }
}
pub enum WorkflowPhase<A, R, F> {
    Running {
        current: Rc<InFlightActivity<A>>,
    },
    Completed {
        output: WorkflowValue<Rc<R>>,
    },
    Failed {
        failure: Rc<WorkflowFailure<A, F>>,
    },
    Compensating {
        failure: Rc<WorkflowFailure<A, F>>,
        current: Rc<InFlightCompensation<A>>,
        compensated: Rc<Vec<Rc<CompletedStep<A, R>>>>,
    },
    FailedCompensated {
        failure: Rc<WorkflowFailure<A, F>>,
    },
    CompensationFailed {
        failure: Rc<WorkflowFailure<A, F>>,
        compensated: Rc<Vec<Rc<CompletedStep<A, R>>>>,
        failed_compensation_step: Rc<WorkflowStep<A>>,
        compensation_failure: WorkflowValue<Rc<F>>,
    },
}
impl<A, R, F> WorkflowPhase<A, R, F> {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running { .. } => "running",
            Self::Completed { .. } => "completed",
            Self::Failed { .. } => "failed",
            Self::Compensating { .. } => "compensating",
            Self::FailedCompensated { .. } => "failed_compensated",
            Self::CompensationFailed { .. } => "compensation_failed",
        }
    }
}
pub struct WorkflowState<A, R, F> {
    pub status: WorkflowPhase<A, R, F>,
    pub steps: Rc<Vec<Rc<WorkflowStep<A>>>>,
    pub completed: Rc<Vec<Rc<CompletedStep<A, R>>>>,
}
impl<A, R, F> WorkflowState<A, R, F> {
    pub fn current(&self) -> Option<&InFlightActivity<A>> {
        match &self.status {
            WorkflowPhase::Running { current } | WorkflowPhase::Compensating { current, .. } => {
                Some(current)
            }
            _ => None,
        }
    }
}
impl<A, R, F> Tagged for WorkflowState<A, R, F> {
    fn tag(&self) -> &str {
        self.status.as_str()
    }
}

pub struct WorkflowActivityInput<A> {
    pub index: WorkflowIndex,
    pub id: DeliveryId,
    pub activity: WorkflowValue<Rc<A>>,
}
impl<A> CommandRecord for WorkflowActivityInput<A> {}
pub struct WorkflowCompensationInput<A> {
    pub index: WorkflowIndex,
    pub id: DeliveryId,
    pub compensation: WorkflowValue<Rc<A>>,
}
impl<A> CommandRecord for WorkflowCompensationInput<A> {}
#[derive(Debug, Serialize, serde::Deserialize)]
pub enum WorkflowTransportFailure {}
impl Tagged for WorkflowTransportFailure {
    fn tag(&self) -> &str {
        match *self {}
    }
}
pub struct WorkflowActivitySpec<A>(PhantomData<fn() -> A>);
impl<A> CommandSpec for WorkflowActivitySpec<A> {
    type Input = WorkflowActivityInput<A>;
    type RawOutput = PlainData;
    type Output = PlainData;
    type Error = WorkflowTransportFailure;
    const NAME: &'static str = "workflow_activity";
    const ERROR_TAGS: &'static [&'static str] = &[];
    fn parse_input(_: Value) -> Result<Self::Input, SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "workflow activity needs a caller-owned decoder",
        )]))
    }
    fn parse_output(value: PlainData) -> Result<PlainData, SchemaError> {
        crate::schema::undefined_only(value)
    }
    fn missing_output() -> Option<PlainData> {
        Some(PlainData::Undefined)
    }
}
pub struct WorkflowCompensationSpec<A>(PhantomData<fn() -> A>);
impl<A> CommandSpec for WorkflowCompensationSpec<A> {
    type Input = WorkflowCompensationInput<A>;
    type RawOutput = PlainData;
    type Output = PlainData;
    type Error = WorkflowTransportFailure;
    const NAME: &'static str = "workflow_compensation";
    const ERROR_TAGS: &'static [&'static str] = &[];
    fn parse_input(_: Value) -> Result<Self::Input, SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "workflow compensation needs a caller-owned decoder",
        )]))
    }
    fn parse_output(value: PlainData) -> Result<PlainData, SchemaError> {
        crate::schema::undefined_only(value)
    }
    fn missing_output() -> Option<PlainData> {
        Some(PlainData::Undefined)
    }
}
pub type ActivityCmd<A> = Cmd<WorkflowActivitySpec<A>>;
pub type CompensationCmd<A> = Cmd<WorkflowCompensationSpec<A>>;
pub fn workflow_activity_def<A>() -> CmdDef<WorkflowActivitySpec<A>> {
    CmdDef::new()
}
pub fn workflow_compensation_def<A>() -> CmdDef<WorkflowCompensationSpec<A>> {
    CmdDef::new()
}
pub enum WorkflowCmd<A> {
    Activity(ActivityCmd<A>),
    Compensation(CompensationCmd<A>),
}
impl<A> Tagged for WorkflowCmd<A> {
    fn tag(&self) -> &str {
        match self {
            Self::Activity(command) => command.tag(),
            Self::Compensation(command) => command.tag(),
        }
    }
}
pub struct ActivityOk<R> {
    pub id: DeliveryId,
    pub result: WorkflowValue<Rc<R>>,
}
impl<R> ActivityOk<R> {
    pub fn new(id: DeliveryId, result: Rc<R>) -> Self {
        Self {
            id,
            result: WorkflowValue::Value(result),
        }
    }
}
pub struct ActivityErr<F> {
    pub id: DeliveryId,
    pub failure: WorkflowValue<Rc<F>>,
}
impl<F> ActivityErr<F> {
    pub fn new(id: DeliveryId, failure: Rc<F>) -> Self {
        Self {
            id,
            failure: WorkflowValue::Value(failure),
        }
    }
}
pub struct CompensationOk {
    pub id: DeliveryId,
}
pub struct CompensationErr<F> {
    pub id: DeliveryId,
    pub failure: WorkflowValue<Rc<F>>,
}
impl<F> CompensationErr<F> {
    pub fn new(id: DeliveryId, failure: Rc<F>) -> Self {
        Self {
            id,
            failure: WorkflowValue::Value(failure),
        }
    }
}
pub enum WorkflowMsg<R, F> {
    ActivityOk(ActivityOk<R>),
    ActivityErr(ActivityErr<F>),
    CompensationOk(CompensationOk),
    CompensationErr(CompensationErr<F>),
}
impl<R, F> Tagged for WorkflowMsg<R, F> {
    fn tag(&self) -> &str {
        match self {
            Self::ActivityOk(_) => "activity_ok",
            Self::ActivityErr(_) => "activity_err",
            Self::CompensationOk(_) => "compensation_ok",
            Self::CompensationErr(_) => "compensation_err",
        }
    }
}
impl<R, F> crate::core::Message for WorkflowMsg<R, F> {
    const TYPES: &'static [&'static str] = &WORKFLOW_MSG_TYPES;
}
impl<R, F> AsRef<Self> for WorkflowMsg<R, F> {
    fn as_ref(&self) -> &Self {
        self
    }
}
pub struct WorkflowReducerStep<A, R, F> {
    pub state: Rc<WorkflowState<A, R, F>>,
    pub ledger: Vec<Rc<EffectLedgerEvent<WorkflowCmd<A>>>>,
    pub cmds: Vec<Rc<WorkflowCmd<A>>>,
}
impl<A, R, F> WorkflowReducerStep<A, R, F> {
    fn inert(state: &Rc<WorkflowState<A, R, F>>) -> Self {
        Self {
            state: Rc::clone(state),
            ledger: vec![],
            cmds: vec![],
        }
    }
}
#[derive(Debug)]
pub enum WorkflowError {
    StepBounds {
        index: WorkflowIndex,
        len: usize,
    },
    CompensationBounds {
        index: WorkflowIndex,
    },
    DeliveryDiverged {
        predicted: DeliveryId,
        issued: DeliveryId,
    },
}
fn number_text(number: WorkflowIndex) -> String {
    structural_hash(&number.number().map_or(PlainData::Null, PlainData::Number))
}
impl fmt::Display for WorkflowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StepBounds { index, len } => write!(
                f,
                "createWorkflow: step index {} out of range (length {len}) — a reducer bounds proof was violated.",
                number_text(*index)
            ),
            Self::CompensationBounds { index } => write!(
                f,
                "createWorkflow.onCompensationOk: compensation index {} has no completed step — a reverse-walk bounds proof was violated.",
                number_text(*index)
            ),
            Self::DeliveryDiverged { predicted, issued } => write!(
                f,
                "createWorkflow: delivery-id prediction ({}) diverged from the recorder's issued id ({}). The #67 recorder's monotonic counter is not gap-free as assumed — this is a substrate invariant violation, not a recoverable condition.",
                number_text(*predicted),
                number_text(*issued)
            ),
        }
    }
}
impl std::error::Error for WorkflowError {}
pub struct Workflow<A, R, F> {
    recorder: PendingEffectsRecorder<WorkflowCmd<A>>,
    activity: CmdDef<WorkflowActivitySpec<A>>,
    compensation: CmdDef<WorkflowCompensationSpec<A>>,
    types: PhantomData<fn() -> (R, F)>,
}
pub fn create_workflow<A, R, F>(restore: LedgerRestore<WorkflowCmd<A>>) -> Workflow<A, R, F> {
    Workflow {
        recorder: pending_effects_ledger(restore),
        activity: workflow_activity_def(),
        compensation: workflow_compensation_def(),
        types: PhantomData,
    }
}
fn array_index(index: WorkflowIndex, len: usize) -> Option<usize> {
    index
        .number()
        .filter(|index| *index >= 0.0 && index.fract() == 0.0 && *index < len as f64)
        .map(|index| index as usize)
}
type Owed<A> = (
    Rc<InFlightActivity<A>>,
    Rc<EffectLedgerEvent<WorkflowCmd<A>>>,
    Rc<WorkflowCmd<A>>,
);
type Issued<A> = (
    DeliveryId,
    Rc<EffectLedgerEvent<WorkflowCmd<A>>>,
    Rc<WorkflowCmd<A>>,
);
impl<A, R, F> Workflow<A, R, F> {
    fn owe_command(
        &self,
        build: impl FnOnce(DeliveryId) -> WorkflowCmd<A>,
    ) -> Result<Issued<A>, WorkflowError> {
        let id: DeliveryId = (self.recorder.last_id() + 1.0).into();
        let cmd = Rc::new(build(id));
        let issued = self.recorder.owe(Rc::clone(&cmd));
        if issued.id != id {
            return Err(WorkflowError::DeliveryDiverged {
                predicted: id,
                issued: issued.id,
            });
        }
        Ok((id, issued.event, cmd))
    }
    fn owe_activity(
        &self,
        step: Rc<WorkflowStep<A>>,
        index: WorkflowIndex,
    ) -> Result<Owed<A>, WorkflowError> {
        let (id, event, cmd) = self.owe_command(|id| {
            WorkflowCmd::Activity(self.activity.from_record(WorkflowActivityInput {
                index,
                id,
                activity: assigned(&step.activity),
            }))
        })?;
        Ok((Rc::new(InFlightActivity { index, step, id }), event, cmd))
    }
    fn owe_compensation(
        &self,
        step: Rc<WorkflowStep<A>>,
        index: WorkflowIndex,
    ) -> Result<Owed<A>, WorkflowError> {
        let (id, event, cmd) = self.owe_command(|id| {
            WorkflowCmd::Compensation(self.compensation.from_record(WorkflowCompensationInput {
                index,
                id,
                compensation: assigned(&step.compensation),
            }))
        })?;
        Ok((Rc::new(InFlightActivity { index, step, id }), event, cmd))
    }
    fn next_compensation(
        &self,
        completed: &[Rc<CompletedStep<A, R>>],
        below: usize,
    ) -> Result<Option<Owed<A>>, WorkflowError> {
        for index in (0..below).rev() {
            if let Some(entry) = completed.get(index) {
                if matches!(entry.step.compensation, WorkflowValue::Value(_)) {
                    return self
                        .owe_compensation(Rc::clone(&entry.step), (index as f64).into())
                        .map(Some);
                }
            }
        }
        Ok(None)
    }
    fn continue_compensating(
        &self,
        state: &WorkflowState<A, R, F>,
        failure: Rc<WorkflowFailure<A, F>>,
        compensated: Rc<Vec<Rc<CompletedStep<A, R>>>>,
        next: Owed<A>,
        confirmed: Rc<EffectLedgerEvent<WorkflowCmd<A>>>,
    ) -> WorkflowReducerStep<A, R, F> {
        let (current, owed, cmd) = next;
        WorkflowReducerStep {
            state: Rc::new(WorkflowState {
                status: WorkflowPhase::Compensating {
                    failure: failure.assigned(),
                    current,
                    compensated,
                },
                steps: Rc::clone(&state.steps),
                completed: Rc::clone(&state.completed),
            }),
            ledger: vec![confirmed, owed],
            cmds: vec![cmd],
        }
    }
    pub fn init(
        &self,
        steps: &WorkflowSteps<A>,
    ) -> Result<WorkflowReducerStep<A, R, F>, WorkflowError> {
        let (current, owed, cmd) = self.owe_activity(Rc::clone(&steps.0[0]), 0.0.into())?;
        Ok(WorkflowReducerStep {
            state: Rc::new(WorkflowState {
                status: WorkflowPhase::Running { current },
                steps: Rc::clone(&steps.0),
                completed: Rc::new(vec![]),
            }),
            ledger: vec![owed],
            cmds: vec![cmd],
        })
    }
    pub fn on_activity_ok(
        &self,
        state: &Rc<WorkflowState<A, R, F>>,
        msg: &ActivityOk<R>,
    ) -> Result<WorkflowReducerStep<A, R, F>, WorkflowError> {
        let WorkflowPhase::Running { current } = &state.status else {
            return Ok(WorkflowReducerStep::inert(state));
        };
        if msg.id != current.id {
            return Ok(WorkflowReducerStep::inert(state));
        }
        let confirmed = self.recorder.confirm(current.id).event;
        let mut completed = state.completed.as_ref().clone();
        completed.push(Rc::new(CompletedStep {
            step: Rc::clone(&current.step),
            result: assigned(&msg.result),
        }));
        let completed = Rc::new(completed);
        let next_index = current.index.number().unwrap_or(0.0) + 1.0;
        if next_index >= state.steps.len() as f64 {
            return Ok(WorkflowReducerStep {
                state: Rc::new(WorkflowState {
                    status: WorkflowPhase::Completed {
                        output: assigned(&msg.result),
                    },
                    steps: Rc::clone(&state.steps),
                    completed,
                }),
                ledger: vec![confirmed],
                cmds: vec![],
            });
        }
        let index =
            array_index(next_index.into(), state.steps.len()).ok_or(WorkflowError::StepBounds {
                index: next_index.into(),
                len: state.steps.len(),
            })?;
        let (current, owed, cmd) =
            self.owe_activity(Rc::clone(&state.steps[index]), next_index.into())?;
        Ok(WorkflowReducerStep {
            state: Rc::new(WorkflowState {
                status: WorkflowPhase::Running { current },
                steps: Rc::clone(&state.steps),
                completed,
            }),
            ledger: vec![confirmed, owed],
            cmds: vec![cmd],
        })
    }
    pub fn on_activity_err(
        &self,
        state: &Rc<WorkflowState<A, R, F>>,
        msg: &ActivityErr<F>,
    ) -> Result<WorkflowReducerStep<A, R, F>, WorkflowError> {
        let WorkflowPhase::Running { current } = &state.status else {
            return Ok(WorkflowReducerStep::inert(state));
        };
        if msg.id != current.id {
            return Ok(WorkflowReducerStep::inert(state));
        }
        let confirmed = self.recorder.confirm(current.id).event;
        let next = self.next_compensation(&state.completed, state.completed.len())?;
        let failure = Rc::new(WorkflowFailure {
            failed_step: Rc::clone(&current.step),
            failure: assigned(&msg.failure),
        });
        if let Some(next) = next {
            return Ok(self.continue_compensating(
                state,
                failure,
                Rc::new(vec![]),
                next,
                confirmed,
            ));
        }
        Ok(WorkflowReducerStep {
            state: Rc::new(WorkflowState {
                status: WorkflowPhase::Failed { failure },
                steps: Rc::clone(&state.steps),
                completed: Rc::clone(&state.completed),
            }),
            ledger: vec![confirmed],
            cmds: vec![],
        })
    }
    pub fn on_compensation_ok(
        &self,
        state: &Rc<WorkflowState<A, R, F>>,
        msg: &CompensationOk,
    ) -> Result<WorkflowReducerStep<A, R, F>, WorkflowError> {
        let WorkflowPhase::Compensating {
            current,
            failure,
            compensated,
        } = &state.status
        else {
            return Ok(WorkflowReducerStep::inert(state));
        };
        if msg.id != current.id {
            return Ok(WorkflowReducerStep::inert(state));
        }
        let confirmed = self.recorder.confirm(current.id).event;
        let index = array_index(current.index, state.completed.len()).ok_or(
            WorkflowError::CompensationBounds {
                index: current.index,
            },
        )?;
        let mut undone = compensated.as_ref().clone();
        undone.push(Rc::clone(&state.completed[index]));
        let compensated = Rc::new(undone);
        if let Some(next) = self.next_compensation(&state.completed, index)? {
            return Ok(self.continue_compensating(
                state,
                Rc::clone(failure),
                compensated,
                next,
                confirmed,
            ));
        }
        Ok(WorkflowReducerStep {
            state: Rc::new(WorkflowState {
                status: WorkflowPhase::FailedCompensated {
                    failure: failure.assigned(),
                },
                steps: Rc::clone(&state.steps),
                completed: Rc::clone(&state.completed),
            }),
            ledger: vec![confirmed],
            cmds: vec![],
        })
    }
    pub fn on_compensation_err(
        &self,
        state: &Rc<WorkflowState<A, R, F>>,
        msg: &CompensationErr<F>,
    ) -> Result<WorkflowReducerStep<A, R, F>, WorkflowError> {
        let WorkflowPhase::Compensating {
            current,
            failure,
            compensated,
        } = &state.status
        else {
            return Ok(WorkflowReducerStep::inert(state));
        };
        if msg.id != current.id {
            return Ok(WorkflowReducerStep::inert(state));
        }
        let confirmed = self.recorder.confirm(current.id).event;
        Ok(WorkflowReducerStep {
            state: Rc::new(WorkflowState {
                status: WorkflowPhase::CompensationFailed {
                    failure: failure.assigned(),
                    compensated: Rc::clone(compensated),
                    failed_compensation_step: Rc::clone(&current.step),
                    compensation_failure: assigned(&msg.failure),
                },
                steps: Rc::clone(&state.steps),
                completed: Rc::clone(&state.completed),
            }),
            ledger: vec![confirmed],
            cmds: vec![],
        })
    }
    pub fn surviving_activities<I>(&self, events: I) -> Vec<Rc<WorkflowCmd<A>>>
    where
        I: IntoIterator,
        I::Item: AsRef<EffectLedgerEvent<WorkflowCmd<A>>>,
    {
        crate::durable_effects::surviving_effects(&crate::durable_effects::fold_ledger(events))
            .into_iter()
            .map(|owed| owed.effect)
            .collect()
    }
}

pub fn route_workflow_msg<A, R, F>(
    workflow: &Workflow<A, R, F>,
    state: &Rc<WorkflowState<A, R, F>>,
    message: &WorkflowMsg<R, F>,
) -> Result<WorkflowReducerStep<A, R, F>, WorkflowError> {
    match message {
        WorkflowMsg::ActivityOk(message) => workflow.on_activity_ok(state, message),
        WorkflowMsg::ActivityErr(message) => workflow.on_activity_err(state, message),
        WorkflowMsg::CompensationOk(message) => workflow.on_compensation_ok(state, message),
        WorkflowMsg::CompensationErr(message) => workflow.on_compensation_err(state, message),
    }
}
pub fn fold_workflow<A, R, F, I>(
    steps: &WorkflowSteps<A>,
    messages: I,
) -> Result<Rc<WorkflowState<A, R, F>>, WorkflowError>
where
    I: IntoIterator,
    I::Item: AsRef<WorkflowMsg<R, F>>,
{
    let workflow = create_workflow(Default::default());
    let mut state = workflow.init(steps)?.state;
    for message in messages {
        state = route_workflow_msg(&workflow, &state, message.as_ref())?.state;
    }
    Ok(state)
}
