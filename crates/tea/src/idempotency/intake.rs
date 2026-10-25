//! Receive-once intake over the canonical idempotency memory and queue verbs.
mod wire;
use super::{IdempotencyMemory, IdempotencyStore, StoreOptions, idempotency_memory};
use crate::{
    PlainData, Step, Tagged,
    command::{
        self, CmdDef, CommandEdge, CommandFamily, CommandRecord, CommandSpec, EngineStamp, Issue,
        Outcome, SchemaError, Settled,
    },
    data::{JsText, NumberOrNull},
    js_record::{
        JsAccessError, JsRead, ProjectionFailure, RecordCodec, RecordLookup, Resolved, number,
        property,
    },
    work_queue::{
        Queue, QueueAdapter, QueueField, QueueItem, QueueItemStatus, QueueOps, queue_adapter,
    },
};
use serde::{Deserialize, Serialize};
use std::{marker::PhantomData, rc::Rc};

pub use crate::work_queue::QueueField as IntakeField;
pub type IntakeValue<R> = IntakeField<Rc<R>>;
pub enum Entry<R> {
    Pending,
    Done { result: IntakeValue<R> },
}
#[derive(Serialize, Deserialize)]
#[serde(bound(
    serialize = "P: Serialize, R: Serialize",
    deserialize = "P: Deserialize<'de>, R: Deserialize<'de>"
))]
pub struct State<P, R> {
    pub seen: Rc<IdempotencyStore<Rc<Entry<R>>>>,
    pub queue: Queue<P>,
}
impl<P, R> Tagged for State<P, R> {
    fn tag(&self) -> &str {
        "intake"
    }
}
pub type IntakeStep<P, R> = Step<Rc<State<P, R>>, Cmd<P, R>>;
pub struct Claim<P, R> {
    pub state: Rc<State<P, R>>,
    pub claimed: Rc<QueueItem<P>>,
}
#[derive(Debug)]
pub enum IntakeError<K = JsAccessError> {
    Key(K),
    Access(JsAccessError),
    Projection(ProjectionFailure),
}
impl<K> From<JsAccessError> for IntakeError<K> {
    fn from(error: JsAccessError) -> Self {
        Self::Access(error)
    }
}
type KeyOf<'a, P, K> = Rc<dyn Fn(&P) -> Result<JsText, K> + 'a>;
pub struct Config<'a, P, K = JsAccessError> {
    pub key_of: KeyOf<'a, P, K>,
    pub ttl_ms: Option<f64>,
}
impl<'a, P> Config<'a, P> {
    pub fn new(key_of: impl Fn(&P) -> Result<JsText, JsAccessError> + 'a) -> Self {
        Self {
            key_of: Rc::new(key_of),
            ttl_ms: None,
        }
    }
}
impl<'a, P, K> Config<'a, P, K> {
    pub fn with_key_error(key_of: impl Fn(&P) -> Result<JsText, K> + 'a) -> Self {
        Self {
            key_of: Rc::new(key_of),
            ttl_ms: None,
        }
    }
    pub fn with_ttl(mut self, ttl_ms: f64) -> Self {
        self.ttl_ms = Some(ttl_ms);
        self
    }
}
/// The payload type remains part of the command's declaration.
/// ```compile_fail,E0308
/// use demlik_tea::idempotency::intake::{intake_process_def, ProcessInput};
/// use std::rc::Rc;
/// let def = intake_process_def::<u32>();
/// def.from_record(ProcessInput { key: "k".into(), item_id: "q".into(), payload: Rc::new("wrong") });
/// ```
pub struct ProcessInput<P> {
    pub key: JsText,
    pub item_id: JsText,
    pub payload: Rc<P>,
}
impl<P> CommandRecord for ProcessInput<P> {}
pub struct ReplayInput<R> {
    pub key: JsText,
    pub result: IntakeValue<R>,
}
impl<R> CommandRecord for ReplayInput<R> {}
#[derive(Debug, Serialize, Deserialize)]
/// These notification commands have no declared business-error channel.
/// ```compile_fail,E0308
/// use demlik_tea::{PlainData, command::{CommandFamily, Outcome}};
/// use demlik_tea::idempotency::intake::{intake_replay_def, ReplayInput, IntakeValue};
/// let cmd = intake_replay_def::<u32>().from_record(ReplayInput { key: "k".into(), result: IntakeValue::Undefined });
/// cmd.settle(Some(Outcome::<PlainData, _>::err("undeclared")), 0.0);
/// ```
pub enum TransportFailure {}
impl Tagged for TransportFailure {
    fn tag(&self) -> &str {
        match *self {}
    }
}
pub struct ProcessSpec<P>(PhantomData<fn() -> P>);
pub struct ReplaySpec<R>(PhantomData<fn() -> R>);
macro_rules! spec {
    ($spec:ident,$input:ident,$name:literal) => {
        impl<T> CommandSpec for $spec<T> {
            type Input = $input<T>;
            type RawOutput = PlainData;
            type Output = PlainData;
            type Error = TransportFailure;
            const NAME: &'static str = $name;
            const ERROR_TAGS: &'static [&'static str] = &[];
            fn parse_input(_: serde_json::Value) -> Result<Self::Input, SchemaError> {
                Err(SchemaError::Issues(vec![Issue::new(
                    "",
                    "intake input needs a caller-owned decoder",
                )]))
            }
            fn parse_output(value: PlainData) -> Result<PlainData, SchemaError> {
                crate::schema::undefined_only(value)
            }
            fn missing_output() -> Option<PlainData> {
                Some(PlainData::Undefined)
            }
        }
    };
}
spec!(ProcessSpec, ProcessInput, "intake:process");
spec!(ReplaySpec, ReplayInput, "intake:replay");
pub fn intake_process_def<P>() -> CmdDef<ProcessSpec<P>> {
    CmdDef::new()
}
pub fn intake_replay_def<R>() -> CmdDef<ReplaySpec<R>> {
    CmdDef::new()
}
pub enum Cmd<P, R> {
    Process(command::Cmd<ProcessSpec<P>>),
    Replay(command::Cmd<ReplaySpec<R>>),
}
impl<P, R> Tagged for Cmd<P, R> {
    fn tag(&self) -> &str {
        match self {
            Self::Process(cmd) => cmd.tag(),
            Self::Replay(cmd) => cmd.tag(),
        }
    }
}
pub enum Msg<P, R> {
    Process(Settled<ProcessSpec<P>>),
    Replay(Settled<ReplaySpec<R>>),
}
impl<P, R> Tagged for Msg<P, R> {
    fn tag(&self) -> &str {
        match self {
            Self::Process(msg) => msg.tag(),
            Self::Replay(msg) => msg.tag(),
        }
    }
}
impl<P, R> crate::core::Message for Msg<P, R> {
    const TYPES: &'static [&'static str] = &[
        "intake:process_ok",
        "intake:process_err",
        "intake:replay_ok",
        "intake:replay_err",
    ];
}
impl<P, R> CommandFamily for Cmd<P, R> {
    type Msg = Msg<P, R>;
    type Completion = Option<Outcome<PlainData, TransportFailure>>;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(msg: &Self::Msg) -> Option<&EngineStamp> {
        match msg {
            Msg::Process(msg) => msg.engine_stamp(),
            Msg::Replay(msg) => msg.engine_stamp(),
        }
    }
    fn settle(
        self,
        value: Self::Completion,
        at: f64,
    ) -> Result<Vec<Self::Msg>, command::CommandContractError> {
        self.settle_in(value, &CommandEdge::new(move || at))
    }
    fn settle_in(
        self,
        value: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Self::Msg>, command::CommandContractError> {
        Ok(match self {
            Self::Process(cmd) => cmd
                .settle_in(value, edge)?
                .into_iter()
                .map(Msg::Process)
                .collect(),
            Self::Replay(cmd) => cmd
                .settle_in(value, edge)?
                .into_iter()
                .map(Msg::Replay)
                .collect(),
        })
    }
}
enum Cached<R> {
    Pending,
    Done(CachedResult<R>),
    Other,
}
enum CachedResult<R> {
    Typed(IntakeValue<R>),
    Projected(PlainData),
}
fn assigned<R>(value: &IntakeValue<R>) -> IntakeValue<R> {
    match value {
        QueueField::Value(value) => QueueField::Value(value.clone()),
        _ => QueueField::Undefined,
    }
}
pub struct Intake<'a, P, R, K = JsAccessError> {
    key_of: KeyOf<'a, P, K>,
    ttl_ms: Option<f64>,
    memory: IdempotencyMemory<'a, Rc<Entry<R>>>,
    queue: QueueOps,
    process: CmdDef<ProcessSpec<P>>,
    replay: CmdDef<ReplaySpec<R>>,
    result_codec: RecordCodec<'a, Rc<R>>,
}
impl<'a, P, R, K> Intake<'a, P, R, K> {
    pub fn new(config: Config<'a, P, K>) -> Self {
        Self {
            key_of: config.key_of,
            ttl_ms: config.ttl_ms,
            memory: idempotency_memory(),
            queue: queue_adapter(),
            process: intake_process_def(),
            replay: intake_replay_def(),
            result_codec: RecordCodec::refusing(),
        }
    }
    pub fn with_result_codec(mut self, codec: RecordCodec<'a, Rc<R>>) -> Self {
        self.result_codec = codec;
        self
    }
    pub fn init(&self) -> Rc<State<P, R>> {
        Rc::new(State {
            seen: Rc::new(self.memory.init(StoreOptions::default())),
            queue: Queue::default(),
        })
    }
    fn cached(
        &self,
        store: &IdempotencyStore<Rc<Entry<R>>>,
        key: &JsText,
        at: Option<NumberOrNull>,
    ) -> Result<Option<Cached<R>>, IntakeError<K>> {
        let (entry, stamp) = match store.entries.lookup(key) {
            RecordLookup::Value(Resolved::Missing | Resolved::Data(PlainData::Undefined)) => {
                return Ok(None);
            }
            RecordLookup::Value(Resolved::Data(PlainData::Null)) if at.is_none() => {
                return Ok(None);
            }
            RecordLookup::Value(Resolved::Entry(row)) => {
                let entry = match row.value.as_ref() {
                    Entry::Pending => return Ok(Some(Cached::Pending)),
                    Entry::Done { result } => Cached::Done(CachedResult::Typed(assigned(result))),
                };
                (entry, row.at_ms.number_or_zero())
            }
            RecordLookup::Payload(_)
            | RecordLookup::Value(Resolved::Builtin(_) | Resolved::ObjectPrototype) => {
                property(&PlainData::Undefined, "phase")?;
                unreachable!()
            }
            RecordLookup::Value(Resolved::Data(row)) => {
                let entry = property(&row, "value")?;
                let phase = property(&entry, "phase")?;
                if matches!(&phase, PlainData::String(value) if value.as_utf8() == Some("pending"))
                {
                    return Ok(Some(Cached::Pending));
                }
                let value = if matches!(&phase, PlainData::String(value) if value.as_utf8() == Some("done"))
                {
                    Cached::Done(CachedResult::Projected(property(&entry, "result")?))
                } else {
                    Cached::Other
                };
                (
                    value,
                    if at.is_some() && self.ttl_ms.is_some() {
                        number(&property(&row, "atMs")?)?
                    } else {
                        0.0
                    },
                )
            }
        };
        if let (Some(at), Some(ttl)) = (at, self.ttl_ms)
            && at.number_or_zero() - stamp >= ttl
        {
            return Ok(None);
        }
        Ok(Some(entry))
    }
    fn is_already_done(
        &self,
        state: &State<P, R>,
        item: &QueueItem<P>,
    ) -> Result<bool, IntakeError<K>> {
        let key = (self.key_of)(&item.input).map_err(IntakeError::Key)?;
        Ok(matches!(
            self.cached(&state.seen, &key, None)?,
            Some(Cached::Done(_))
        ))
    }
    pub fn receive(
        &self,
        state: &Rc<State<P, R>>,
        payload: Rc<P>,
        at: impl Into<NumberOrNull>,
        id: impl Into<JsText>,
    ) -> Result<IntakeStep<P, R>, IntakeError<K>> {
        let at = at.into();
        let key = (self.key_of)(&payload).map_err(IntakeError::Key)?;
        if let Some(entry) = self.cached(&state.seen, &key, Some(at))? {
            let commands = match entry {
                Cached::Done(result) => {
                    let result = match result {
                        CachedResult::Typed(result) => result,
                        CachedResult::Projected(PlainData::Undefined) => IntakeValue::Undefined,
                        CachedResult::Projected(value) => IntakeValue::Value(
                            self.result_codec
                                .read(JsRead::Projected(value))
                                .map_err(IntakeError::Projection)?,
                        ),
                    };
                    vec![Cmd::Replay(
                        self.replay.from_record(ReplayInput { key, result }),
                    )]
                }
                _ => vec![],
            };
            return Ok(Step::new(state.clone(), commands));
        }
        let seen = self
            .memory
            .remember(&state.seen, key.clone(), Rc::new(Entry::Pending), at)?;
        let enqueued = self
            .queue
            .enqueue(&state.queue, payload.clone(), at, id.into());
        Ok(Step::new(
            Rc::new(State {
                seen: Rc::new(seen),
                queue: enqueued.next,
            }),
            vec![Cmd::Process(self.process.from_record(ProcessInput {
                key,
                item_id: enqueued.item.id.clone(),
                payload,
            }))],
        ))
    }
    pub fn complete(
        &self,
        state: &Rc<State<P, R>>,
        key: impl Into<JsText>,
        result: IntakeValue<R>,
        at: impl Into<NumberOrNull>,
    ) -> Result<IntakeStep<P, R>, IntakeError<K>> {
        let seen = self.memory.remember(
            &state.seen,
            key,
            Rc::new(Entry::Done {
                result: assigned(&result),
            }),
            at,
        )?;
        Ok(Step::new(
            Rc::new(State {
                seen: Rc::new(seen),
                queue: state.queue.clone(),
            }),
            vec![],
        ))
    }
    pub fn boot(&self, state: &Rc<State<P, R>>) -> Result<IntakeStep<P, R>, IntakeError<K>> {
        let mut items = state.queue.clone();
        let mut changed = false;
        for item in state.queue.to_vec() {
            if item.status != QueueItemStatus::Running || self.is_already_done(state, &item)? {
                continue;
            }
            let flip = self.queue.patch(&items, &item.id, |item| {
                Rc::new(
                    item.with_status(QueueItemStatus::Pending)
                        .with_started_at(QueueField::Undefined),
                )
            });
            items = flip.next;
            changed |= flip.changed;
        }
        Ok(Step::new(
            if changed {
                Rc::new(State {
                    seen: state.seen.clone(),
                    queue: items,
                })
            } else {
                state.clone()
            },
            vec![],
        ))
    }
    pub fn claim_next(
        &self,
        state: &Rc<State<P, R>>,
        at: impl Into<NumberOrNull>,
    ) -> Result<Option<Claim<P, R>>, IntakeError<K>> {
        let mut target = None;
        for item in state.queue.to_vec() {
            if item.status == QueueItemStatus::Pending && !self.is_already_done(state, &item)? {
                target = Some(item.clone());
                break;
            }
        }
        let Some(target) = target else {
            return Ok(None);
        };
        let mut claimed = target.clone();
        let next = self
            .queue
            .patch(&state.queue, &target.id, |item| {
                claimed = Rc::new(
                    item.with_status(QueueItemStatus::Running)
                        .with_started_at(QueueField::Value(at.into())),
                );
                claimed.clone()
            })
            .next;
        Ok(Some(Claim {
            state: Rc::new(State {
                seen: state.seen.clone(),
                queue: next,
            }),
            claimed,
        }))
    }
}
