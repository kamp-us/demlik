use std::any::Any;
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use futures::{FutureExt, future::LocalBoxFuture};
use serde::Serialize;
use serde_json::Value;

use crate::PlainData;
mod cell;
pub use cell::{StoredArray, StoredCell, StoredObject};

pub trait Nullish {
    fn is_nullish(&self) -> bool;
}
impl Nullish for Value {
    fn is_nullish(&self) -> bool {
        self.is_null()
    }
}
impl Nullish for PlainData {
    fn is_nullish(&self) -> bool {
        matches!(self, Self::Null | Self::Undefined)
    }
}
impl<T> Nullish for Option<T> {
    fn is_nullish(&self) -> bool {
        self.is_none()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Refusal {
    #[serde(rename = "_tag")]
    tag: &'static str,
    pub reason: String,
}
pub fn refuse(reason: impl Into<String>) -> Refusal {
    Refusal {
        tag: "refusal",
        reason: reason.into(),
    }
}
impl Refusal {
    pub fn tag(&self) -> &'static str {
        self.tag
    }
}

#[derive(Debug)]
pub enum Migrated<S> {
    Fresh,
    State(S),
    Refused(Refusal),
}

pub struct FencedRead<R> {
    pub raw: R,
    pub version: StoredCell,
}
pub trait Fencing<S> {
    type Raw;
    type Error;
    fn load_fenced(&self) -> LocalBoxFuture<'_, Result<FencedRead<Self::Raw>, Self::Error>>;
    fn save_fenced<'a>(
        &'a self,
        state: &'a S,
        expected_version: StoredCell,
    ) -> LocalBoxFuture<'a, Result<StoredCell, Self::Error>>;
}
pub trait Store<S> {
    type Raw;
    type Error;
    fn load(&self) -> impl Future<Output = Result<Self::Raw, Self::Error>>;
    fn save(&self, state: &S) -> impl Future<Output = Result<(), Self::Error>>;
    fn migrate(&self, raw: Self::Raw) -> Migrated<S>;
    fn restore_failure(&self, cause: RestoreCause<Self::Error>) -> StoreRefusedError<Self::Error>
    where
        Self::Error: fmt::Display,
    {
        let description = match &cause {
            RestoreCause::Load(error) => error.to_string(),
            RestoreCause::Panic(error) => error.summary.clone(),
        };
        StoreRefusedError {
            reason: format!("the saved state could not be read ({description})"),
            cause: Some(cause),
        }
    }
    fn fencing(&self) -> Option<&dyn Fencing<S, Raw = Self::Raw, Error = Self::Error>> {
        None
    }
}
pub trait DeletableStore<S>: Store<S> {
    fn delete(&self) -> impl Future<Output = Result<(), Self::Error>>;
}
pub fn is_fenced_store<S>(store: &impl Store<S>) -> bool {
    store.fencing().is_some()
}

pub struct PanicCause {
    pub summary: String,
    payload: Mutex<Box<dyn Any + Send>>,
}
impl PanicCause {
    pub fn new(payload: Box<dyn Any + Send>) -> Self {
        let summary = payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|value| (*value).into()))
            .or_else(|| {
                payload
                    .downcast_ref::<Box<dyn std::error::Error + Send>>()
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "non-string panic".into());
        Self {
            summary,
            payload: Mutex::new(payload),
        }
    }
    pub fn with_payload<R>(&self, read: impl FnOnce(&(dyn Any + Send)) -> R) -> R {
        read(
            &**self
                .payload
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
}
impl fmt::Debug for PanicCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PanicCause")
            .field("summary", &self.summary)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub enum RestoreCause<E> {
    Load(E),
    Panic(PanicCause),
}
#[derive(Debug)]
pub struct StoreRefusedError<E> {
    pub reason: String,
    pub cause: Option<RestoreCause<E>>,
}
impl<E> StoreRefusedError<E> {
    pub fn name(&self) -> &'static str {
        "StoreRefusedError"
    }
    pub fn tag(&self) -> &'static str {
        "store_refused"
    }
}
impl<E: Serialize> Serialize for StoreRefusedError<E> {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        use serde::ser::SerializeMap;
        let mut fields = serializer.serialize_map(None)?;
        fields.serialize_entry("name", self.name())?;
        fields.serialize_entry("_tag", self.tag())?;
        fields.serialize_entry("message", &self.to_string())?;
        fields.serialize_entry("reason", &self.reason)?;
        match &self.cause {
            Some(RestoreCause::Load(cause)) => fields.serialize_entry("cause", cause)?,
            Some(RestoreCause::Panic(cause)) => fields.serialize_entry("cause", &cause.summary)?,
            None => {}
        }
        fields.end()
    }
}
impl<E> fmt::Display for StoreRefusedError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "@demlik/tea: store refused — {}. The saved state was not restored and nothing was written.",
            self.reason
        )
    }
}
impl<E: fmt::Debug> std::error::Error for StoreRefusedError<E> {}

pub async fn restore<S, P: Store<S>>(store: &P) -> Result<Option<S>, StoreRefusedError<P::Error>>
where
    P::Error: fmt::Display,
{
    let raw = match AssertUnwindSafe(async { store.load().await })
        .catch_unwind()
        .await
    {
        Ok(Ok(raw)) => raw,
        Ok(Err(error)) => {
            return Err(store.restore_failure(RestoreCause::Load(error)));
        }
        Err(payload) => {
            let panic = PanicCause::new(payload);
            return Err(store.restore_failure(RestoreCause::Panic(panic)));
        }
    };
    match std::panic::catch_unwind(AssertUnwindSafe(|| store.migrate(raw))) {
        Ok(Migrated::Fresh) => Ok(None),
        Ok(Migrated::State(state)) => Ok(Some(state)),
        Ok(Migrated::Refused(refusal)) => Err(StoreRefusedError {
            reason: refusal.reason,
            cause: None,
        }),
        Err(payload) => {
            let panic = PanicCause::new(payload);
            Err(store.restore_failure(RestoreCause::Panic(panic)))
        }
    }
}

pub fn schema_migrate<R: Nullish, S, E>(
    parse: impl Fn(R) -> Result<S, E>,
) -> impl Fn(R) -> Migrated<S> {
    move |raw| {
        if raw.is_nullish() {
            return Migrated::Fresh;
        }
        match parse(raw) {
            Ok(state) => Migrated::State(state),
            Err(_) => Migrated::Refused(refuse("the saved state does not match the schema")),
        }
    }
}
pub fn schema_migrate_with_upcast<R: Nullish, Q, S, P, U, E, F>(
    parse: P,
    upcast: U,
) -> impl Fn(R) -> Migrated<S>
where
    P: Fn(Q) -> Result<S, E>,
    U: Fn(R) -> Result<Q, F>,
    F: fmt::Display,
{
    move |raw| {
        if raw.is_nullish() {
            return Migrated::Fresh;
        }
        let value = match std::panic::catch_unwind(AssertUnwindSafe(|| upcast(raw))) {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                return Migrated::Refused(refuse(format!(
                    "upcast threw on the saved state ({error})"
                )));
            }
            Err(payload) => {
                return Migrated::Refused(refuse(format!(
                    "upcast threw on the saved state ({})",
                    PanicCause::new(payload).summary
                )));
            }
        };
        match parse(value) {
            Ok(state) => Migrated::State(state),
            Err(_) => Migrated::Refused(refuse("the saved state does not match the schema")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct StoreConflictError {
    pub expected_version: StoredCell,
    pub actual_version: StoredCell,
    message: Box<crate::data::JsText>,
}
impl StoreConflictError {
    pub fn new(
        expected_version: impl Into<StoredCell>,
        actual_version: impl Into<StoredCell>,
    ) -> Result<Self, crate::js_record::JsAccessError> {
        let expected_version = expected_version.into();
        let actual_version = actual_version.into();
        let expected = crate::js_record::string(&expected_version.snapshot())?;
        let actual = crate::js_record::string(&actual_version.snapshot())?;
        let mut message = "@demlik/tea: store conflict — expected version "
            .encode_utf16()
            .collect::<Vec<_>>();
        message.extend_from_slice(expected.as_units());
        message.extend(", found ".encode_utf16());
        message.extend_from_slice(actual.as_units());
        message.extend(". Another process has written this state; this run is no longer the single writer and has stopped.".encode_utf16());
        Ok(Self {
            expected_version,
            actual_version,
            message: Box::new(crate::data::JsText::from_units(message)),
        })
    }
    pub fn message(&self) -> &crate::data::JsText {
        &self.message
    }
    pub fn name(&self) -> &'static str {
        "StoreConflictError"
    }
    pub fn tag(&self) -> &'static str {
        "store_conflict"
    }
}
impl Serialize for StoreConflictError {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        use serde::ser::SerializeStruct;
        let mut fields = serializer.serialize_struct("StoreConflictError", 5)?;
        fields.serialize_field("name", self.name())?;
        fields.serialize_field("_tag", self.tag())?;
        fields.serialize_field("message", &self.message)?;
        fields.serialize_field("expectedVersion", &self.expected_version)?;
        fields.serialize_field("actualVersion", &self.actual_version)?;
        fields.end()
    }
}
pub(crate) fn number_string(value: f64) -> String {
    if value == 0.0 {
        "0".into()
    } else {
        ryu_js::Buffer::new().format(value).into()
    }
}
impl fmt::Display for StoreConflictError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&String::from_utf16_lossy(self.message.as_units()))
    }
}
impl std::error::Error for StoreConflictError {}

#[derive(Debug)]
pub enum MemoryStoreError {
    Conflict(StoreConflictError),
    Coercion(crate::js_record::JsAccessError),
    Poisoned,
}
impl fmt::Display for MemoryStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict(error) => error.fmt(f),
            Self::Coercion(error) => error.fmt(f),
            Self::Poisoned => f.write_str("memory store cell lock poisoned"),
        }
    }
}
impl std::error::Error for MemoryStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Conflict(cause) => Some(cause),
            Self::Coercion(cause) => Some(cause),
            Self::Poisoned => None,
        }
    }
}
impl MemoryStoreError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Conflict(error) => error.name(),
            Self::Coercion(error) => error.name,
            Self::Poisoned => "MemoryStoreError",
        }
    }
    pub fn tag(&self) -> Option<&'static str> {
        match self {
            Self::Conflict(error) => Some(error.tag()),
            Self::Coercion(_) => None,
            Self::Poisoned => Some("memory_store_poisoned"),
        }
    }
}
impl Serialize for MemoryStoreError {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        match self {
            Self::Conflict(error) => error.serialize(serializer),
            Self::Coercion(error) => error.serialize(serializer),
            Self::Poisoned => serde_json::json!({ "name": self.name(), "_tag": self.tag(), "message": self.to_string() }).serialize(serializer),
        }
    }
}

struct Cell<S> {
    state: Option<S>,
    version: f64,
}
pub struct MemoryStore<S, F = fn(Option<S>) -> Migrated<S>> {
    cell: Arc<Mutex<Cell<S>>>,
    parse: Arc<F>,
}
impl<S, F> Clone for MemoryStore<S, F> {
    fn clone(&self) -> Self {
        Self {
            cell: Arc::clone(&self.cell),
            parse: Arc::clone(&self.parse),
        }
    }
}
pub fn memory_store<S>(initial: Option<S>) -> MemoryStore<S> {
    MemoryStore::with_parser(initial, |state| match state {
        Some(state) => Migrated::State(state),
        None => Migrated::Fresh,
    })
}
impl<S, F> MemoryStore<S, F> {
    pub fn with_parser(initial: Option<S>, parse: F) -> Self {
        Self {
            cell: Arc::new(Mutex::new(Cell {
                state: initial,
                version: 0.0,
            })),
            parse: Arc::new(parse),
        }
    }
    pub fn fenced(self) -> FencedMemoryStore<S, F> {
        FencedMemoryStore(self)
    }
}
impl<S: Clone, F: Fn(Option<S>) -> Migrated<S>> Store<S> for MemoryStore<S, F> {
    type Raw = Option<S>;
    type Error = MemoryStoreError;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self
            .cell
            .lock()
            .map_err(|_| MemoryStoreError::Poisoned)?
            .state
            .clone())
    }
    async fn save(&self, state: &S) -> Result<(), Self::Error> {
        let mut cell = self.cell.lock().map_err(|_| MemoryStoreError::Poisoned)?;
        cell.state = Some(state.clone());
        cell.version += 1.0;
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<S> {
        (self.parse)(raw)
    }
}
impl<S: Clone, F: Fn(Option<S>) -> Migrated<S>> DeletableStore<S> for MemoryStore<S, F> {
    async fn delete(&self) -> Result<(), Self::Error> {
        let mut cell = self.cell.lock().map_err(|_| MemoryStoreError::Poisoned)?;
        cell.state = None;
        cell.version = 0.0;
        Ok(())
    }
}

pub struct FencedMemoryStore<S, F = fn(Option<S>) -> Migrated<S>>(MemoryStore<S, F>);
impl<S, F> Clone for FencedMemoryStore<S, F> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<S: Clone, F: Fn(Option<S>) -> Migrated<S>> Store<S> for FencedMemoryStore<S, F> {
    type Raw = Option<S>;
    type Error = MemoryStoreError;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        self.0.load().await
    }
    async fn save(&self, state: &S) -> Result<(), Self::Error> {
        self.0.save(state).await
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<S> {
        self.0.migrate(raw)
    }
    fn fencing(&self) -> Option<&dyn Fencing<S, Raw = Self::Raw, Error = Self::Error>> {
        Some(self)
    }
}
impl<S: Clone, F: Fn(Option<S>) -> Migrated<S>> DeletableStore<S> for FencedMemoryStore<S, F> {
    async fn delete(&self) -> Result<(), Self::Error> {
        self.0.delete().await
    }
}
impl<S: Clone, F: Fn(Option<S>) -> Migrated<S>> Fencing<S> for FencedMemoryStore<S, F> {
    type Raw = Option<S>;
    type Error = MemoryStoreError;
    fn load_fenced(&self) -> LocalBoxFuture<'_, Result<FencedRead<Self::Raw>, Self::Error>> {
        async move {
            let cell = self.0.cell.lock().map_err(|_| MemoryStoreError::Poisoned)?;
            Ok(FencedRead {
                raw: cell.state.clone(),
                version: StoredCell::Number(cell.version),
            })
        }
        .boxed_local()
    }
    fn save_fenced<'a>(
        &'a self,
        state: &'a S,
        expected_version: StoredCell,
    ) -> LocalBoxFuture<'a, Result<StoredCell, Self::Error>> {
        async move {
            let mut cell = self.0.cell.lock().map_err(|_| MemoryStoreError::Poisoned)?;
            if StoredCell::Number(cell.version) != expected_version {
                let actual = cell.version;
                drop(cell);
                return Err(MemoryStoreError::Conflict(
                    StoreConflictError::new(expected_version, actual)
                        .map_err(MemoryStoreError::Coercion)?,
                ));
            }
            cell.state = Some(state.clone());
            cell.version += 1.0;
            Ok(StoredCell::Number(cell.version))
        }
        .boxed_local()
    }
}
