use super::{
    DoStoreError, DurableObjectStorage, completion_error, encoded_json, request, request_error,
    stored_json,
};
use crate::{
    Machine, PlainData, Subscription, Tagged,
    data::JsText,
    fold_msgs, js_record, replay,
    storage::{Migrated, Store, number_string},
};
use futures::{FutureExt, future::LocalBoxFuture};
use std::{
    cell::{Cell, RefCell},
    fmt,
    marker::PhantomData,
    rc::Rc,
    sync::Arc,
};

pub enum SnapshotInput<S> {
    Stored(PlainData),
    Recovered(Arc<S>),
}
#[derive(Default)]
pub struct EventSourcedKeys {
    pub snapshot: Option<JsText>,
    pub meta: Option<JsText>,
    pub event_prefix: Option<JsText>,
}
#[derive(Clone, Copy, Default)]
pub struct EventLogRange {
    pub from_seq: Option<f64>,
    pub to_seq: Option<f64>,
}
pub struct PersistedEvent<M> {
    pub seq: f64,
    pub event: M,
}
type StateParser<'a, S> = Box<dyn Fn(SnapshotInput<S>) -> Option<Arc<S>> + 'a>;
type EventParser<'a, M> = Box<dyn Fn(PlainData) -> Option<M> + 'a>;
type Encoder<'a, T, E> = Box<dyn Fn(&T) -> Result<PlainData, E> + 'a>;
pub type ReadyHook<'a, S, E> = Box<dyn Fn(Arc<S>) -> Result<(), E> + 'a>;
pub struct EventSourcedOptions<'a, S, M, E> {
    pub snapshot_every: Option<f64>,
    pub keys: EventSourcedKeys,
    pub parse: StateParser<'a, S>,
    pub parse_event: EventParser<'a, M>,
    pub encode_state: Encoder<'a, S, E>,
    pub encode_event: Encoder<'a, M, E>,
    pub on_ready: Option<ReadyHook<'a, S, E>>,
}
impl<'a, S, M, E> EventSourcedOptions<'a, S, M, E> {
    pub fn new(
        parse: impl Fn(SnapshotInput<S>) -> Option<Arc<S>> + 'a,
        parse_event: impl Fn(PlainData) -> Option<M> + 'a,
        encode_state: impl Fn(&S) -> Result<PlainData, E> + 'a,
        encode_event: impl Fn(&M) -> Result<PlainData, E> + 'a,
    ) -> Self {
        Self {
            snapshot_every: None,
            keys: EventSourcedKeys::default(),
            parse: Box::new(parse),
            parse_event: Box::new(parse_event),
            encode_state: Box::new(encode_state),
            encode_event: Box::new(encode_event),
            on_ready: None,
        }
    }
}
#[derive(Debug)]
pub struct SnapshotEveryError {
    pub value: f64,
}
impl fmt::Display for SnapshotEveryError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            output,
            "@demlik/tea/do: snapshotEvery must be an integer >= 1, got {}",
            number_string(self.value)
        )
    }
}
impl std::error::Error for SnapshotEveryError {}
struct Core<'a, S, M, C, U, X, P, E> {
    storage: Rc<P>,
    machine: Rc<Machine<'a, Arc<S>, M, C, U, X>>,
    input: Rc<X>,
    options: EventSourcedOptions<'a, S, M, E>,
    every: f64,
    snapshot_key: JsText,
    meta_key: JsText,
    event_prefix: JsText,
    last_seq: Cell<Option<f64>>,
    snapshot_seq: Cell<f64>,
    latest_state: RefCell<Option<Arc<S>>>,
    ready_fired: Cell<bool>,
}
pub struct EventRecoveryStore<'a, S, M, C, U, X, P, E> {
    core: Rc<Core<'a, S, M, C, U, X, P, E>>,
}
impl<S, M, C, U, X, P, E> Clone for EventRecoveryStore<'_, S, M, C, U, X, P, E> {
    fn clone(&self) -> Self {
        Self {
            core: Rc::clone(&self.core),
        }
    }
}
pub struct EventSourcedStore<'a, S, M, C, U, X, P, E> {
    pub store: EventRecoveryStore<'a, S, M, C, U, X, P, E>,
}
pub type EventSourcedResult<'a, S, M, C, U, X, P, E> =
    Result<EventSourcedStore<'a, S, M, C, U, X, P, E>, SnapshotEveryError>;
impl<S, M, C, U, X, P, E> Clone for EventSourcedStore<'_, S, M, C, U, X, P, E> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
        }
    }
}
pub fn do_event_sourced_store<'a, S, M, C, U, X, P, E>(
    storage: Rc<P>,
    machine: Rc<Machine<'a, Arc<S>, M, C, U, X>>,
    input: Rc<X>,
    options: EventSourcedOptions<'a, S, M, E>,
) -> EventSourcedResult<'a, S, M, C, U, X, P, E> {
    let every = options.snapshot_every.unwrap_or(100.0);
    if every < 1.0 || !every.is_finite() || every.fract() != 0.0 {
        return Err(SnapshotEveryError { value: every });
    }
    let snapshot_key = options
        .keys
        .snapshot
        .clone()
        .unwrap_or_else(|| "@@es/snapshot".into());
    let meta_key = options
        .keys
        .meta
        .clone()
        .unwrap_or_else(|| "@@es/meta".into());
    let event_prefix = options
        .keys
        .event_prefix
        .clone()
        .unwrap_or_else(|| "@@es/evt/".into());
    Ok(EventSourcedStore {
        store: EventRecoveryStore {
            core: Rc::new(Core {
                storage,
                machine,
                input,
                options,
                every,
                snapshot_key,
                meta_key,
                event_prefix,
                last_seq: Cell::new(None),
                snapshot_seq: Cell::new(0.0),
                latest_state: RefCell::new(None),
                ready_fired: Cell::new(false),
            }),
        },
    })
}
impl<S, M, C, U, X, P, E> Core<'_, S, M, C, U, X, P, E>
where
    P: DurableObjectStorage + 'static,
{
    async fn get(&self, key: JsText) -> Result<PlainData, DoStoreError<P::Error, E>> {
        let storage = Rc::clone(&self.storage);
        request(async move { storage.get(key).await })
            .await
            .map_err(|error| request_error(error, "get"))
    }
    async fn put(&self, key: JsText, value: PlainData) -> Result<(), DoStoreError<P::Error, E>> {
        let storage = Rc::clone(&self.storage);
        request(async move { storage.put(key, value).await })
            .await
            .map_err(|error| request_error(error, "put"))
    }
    async fn read_meta(&self) -> Result<f64, DoStoreError<P::Error, E>> {
        let raw = self.get(self.meta_key.clone()).await?;
        if matches!(raw, PlainData::Null | PlainData::Undefined) {
            return Ok(0.0);
        }
        let meta = stored_json(raw)?;
        Ok(
            match js_record::property(&meta, "lastSeq").map_err(DoStoreError::Coercion)? {
                PlainData::Number(value) => value,
                _ => 0.0,
            },
        )
    }
    async fn read_snapshot(&self) -> Result<(Option<Arc<S>>, f64), DoStoreError<P::Error, E>> {
        let raw = self.get(self.snapshot_key.clone()).await?;
        if matches!(raw, PlainData::Null | PlainData::Undefined) {
            return Ok((None, 0.0));
        }
        let cell = stored_json(raw)?;
        let raw = js_record::property(&cell, "state").map_err(DoStoreError::Coercion)?;
        let Some(state) = (self.options.parse)(SnapshotInput::Stored(raw)) else {
            return Ok((None, 0.0));
        };
        let seq = match js_record::property(&cell, "seq").map_err(DoStoreError::Coercion)? {
            PlainData::Number(value) => value,
            _ => 0.0,
        };
        Ok((Some(state), seq))
    }
    async fn write_snapshot(
        &self,
        seq: f64,
        state: Arc<S>,
    ) -> Result<(), DoStoreError<P::Error, E>> {
        let state = (self.options.encode_state)(&state).map_err(DoStoreError::Encode)?;
        let cell = PlainData::Object(indexmap::IndexMap::from([
            ("seq".into(), PlainData::Number(seq)),
            ("state".into(), state),
        ]));
        self.put(self.snapshot_key.clone(), encoded_json(cell))
            .await?;
        self.snapshot_seq.set(seq);
        Ok(())
    }
    fn reader(&self, range: EventLogRange) -> ReadEvents<'_, P, M, E> {
        ReadEvents {
            storage: Rc::clone(&self.storage),
            parse: &*self.options.parse_event,
            prefix: self.event_prefix.clone(),
            range,
            rows: None,
            done: false,
            error: PhantomData,
        }
    }
}
impl<'a, S: Tagged, M: Tagged, C, U: Subscription, X, P: DurableObjectStorage + 'static, E>
    Store<Arc<S>> for EventRecoveryStore<'a, S, M, C, U, X, P, E>
{
    type Raw = SnapshotInput<S>;
    type Error = DoStoreError<P::Error, E>;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        let (snapshot, snap_seq) = self.core.read_snapshot().await?;
        self.core.snapshot_seq.set(snap_seq);
        self.core.last_seq.set(Some(self.core.read_meta().await?));
        let mut reader = self.core.reader(EventLogRange {
            from_seq: Some(snap_seq + 1.0),
            to_seq: None,
        });
        let mut events = Vec::new();
        while let Some(row) = reader.next().await {
            events.push(row?.event);
        }
        let state = match snapshot {
            Some(state) => fold_msgs(&self.core.machine, state, events),
            None => {
                replay(&self.core.machine, None, &self.core.input, events).map(|value| value.state)
            }
        }
        .map_err(DoStoreError::Fold)?;
        if !self.core.ready_fired.replace(true)
            && let Some(ready) = &self.core.options.on_ready
        {
            ready(Arc::clone(&state)).map_err(DoStoreError::Ready)?;
        }
        Ok(SnapshotInput::Recovered(state))
    }
    fn save(&self, state: &Arc<S>) -> impl std::future::Future<Output = Result<(), Self::Error>> {
        *self.core.latest_state.borrow_mut() = Some(Arc::clone(state));
        async { Ok(()) }
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Arc<S>> {
        match (self.core.options.parse)(raw) {
            Some(state) => Migrated::State(state),
            None => Migrated::Fresh,
        }
    }
}
impl<S, M, C, U, X, P: DurableObjectStorage + 'static, E>
    EventSourcedStore<'_, S, M, C, U, X, P, E>
{
    pub fn read_events(&self, range: EventLogRange) -> ReadEvents<'_, P, M, E> {
        self.store.core.reader(range)
    }
}
impl<
    S: 'static,
    M: 'static,
    C: 'static,
    U: 'static,
    X: 'static,
    P: DurableObjectStorage + 'static,
    E: 'static,
> EventSourcedStore<'static, S, M, C, U, X, P, E>
{
    fn ensure_last_seq(&self) -> LocalBoxFuture<'static, Result<f64, DoStoreError<P::Error, E>>> {
        let core = Rc::clone(&self.store.core);
        request(async move {
            if core.last_seq.get().is_none() {
                let seq = core.read_meta().await?;
                core.last_seq.set(Some(seq));
            }
            Ok(core.last_seq.get().expect("meta initializes the sequence"))
        })
        .map(|value| value.map_err(completion_error))
        .boxed_local()
    }
    pub fn append(
        &self,
        msg: Arc<M>,
    ) -> LocalBoxFuture<'static, Result<(), DoStoreError<P::Error, E>>> {
        let sequence = self.ensure_last_seq();
        let core = Rc::clone(&self.store.core);
        request(async move {
            let seq = sequence.await? + 1.0;
            core.last_seq.set(Some(seq));
            let msg = (core.options.encode_event)(&msg).map_err(DoStoreError::Encode)?;
            core.put(event_key(&core.event_prefix, seq), encoded_json(msg))
                .await?;
            core.put(
                core.meta_key.clone(),
                encoded_json(PlainData::Object(indexmap::IndexMap::from([(
                    "lastSeq".into(),
                    PlainData::Number(seq),
                )]))),
            )
            .await?;
            let state = core.latest_state.borrow().clone();
            if seq - core.snapshot_seq.get() >= core.every
                && let Some(state) = state
            {
                core.write_snapshot(seq, state).await?;
            }
            Ok(())
        })
        .map(|value| value.map_err(completion_error))
        .boxed_local()
    }
    pub fn snapshot_now(&self) -> LocalBoxFuture<'static, Result<bool, DoStoreError<P::Error, E>>> {
        let sequence = self.ensure_last_seq();
        let core = Rc::clone(&self.store.core);
        request(async move {
            let seq = sequence.await?;
            let state = core.latest_state.borrow().clone();
            let Some(state) = state else {
                return Ok(false);
            };
            if seq <= core.snapshot_seq.get() {
                return Ok(false);
            }
            core.write_snapshot(seq, state).await?;
            Ok(true)
        })
        .map(|value| value.map_err(completion_error))
        .boxed_local()
    }
}
fn event_key(prefix: &JsText, seq: f64) -> JsText {
    let seq = number_string(seq);
    let mut key = prefix.as_units().to_vec();
    key.extend(std::iter::repeat_n(48, 16_usize.saturating_sub(seq.len())));
    key.extend(seq.encode_utf16());
    JsText::from_units(key)
}
pub struct ReadEvents<'a, P, M, E> {
    storage: Rc<P>,
    parse: &'a dyn Fn(PlainData) -> Option<M>,
    prefix: JsText,
    range: EventLogRange,
    rows: Option<std::vec::IntoIter<(JsText, PlainData)>>,
    done: bool,
    error: PhantomData<fn() -> E>,
}
impl<P: DurableObjectStorage + 'static, M, E> ReadEvents<'_, P, M, E> {
    pub async fn next(&mut self) -> Option<Result<PersistedEvent<M>, DoStoreError<P::Error, E>>> {
        if self.done {
            return None;
        }
        let result = self.advance().await;
        match result {
            Ok(Some(row)) => Some(Ok(row)),
            Ok(None) => {
                self.done = true;
                None
            }
            Err(error) => {
                self.done = true;
                Some(Err(error))
            }
        }
    }
    async fn advance(&mut self) -> Result<Option<PersistedEvent<M>>, DoStoreError<P::Error, E>> {
        if self.rows.is_none() {
            let storage = Rc::clone(&self.storage);
            let prefix = self.prefix.clone();
            let rows = request(async move { storage.list(prefix).await })
                .await
                .map_err(|error| request_error(error, "list"))?;
            self.rows = Some(rows.into_iter());
        }
        for (key, value) in self.rows.as_mut().unwrap() {
            let suffix = JsText::from_units(
                key.as_units()[self.prefix.as_units().len().min(key.as_units().len())..].to_vec(),
            );
            let seq =
                js_record::number(&PlainData::String(suffix)).map_err(DoStoreError::Coercion)?;
            if !seq.is_finite()
                || seq < self.range.from_seq.unwrap_or(f64::NEG_INFINITY)
                || seq > self.range.to_seq.unwrap_or(f64::INFINITY)
            {
                continue;
            }
            let value = stored_json(value)?;
            if let Some(event) = (self.parse)(value) {
                return Ok(Some(PersistedEvent { seq, event }));
            }
        }
        Ok(None)
    }
}
