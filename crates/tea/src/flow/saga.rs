//! Every configured forward command has a mandatory inverse. QueueAdapter owns
//! the step ledger; `done` records which completed effects still need undoing.
use crate::data::JsText;
use crate::{
    PlainData, Step, Tagged,
    data::structural_hash,
    work_queue::{Queue, QueueAdapter, QueueField, QueueItemStatus, QueueOps, queue_adapter},
};
use std::{marker::PhantomData, ops::Deref, rc::Rc};
mod wire;
pub use crate::work_queue::QueueTime as StepId;
/// Both commands are required, even for borrowed or opaque payloads.
/// ```
/// use demlik_tea::flow::saga::SagaStep;
/// use std::rc::Rc;
/// let name = String::from("reserve");
/// let step = SagaStep::new(Rc::new(name.as_str()), Rc::new(Box::new(1)));
/// assert_eq!(*step.forward, "reserve");
/// ```
/// ```compile_fail
/// use demlik_tea::flow::saga::SagaStep;
/// use std::rc::Rc;
/// let irreversible = SagaStep::<u32, u32>::new(Rc::new(1));
/// ```
pub struct SagaStep<D, U> {
    pub forward: Rc<D>,
    pub undo: Rc<U>,
}
impl<D, U> SagaStep<D, U> {
    pub fn new(forward: Rc<D>, undo: Rc<U>) -> Self {
        Self { forward, undo }
    }
}
pub struct SagaConfig<D, U> {
    pub steps: Vec<SagaStep<D, U>>,
}
impl<D, U> Default for SagaConfig<D, U> {
    fn default() -> Self {
        Self { steps: vec![] }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SagaPhase {
    Idle,
    Running,
    Compensating,
    Committed,
    Aborted,
    CompensationFailed,
}
impl SagaPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Compensating => "compensating",
            Self::Committed => "committed",
            Self::Aborted => "aborted",
            Self::CompensationFailed => "compensation_failed",
        }
    }
}
pub struct SagaFields<I = StepId, F = PlainData> {
    pub position: StepId,
    pub done: Rc<Vec<StepId>>,
    pub compensating: bool,
    pub phase: SagaPhase,
    pub error: QueueField<Rc<F>>,
    pub compensation_error: QueueField<Rc<F>>,
    pub items: Queue<I>,
}
impl<I, F> Clone for SagaFields<I, F> {
    fn clone(&self) -> Self {
        Self {
            position: self.position,
            done: Rc::clone(&self.done),
            compensating: self.compensating,
            phase: self.phase,
            error: self.error.clone(),
            compensation_error: self.compensation_error.clone(),
            items: self.items.clone(),
        }
    }
}
pub struct SagaState<I = StepId, F = PlainData> {
    fields: SagaFields<I, F>,
    field_order: Vec<JsText>,
    extra: indexmap::IndexMap<JsText, Rc<PlainData>>,
}
impl<I, F> Deref for SagaState<I, F> {
    type Target = SagaFields<I, F>;
    fn deref(&self) -> &Self::Target {
        &self.fields
    }
}
impl<I, F> Clone for SagaState<I, F> {
    fn clone(&self) -> Self {
        Self {
            fields: self.fields.clone(),
            field_order: self.field_order.clone(),
            extra: self.extra.clone(),
        }
    }
}
impl<I, F> SagaState<I, F> {
    pub fn new(fields: SagaFields<I, F>) -> Self {
        let mut field_order = ["position", "done", "compensating", "phase", "items"]
            .map(JsText::from)
            .to_vec();
        if !fields.error.is_absent() {
            field_order.push("error".into());
        }
        if !fields.compensation_error.is_absent() {
            field_order.push("compensationError".into());
        }
        Self {
            fields,
            field_order,
            extra: Default::default(),
        }
    }
    pub fn extra(&self) -> &indexmap::IndexMap<JsText, Rc<PlainData>> {
        &self.extra
    }
    fn assigned(&mut self, key: &str) {
        if !self
            .field_order
            .iter()
            .any(|entry| entry.as_utf8() == Some(key))
        {
            self.field_order.push(key.into());
        }
    }
}
impl<I, F> Tagged for SagaState<I, F> {
    fn tag(&self) -> &str {
        self.phase.as_str()
    }
}
pub fn init_saga<I, F>() -> Rc<SagaState<I, F>> {
    Rc::new(SagaState::new(SagaFields {
        position: 0.0.into(),
        done: Rc::new(vec![]),
        compensating: false,
        phase: SagaPhase::Idle,
        error: QueueField::Absent,
        compensation_error: QueueField::Absent,
        items: Queue::new(),
    }))
}
pub fn is_committed<I, F>(state: &SagaState<I, F>) -> bool {
    state.phase == SagaPhase::Committed
}
pub fn is_aborted<I, F>(state: &SagaState<I, F>) -> bool {
    state.phase == SagaPhase::Aborted
}
pub fn is_compensation_failed<I, F>(state: &SagaState<I, F>) -> bool {
    state.phase == SagaPhase::CompensationFailed
}
pub fn is_settled<I, F>(state: &SagaState<I, F>) -> bool {
    matches!(
        state.phase,
        SagaPhase::Committed | SagaPhase::Aborted | SagaPhase::CompensationFailed
    )
}
pub struct Saga<D, U, F = PlainData> {
    steps: Vec<SagaStep<D, U>>,
    queue: QueueOps,
    failure: PhantomData<fn() -> F>,
}
pub fn create_saga<D, U, F>(config: SagaConfig<D, U>) -> Saga<D, U, F> {
    Saga {
        steps: config.steps,
        queue: queue_adapter(),
        failure: PhantomData,
    }
}
fn inert<I, F, C>(state: &Rc<SagaState<I, F>>) -> Step<Rc<SagaState<I, F>>, C> {
    Step::new(Rc::clone(state), vec![])
}
fn last_done(done: &[StepId]) -> Option<StepId> {
    done.last().copied()
}
impl<D, U, F> Saga<D, U, F> {
    pub fn init(&self) -> Rc<SagaState<StepId, F>> {
        init_saga()
    }
    fn step_at(&self, index: StepId) -> Option<&SagaStep<D, U>> {
        index
            .number()
            .filter(|index| {
                *index >= 0.0 && index.fract() == 0.0 && *index < self.steps.len() as f64
            })
            .and_then(|index| self.steps.get(index as usize))
    }
    fn fresh_ledger(&self) -> Queue<StepId> {
        let mut items = Queue::new();
        for index in 0..self.steps.len() {
            items = self
                .queue
                .enqueue(
                    &items,
                    Rc::new((index as f64).into()),
                    0.0,
                    index.to_string().into(),
                )
                .next;
        }
        items
    }
    fn set_status(
        &self,
        items: &Queue<StepId>,
        index: StepId,
        status: QueueItemStatus,
    ) -> Queue<StepId> {
        let key = structural_hash(&index.number().map_or(PlainData::Null, PlainData::Number));
        self.queue
            .patch(items, key, |item| Rc::new(item.with_status(status)))
            .next
    }
    pub fn start(&self, state: &Rc<SagaState<StepId, F>>) -> Step<Rc<SagaState<StepId, F>>, Rc<D>> {
        if state.phase != SagaPhase::Idle {
            return inert(state);
        }
        let mut next = state.as_ref().clone();
        next.fields.items = self.fresh_ledger();
        let Some(first) = self.step_at(0.0.into()) else {
            next.fields.phase = SagaPhase::Committed;
            return Step::new(Rc::new(next), vec![]);
        };
        next.fields.position = 0.0.into();
        next.fields.phase = SagaPhase::Running;
        next.fields.items = self.set_status(&next.items, 0.0.into(), QueueItemStatus::Running);
        Step::new(Rc::new(next), vec![Rc::clone(&first.forward)])
    }
    pub fn step_ok(
        &self,
        state: &Rc<SagaState<StepId, F>>,
    ) -> Step<Rc<SagaState<StepId, F>>, Rc<D>> {
        if state.phase != SagaPhase::Running {
            return inert(state);
        }
        let mut next = state.as_ref().clone();
        next.fields.items = self.set_status(&state.items, state.position, QueueItemStatus::Done);
        let mut done = state.done.as_ref().clone();
        done.push(state.position);
        next.fields.done = Rc::new(done);
        let position: StepId = (state.position.number().unwrap_or(0.0) + 1.0).into();
        let Some(step) = self.step_at(position) else {
            next.fields.phase = SagaPhase::Committed;
            return Step::new(Rc::new(next), vec![]);
        };
        next.fields.position = position;
        next.fields.items = self.set_status(&next.items, position, QueueItemStatus::Running);
        Step::new(Rc::new(next), vec![Rc::clone(&step.forward)])
    }
    pub fn step_err(
        &self,
        state: &Rc<SagaState<StepId, F>>,
        error: Rc<F>,
    ) -> Step<Rc<SagaState<StepId, F>>, Rc<U>> {
        if state.phase != SagaPhase::Running {
            return inert(state);
        }
        let mut next = state.as_ref().clone();
        next.fields.items = self.set_status(&state.items, state.position, QueueItemStatus::Failed);
        next.assigned("error");
        next.fields.error = QueueField::Value(error);
        next.fields.compensating = true;
        let undo =
            last_done(&state.done).and_then(|index| self.step_at(index).map(|step| (index, step)));
        let Some((index, step)) = undo else {
            next.fields.phase = SagaPhase::Aborted;
            return Step::new(Rc::new(next), vec![]);
        };
        next.fields.position = index;
        next.fields.phase = SagaPhase::Compensating;
        Step::new(Rc::new(next), vec![Rc::clone(&step.undo)])
    }
    pub fn undo_ok(
        &self,
        state: &Rc<SagaState<StepId, F>>,
    ) -> Step<Rc<SagaState<StepId, F>>, Rc<U>> {
        if state.phase != SagaPhase::Compensating {
            return inert(state);
        }
        let Some(undone) = last_done(&state.done) else {
            return inert(state);
        };
        let mut next = state.as_ref().clone();
        next.fields.items = self.set_status(&state.items, undone, QueueItemStatus::Cancelled);
        next.fields.done = Rc::new(state.done[..state.done.len() - 1].to_vec());
        let undo =
            last_done(&next.done).and_then(|index| self.step_at(index).map(|step| (index, step)));
        let Some((index, step)) = undo else {
            next.fields.phase = SagaPhase::Aborted;
            return Step::new(Rc::new(next), vec![]);
        };
        next.fields.position = index;
        Step::new(Rc::new(next), vec![Rc::clone(&step.undo)])
    }
    pub fn undo_err(
        &self,
        state: &Rc<SagaState<StepId, F>>,
        error: Rc<F>,
    ) -> Step<Rc<SagaState<StepId, F>>, Rc<U>> {
        if state.phase != SagaPhase::Compensating {
            return inert(state);
        }
        let mut next = state.as_ref().clone();
        next.fields.items = self.set_status(&state.items, state.position, QueueItemStatus::Failed);
        next.assigned("compensationError");
        next.fields.compensation_error = QueueField::Value(error);
        next.fields.phase = SagaPhase::CompensationFailed;
        Step::new(Rc::new(next), vec![])
    }
}
