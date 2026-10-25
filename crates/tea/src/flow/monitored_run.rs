//! Pure stage progress, checkpoint decisions, and watchdog declarations.

use crate::persistence::snapshot::{Snapshot, SnapshotConfig, SnapshotState, create_snapshot};
pub use crate::persistence::snapshot::{SnapshotSavedMsg, SnapshotWriteCmd, SnapshotWriteSpec};
use crate::resilience::deadline::{Deadline, DeadlineExceeded, deadline_sub, next_timer};
use crate::{
    PlainData, Step, Tagged, TimerDeps,
    data::{JsText, structural_hash},
    work_queue::{Queue, QueueItem, QueueItemStatus, claim_next_op, enqueue_op, mark_done_op},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned, ser::SerializeMap};
use serde_json::value::RawValue;
use std::{ops::Deref, rc::Rc};

pub use crate::work_queue::QueueField as FailureField;
/// Retains JSON-restored nulls until the source operation coerces them.
pub use crate::work_queue::QueueTime as RunNumber;

#[derive(Debug)]
pub enum RunFailure<S, E> {
    Deadline {
        at: RunNumber,
    },
    Stage {
        stage: FailureField<Rc<S>>,
        error: FailureField<Rc<E>>,
    },
}
impl<S: Serialize, E: Serialize> Serialize for RunFailure<S, E> {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        use crate::data::{JsonData, plain_data};
        let mut fields = indexmap::IndexMap::new();
        match self {
            Self::Deadline { at } => {
                fields.insert("reason".into(), PlainData::String("deadline".into()));
                fields.insert(
                    "at".into(),
                    at.number().map_or(PlainData::Null, PlainData::Number),
                );
            }
            Self::Stage { stage, error } => {
                fields.insert("reason".into(), PlainData::String("stage".into()));
                fn field<V: Serialize, X: serde::ser::Error>(
                    value: &FailureField<Rc<V>>,
                ) -> Result<Option<PlainData>, X> {
                    match value {
                        FailureField::Absent => Ok(None),
                        FailureField::Undefined => Ok(Some(PlainData::Undefined)),
                        FailureField::Value(value) => {
                            plain_data(value).map(Some).map_err(X::custom)
                        }
                    }
                }
                if let Some(stage) = field::<_, T::Error>(stage)? {
                    fields.insert("stage".into(), stage);
                }
                if let Some(error) = field::<_, T::Error>(error)? {
                    fields.insert("error".into(), error);
                }
            }
        }
        JsonData(&PlainData::Object(fields)).serialize(serializer)
    }
}
#[derive(Debug, Serialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub enum RunPhase<S, E> {
    Idle,
    Running {
        #[serde(rename = "runId")]
        run_id: JsText,
    },
    Stale {
        #[serde(rename = "runId")]
        run_id: JsText,
    },
    Done {
        #[serde(rename = "runId")]
        run_id: JsText,
    },
    Failed {
        #[serde(rename = "runId")]
        run_id: JsText,
        failure: Rc<RunFailure<S, E>>,
    },
    Cancelled {
        #[serde(rename = "runId")]
        run_id: Option<JsText>,
        at: RunNumber,
    },
}
impl<S, E> Clone for RunPhase<S, E> {
    fn clone(&self) -> Self {
        match self {
            Self::Idle => Self::Idle,
            Self::Running { run_id } => Self::Running {
                run_id: run_id.clone(),
            },
            Self::Stale { run_id } => Self::Stale {
                run_id: run_id.clone(),
            },
            Self::Done { run_id } => Self::Done {
                run_id: run_id.clone(),
            },
            Self::Failed { run_id, failure } => Self::Failed {
                run_id: run_id.clone(),
                failure: Rc::clone(failure),
            },
            Self::Cancelled { run_id, at } => Self::Cancelled {
                run_id: run_id.clone(),
                at: *at,
            },
        }
    }
}
impl<S, E> RunPhase<S, E> {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running { .. } => "running",
            Self::Stale { .. } => "stale",
            Self::Done { .. } => "done",
            Self::Failed { .. } => "failed",
            Self::Cancelled { .. } => "cancelled",
        }
    }
    fn live_id(&self) -> Option<&JsText> {
        match self {
            Self::Running { run_id } | Self::Stale { run_id } => Some(run_id),
            _ => None,
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCore<S> {
    pub step_states: Queue<S>,
    pub started_at: RunNumber,
    pub last_progress_at: RunNumber,
    pub progress_seq: RunNumber,
    pub snapshot: Rc<SnapshotState>,
}
impl<S> Clone for RunCore<S> {
    fn clone(&self) -> Self {
        Self {
            step_states: self.step_states.clone(),
            started_at: self.started_at,
            last_progress_at: self.last_progress_at,
            progress_seq: self.progress_seq,
            snapshot: Rc::clone(&self.snapshot),
        }
    }
}
#[derive(Debug)]
pub struct MonitoredRunState<S, E = PlainData> {
    pub phase: RunPhase<S, E>,
    pub core: RunCore<S>,
}
impl<S: Serialize, E: Serialize> Serialize for MonitoredRunState<S, E> {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        let mut state = serializer.serialize_map(None)?;
        state.serialize_entry("phase", self.phase.as_str())?;
        match &self.phase {
            RunPhase::Idle => {}
            RunPhase::Running { run_id }
            | RunPhase::Stale { run_id }
            | RunPhase::Done { run_id }
            | RunPhase::Failed { run_id, .. } => state.serialize_entry("runId", run_id)?,
            RunPhase::Cancelled { run_id, at } => {
                state.serialize_entry("runId", run_id)?;
                state.serialize_entry("at", at)?;
            }
        }
        state.serialize_entry("stepStates", &self.step_states)?;
        state.serialize_entry("startedAt", &self.started_at)?;
        state.serialize_entry("lastProgressAt", &self.last_progress_at)?;
        state.serialize_entry("progressSeq", &self.progress_seq)?;
        state.serialize_entry("snapshot", &self.snapshot)?;
        if let RunPhase::Failed { failure, .. } = &self.phase {
            state.serialize_entry("failure", failure)?;
        }
        state.end()
    }
}
impl<'de, S: DeserializeOwned, E: DeserializeOwned> Deserialize<'de> for RunFailure<S, E> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "lowercase")]
        enum Reason {
            Deadline,
            Stage,
        }
        #[derive(Deserialize)]
        struct RawFailure {
            reason: Reason,
            #[serde(default)]
            at: FailureField<RunNumber>,
            #[serde(default)]
            stage: FailureField<Box<RawValue>>,
            #[serde(default)]
            error: FailureField<Box<RawValue>>,
        }
        fn decode<T: DeserializeOwned, X: serde::de::Error>(
            field: FailureField<Box<RawValue>>,
        ) -> Result<FailureField<Rc<T>>, X> {
            match field {
                FailureField::Absent => Ok(FailureField::Absent),
                FailureField::Undefined => Ok(FailureField::Undefined),
                FailureField::Value(raw) => serde_json::from_str(raw.get())
                    .map(Rc::new)
                    .map(FailureField::Value)
                    .map_err(X::custom),
            }
        }
        let raw = RawFailure::deserialize(deserializer)?;
        match raw.reason {
            Reason::Deadline => Ok(Self::Deadline {
                at: match raw.at {
                    FailureField::Value(at) => at,
                    _ => return Err(serde::de::Error::missing_field("at")),
                },
            }),
            Reason::Stage => Ok(Self::Stage {
                stage: decode(raw.stage)?,
                error: decode(raw.error)?,
            }),
        }
    }
}
impl<'de, S: DeserializeOwned, E: DeserializeOwned> Deserialize<'de> for MonitoredRunState<S, E> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "lowercase")]
        enum Phase {
            Idle,
            Running,
            Stale,
            Done,
            Failed,
            Cancelled,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawRun<S> {
            phase: Phase,
            run_id: Option<JsText>,
            #[serde(default)]
            at: FailureField<RunNumber>,
            failure: Option<Box<RawValue>>,
            step_states: Queue<S>,
            started_at: RunNumber,
            last_progress_at: RunNumber,
            progress_seq: RunNumber,
            snapshot: Rc<SnapshotState>,
        }
        let raw = RawRun::<S>::deserialize(deserializer)?;
        let run_id = || {
            raw.run_id
                .clone()
                .ok_or_else(|| serde::de::Error::missing_field("runId"))
        };
        let phase = match raw.phase {
            Phase::Idle => RunPhase::Idle,
            Phase::Running => RunPhase::Running { run_id: run_id()? },
            Phase::Stale => RunPhase::Stale { run_id: run_id()? },
            Phase::Done => RunPhase::Done { run_id: run_id()? },
            Phase::Failed => RunPhase::Failed {
                run_id: run_id()?,
                failure: Rc::new(
                    serde_json::from_str(
                        raw.failure
                            .ok_or_else(|| serde::de::Error::missing_field("failure"))?
                            .get(),
                    )
                    .map_err(serde::de::Error::custom)?,
                ),
            },
            Phase::Cancelled => RunPhase::Cancelled {
                run_id: raw.run_id,
                at: match raw.at {
                    FailureField::Value(at) => at,
                    _ => return Err(serde::de::Error::missing_field("at")),
                },
            },
        };
        Ok(Self {
            phase,
            core: RunCore {
                step_states: raw.step_states,
                started_at: raw.started_at,
                last_progress_at: raw.last_progress_at,
                progress_seq: raw.progress_seq,
                snapshot: raw.snapshot,
            },
        })
    }
}
impl<S, E> Clone for MonitoredRunState<S, E> {
    fn clone(&self) -> Self {
        Self {
            phase: self.phase.clone(),
            core: self.core.clone(),
        }
    }
}
impl<S, E> Deref for MonitoredRunState<S, E> {
    type Target = RunCore<S>;
    fn deref(&self) -> &Self::Target {
        &self.core
    }
}
impl<S, E> Tagged for MonitoredRunState<S, E> {
    fn tag(&self) -> &str {
        self.phase.as_str()
    }
}
pub enum StageResult<E = PlainData> {
    Ok,
    Fail { error: Rc<E> },
}
pub struct MonitoredRunConfig<S> {
    pub stages: Vec<Rc<S>>,
    pub deadline_ms: Option<f64>,
    pub snapshot_every: Option<f64>,
    pub snapshot_key: Option<JsText>,
}
impl<S> Default for MonitoredRunConfig<S> {
    fn default() -> Self {
        Self {
            stages: vec![],
            deadline_ms: None,
            snapshot_every: None,
            snapshot_key: None,
        }
    }
}
pub struct MonitoredRun<S, V, E = PlainData> {
    stages: Vec<Rc<S>>,
    deadline_ms: Option<f64>,
    snapshots_enabled: bool,
    snapshot: Snapshot<V>,
    error: std::marker::PhantomData<fn() -> E>,
}
pub type MonitoredRunCmd<V> = SnapshotWriteCmd<V>;
pub type MonitoredRunTimerMsg = DeadlineExceeded;
/// The callback replaces the host's run field by value, keeping unrelated
/// fields without imposing a `Clone` bound on the host.
pub fn lift_run<H, S, E, C>(
    host: H,
    step: Step<Rc<MonitoredRunState<S, E>>, C>,
    replace_run: impl FnOnce(H, Rc<MonitoredRunState<S, E>>) -> H,
) -> Step<H, C> {
    Step::new(replace_run(host, step.state), step.commands)
}
pub fn create_monitored_run<S, V>(config: MonitoredRunConfig<S>) -> MonitoredRun<S, V> {
    MonitoredRun::new(config)
}
fn safety_timer_id(run_id: &JsText, seq: RunNumber) -> JsText {
    let mut units = "monitored:safety:".encode_utf16().collect::<Vec<_>>();
    units.extend_from_slice(run_id.as_units());
    units.push(58);
    units.extend(
        structural_hash(&seq.number().map_or(PlainData::Null, PlainData::Number)).encode_utf16(),
    );
    JsText::from_units(units)
}
impl<S, V, E> MonitoredRun<S, V, E> {
    pub fn new(config: MonitoredRunConfig<S>) -> Self {
        let enabled = config.snapshot_every.is_some();
        Self {
            stages: config.stages,
            deadline_ms: config.deadline_ms,
            snapshots_enabled: enabled,
            snapshot: create_snapshot(SnapshotConfig {
                every: config.snapshot_every.unwrap_or(1.0),
                key: if enabled { config.snapshot_key } else { None },
            }),
            error: std::marker::PhantomData,
        }
    }
    pub fn checkpoint(&self) -> &crate::command::CmdDef<SnapshotWriteSpec<V>> {
        &self.snapshot.write
    }
    pub fn init(&self) -> Rc<MonitoredRunState<S, E>> {
        Rc::new(MonitoredRunState {
            phase: RunPhase::Idle,
            core: RunCore {
                step_states: Queue::new(),
                started_at: 0.0.into(),
                last_progress_at: 0.0.into(),
                progress_seq: 0.0.into(),
                snapshot: self.snapshot.init(),
            },
        })
    }
    fn current_stage(&self, state: &MonitoredRunState<S, E>) -> Option<Rc<QueueItem<S>>> {
        state
            .step_states
            .iter()
            .find(|item| item.status == QueueItemStatus::Running)
    }
    pub fn start(
        &self,
        state: &Rc<MonitoredRunState<S, E>>,
        run_id: impl Into<JsText>,
        at: f64,
    ) -> Step<Rc<MonitoredRunState<S, E>>, MonitoredRunCmd<V>> {
        let mut queue = Queue::new();
        for (index, stage) in self.stages.iter().enumerate() {
            queue = enqueue_op(&queue, Rc::clone(stage), at, format!("stage:{index}")).next;
        }
        if let Some(claimed) = claim_next_op(&queue, at) {
            queue = claimed.next;
        }
        Step::new(
            Rc::new(MonitoredRunState {
                phase: RunPhase::Running {
                    run_id: run_id.into(),
                },
                core: RunCore {
                    step_states: queue,
                    started_at: at.into(),
                    last_progress_at: at.into(),
                    progress_seq: 0.0.into(),
                    snapshot: Rc::clone(&state.snapshot),
                },
            }),
            vec![],
        )
    }
    fn bump(&self, state: &MonitoredRunState<S, E>, at: f64) -> MonitoredRunState<S, E> {
        let mut next = state.clone();
        next.core.last_progress_at = at.into();
        next.core.progress_seq = (state.progress_seq.number().unwrap_or(0.0) + 1.0).into();
        next
    }
    fn record(
        &self,
        mut state: MonitoredRunState<S, E>,
        payload: Rc<V>,
        at: f64,
        force: bool,
    ) -> Step<Rc<MonitoredRunState<S, E>>, MonitoredRunCmd<V>> {
        if !self.snapshots_enabled {
            return Step::new(Rc::new(state), vec![]);
        }
        let checkpoint = if force {
            self.snapshot.force(&state.snapshot, payload, at)
        } else {
            self.snapshot.record(&state.snapshot, payload, at)
        };
        state.core.snapshot = checkpoint.state;
        Step::new(Rc::new(state), checkpoint.commands)
    }
    pub fn advance(
        &self,
        state: &Rc<MonitoredRunState<S, E>>,
        payload: Rc<V>,
        result: StageResult<E>,
        at: f64,
    ) -> Step<Rc<MonitoredRunState<S, E>>, MonitoredRunCmd<V>> {
        let Some(run_id) = state.phase.live_id() else {
            return Step::new(Rc::clone(state), vec![]);
        };
        if let StageResult::Fail { error } = result {
            let mut next = state.as_ref().clone();
            next.phase = RunPhase::Failed {
                run_id: run_id.clone(),
                failure: Rc::new(RunFailure::Stage {
                    stage: self
                        .current_stage(state)
                        .map_or(FailureField::Undefined, |item| {
                            FailureField::Value(Rc::clone(&item.input))
                        }),
                    error: FailureField::Value(error),
                }),
            };
            return Step::new(Rc::new(next), vec![]);
        }
        let mut next = self.bump(state, at);
        if self.stages.is_empty() {
            next.phase = RunPhase::Done {
                run_id: run_id.clone(),
            };
            return self.record(next, payload, at, true);
        }
        let after = self.current_stage(state).map_or_else(
            || state.step_states.clone(),
            |current| mark_done_op(&state.step_states, &current.id).next,
        );
        match claim_next_op(&after, at) {
            None => {
                next.core.step_states = after;
                next.phase = RunPhase::Done {
                    run_id: run_id.clone(),
                };
                self.record(next, payload, at, true)
            }
            Some(claimed) => {
                next.core.step_states = claimed.next;
                self.record(next, payload, at, false)
            }
        }
    }
    pub fn progress(
        &self,
        state: &Rc<MonitoredRunState<S, E>>,
        payload: Rc<V>,
        at: f64,
    ) -> Step<Rc<MonitoredRunState<S, E>>, MonitoredRunCmd<V>> {
        let Some(run_id) = state.phase.live_id() else {
            return Step::new(Rc::clone(state), vec![]);
        };
        let mut next = self.bump(state, at);
        next.phase = RunPhase::Running {
            run_id: run_id.clone(),
        };
        self.record(next, payload, at, false)
    }
    pub fn mark_stale(
        &self,
        state: &Rc<MonitoredRunState<S, E>>,
    ) -> Step<Rc<MonitoredRunState<S, E>>, MonitoredRunCmd<V>> {
        let RunPhase::Running { run_id } = &state.phase else {
            return Step::new(Rc::clone(state), vec![]);
        };
        let mut next = state.as_ref().clone();
        next.phase = RunPhase::Stale {
            run_id: run_id.clone(),
        };
        Step::new(Rc::new(next), vec![])
    }
    pub fn cancel(
        &self,
        state: &Rc<MonitoredRunState<S, E>>,
        at: f64,
    ) -> Step<Rc<MonitoredRunState<S, E>>, MonitoredRunCmd<V>> {
        let run_id = match &state.phase {
            RunPhase::Idle => None,
            RunPhase::Running { run_id } | RunPhase::Stale { run_id } => Some(run_id.clone()),
            _ => return Step::new(Rc::clone(state), vec![]),
        };
        let mut next = state.as_ref().clone();
        next.phase = RunPhase::Cancelled {
            run_id,
            at: at.into(),
        };
        Step::new(Rc::new(next), vec![])
    }
    pub fn on_deadline(
        &self,
        state: &Rc<MonitoredRunState<S, E>>,
        msg: &MonitoredRunTimerMsg,
    ) -> Step<Rc<MonitoredRunState<S, E>>, MonitoredRunCmd<V>> {
        let Some(run_id) = state.phase.live_id() else {
            return Step::new(Rc::clone(state), vec![]);
        };
        if msg.id != safety_timer_id(run_id, state.progress_seq) {
            return Step::new(Rc::clone(state), vec![]);
        }
        let mut next = state.as_ref().clone();
        next.phase = RunPhase::Failed {
            run_id: run_id.clone(),
            failure: Rc::new(RunFailure::Deadline {
                at: msg.at_ms.into(),
            }),
        };
        Step::new(Rc::new(next), vec![])
    }
    pub fn boot(
        &self,
        state: &Rc<MonitoredRunState<S, E>>,
        at: f64,
    ) -> Step<Rc<MonitoredRunState<S, E>>, MonitoredRunCmd<V>> {
        let Some(run_id) = state.phase.live_id() else {
            return Step::new(Rc::clone(state), vec![]);
        };
        let mut next = self.bump(state, at);
        next.phase = RunPhase::Running {
            run_id: run_id.clone(),
        };
        next.core.snapshot = self.snapshot.boot(&state.snapshot).state;
        Step::new(Rc::new(next), vec![])
    }
    pub fn confirm_snapshot(
        &self,
        state: &Rc<MonitoredRunState<S, E>>,
        msg: &SnapshotSavedMsg<V>,
    ) -> Rc<MonitoredRunState<S, E>> {
        if !self.snapshots_enabled {
            return Rc::clone(state);
        }
        let mut next = state.as_ref().clone();
        next.core.snapshot = self.snapshot.confirm(&state.snapshot, msg).state;
        Rc::new(next)
    }
    pub fn deadlines(&self, state: &MonitoredRunState<S, E>) -> Vec<Deadline> {
        match (self.deadline_ms, state.phase.live_id()) {
            (Some(ms), Some(id)) => vec![deadline_sub(
                safety_timer_id(id, state.progress_seq),
                state.last_progress_at.number().unwrap_or(0.0) + ms,
            )],
            _ => vec![],
        }
    }
    pub fn timer(
        &self,
        state: &MonitoredRunState<S, E>,
    ) -> Option<TimerDeps<MonitoredRunTimerMsg>> {
        next_timer(
            &self.deadlines(state),
            state.last_progress_at.number().unwrap_or(0.0),
        )
    }
}
