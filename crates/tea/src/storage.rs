use std::any::Any;
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use futures::{FutureExt, future::LocalBoxFuture};
use serde::Serialize;
use serde_json::Value;

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

#[derive(Debug)]
pub enum Migrated<S> {
    Fresh,
    State(S),
    Refused(Refusal),
}

pub struct FencedRead<R> {
    pub raw: R,
    pub version: f64,
}
pub trait Fencing<S> {
    type Raw;
    type Error;
    fn load_fenced(&self) -> LocalBoxFuture<'_, Result<FencedRead<Self::Raw>, Self::Error>>;
    fn save_fenced<'a>(
        &'a self,
        state: &'a S,
        expected_version: f64,
    ) -> LocalBoxFuture<'a, Result<f64, Self::Error>>;
}
pub trait Store<S> {
    type Raw;
    type Error;
    fn load(&self) -> impl Future<Output = Result<Self::Raw, Self::Error>>;
    fn save(&self, state: &S) -> impl Future<Output = Result<(), Self::Error>>;
    fn migrate(&self, raw: Self::Raw) -> Migrated<S>;
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
    let raw = match AssertUnwindSafe(store.load()).catch_unwind().await {
        Ok(Ok(raw)) => raw,
        Ok(Err(error)) => {
            return Err(StoreRefusedError {
                reason: format!("the saved state could not be read ({error})"),
                cause: Some(RestoreCause::Load(error)),
            });
        }
        Err(payload) => {
            let panic = PanicCause::new(payload);
            return Err(StoreRefusedError {
                reason: format!("the saved state could not be read ({})", panic.summary),
                cause: Some(RestoreCause::Panic(panic)),
            });
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
            Err(StoreRefusedError {
                reason: format!("the saved state could not be read ({})", panic.summary),
                cause: Some(RestoreCause::Panic(panic)),
            })
        }
    }
}

pub fn schema_migrate<S, E>(
    parse: impl Fn(Value) -> Result<S, E>,
) -> impl Fn(Value) -> Migrated<S> {
    move |raw| {
        if raw.is_null() {
            return Migrated::Fresh;
        }
        match parse(raw) {
            Ok(state) => Migrated::State(state),
            Err(_) => Migrated::Refused(refuse("the saved state does not match the schema")),
        }
    }
}
pub fn schema_migrate_with_upcast<S, P, U, E, F>(
    parse: P,
    upcast: U,
) -> impl Fn(Value) -> Migrated<S>
where
    P: Fn(Value) -> Result<S, E>,
    U: Fn(Value) -> Result<Value, F>,
    F: fmt::Display,
{
    move |raw| {
        if raw.is_null() {
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreConflictError {
    pub expected_version: f64,
    pub actual_version: f64,
}
impl fmt::Display for StoreConflictError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "@demlik/tea: store conflict — expected version {}, found {}. Another process has written this state; this run is no longer the single writer and has stopped.",
            ryu_js::Buffer::new().format(self.expected_version),
            ryu_js::Buffer::new().format(self.actual_version)
        )
    }
}
impl std::error::Error for StoreConflictError {}

#[derive(Debug)]
pub enum MemoryStoreError {
    Conflict(StoreConflictError),
    Poisoned,
}
impl fmt::Display for MemoryStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict(error) => error.fmt(f),
            Self::Poisoned => f.write_str("memory store cell lock poisoned"),
        }
    }
}
impl std::error::Error for MemoryStoreError {}

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
                version: cell.version,
            })
        }
        .boxed_local()
    }
    fn save_fenced<'a>(
        &'a self,
        state: &'a S,
        expected_version: f64,
    ) -> LocalBoxFuture<'a, Result<f64, Self::Error>> {
        async move {
            let mut cell = self.0.cell.lock().map_err(|_| MemoryStoreError::Poisoned)?;
            if cell.version != expected_version {
                return Err(MemoryStoreError::Conflict(StoreConflictError {
                    expected_version,
                    actual_version: cell.version,
                }));
            }
            cell.state = Some(state.clone());
            cell.version += 1.0;
            Ok(cell.version)
        }
        .boxed_local()
    }
}
