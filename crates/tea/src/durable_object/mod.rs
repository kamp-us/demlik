//! Persistence against an implementable storage port, without a DO host or SDK.

use crate::{
    PlainData,
    data::{JsText, decode_json_text, stringify_json},
    js_record::{self, JsAccessError},
    storage::{PanicCause, StoreConflictError},
};
use std::{fmt, future::Future};
mod snapshot;
pub use snapshot::{DoStore, DoStoreOptions, FencedDoStore, do_store, do_store_with};
mod event_sourced;
pub use event_sourced::{
    EventLogRange, EventRecoveryStore, EventSourcedKeys, EventSourcedOptions, EventSourcedResult,
    EventSourcedStore, PersistedEvent, ReadEvents, SnapshotEveryError, SnapshotInput,
    do_event_sourced_store,
};

#[derive(Debug)]
pub enum TransactionError<S, E> {
    Storage(S),
    Body(E),
}
pub trait DurableObjectStorage: Sized {
    type Error;
    fn get(&self, key: JsText) -> impl Future<Output = Result<PlainData, Self::Error>>;
    fn put(&self, key: JsText, value: PlainData) -> impl Future<Output = Result<(), Self::Error>>;
    fn delete(&self, keys: Vec<JsText>) -> impl Future<Output = Result<(), Self::Error>>;
    fn list(
        &self,
        prefix: JsText,
    ) -> impl Future<Output = Result<Vec<(JsText, PlainData)>, Self::Error>>;
    fn transaction<A, E, F>(
        &self,
        effect: impl FnOnce(Self) -> F,
    ) -> impl Future<Output = Result<A, TransactionError<Self::Error, E>>>
    where
        F: Future<Output = Result<A, E>>;
}

#[derive(Debug)]
pub enum DoStoreError<S, C> {
    Storage {
        operation: &'static str,
        cause: S,
    },
    Json {
        raw: PlainData,
        cause: serde_json::Error,
    },
    Coercion(JsAccessError),
    Encode(C),
    Ready(C),
    Conflict(StoreConflictError),
    InvalidVersion(PlainData),
    Fold(crate::NoCellError),
    Panic(PanicCause),
    HostClosed,
}
impl<S: fmt::Display, C: fmt::Display> fmt::Display for DoStoreError<S, C> {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage { cause, .. } => cause.fmt(output),
            Self::Json { cause, .. } => cause.fmt(output),
            Self::Coercion(error) => error.fmt(output),
            Self::Encode(error) => error.fmt(output),
            Self::Ready(error) => error.fmt(output),
            Self::Conflict(error) => error.fmt(output),
            Self::InvalidVersion(_) => output.write_str("durable storage version is not a number"),
            Self::Fold(error) => error.fmt(output),
            Self::Panic(error) => output.write_str(&error.summary),
            Self::HostClosed => {
                output.write_str("durable storage host closed before the operation settled")
            }
        }
    }
}
fn request<T: 'static, E: 'static>(
    effect: impl Future<Output = Result<T, E>> + 'static,
) -> crate::journal::JournalTask<T, E> {
    crate::journal::task::start(
        async move { effect.await.map_err(crate::journal::JournalError::Backend) },
        true,
    )
}
fn request_error<S, C>(
    error: crate::journal::JournalError<S>,
    operation: &'static str,
) -> DoStoreError<S, C> {
    match error {
        crate::journal::JournalError::Backend(cause) => DoStoreError::Storage { operation, cause },
        crate::journal::JournalError::Effect(value) => match value {},
        crate::journal::JournalError::Panic(cause) => DoStoreError::Panic(cause),
        crate::journal::JournalError::HostClosed => DoStoreError::HostClosed,
    }
}
fn completion_error<S, C>(
    error: crate::journal::JournalError<DoStoreError<S, C>>,
) -> DoStoreError<S, C> {
    match error {
        crate::journal::JournalError::Backend(error) => error,
        crate::journal::JournalError::Effect(value) => match value {},
        crate::journal::JournalError::Panic(cause) => DoStoreError::Panic(cause),
        crate::journal::JournalError::HostClosed => DoStoreError::HostClosed,
    }
}
impl<S: fmt::Display + fmt::Debug, C: fmt::Display + fmt::Debug> std::error::Error
    for DoStoreError<S, C>
{
}
fn stored_json<S, C>(raw: PlainData) -> Result<PlainData, DoStoreError<S, C>> {
    let value = js_record::string(&raw).map_err(DoStoreError::Coercion)?;
    decode_json_text(&value).map_err(|cause| DoStoreError::Json { raw, cause })
}
fn encoded_json(value: PlainData) -> PlainData {
    stringify_json(&value).map_or(PlainData::Undefined, |value| {
        PlainData::String(value.into())
    })
}
fn version<S, C>(raw: PlainData) -> Result<f64, DoStoreError<S, C>> {
    match raw {
        PlainData::Null | PlainData::Undefined => Ok(0.0),
        PlainData::Number(value) => Ok(value),
        value => Err(DoStoreError::InvalidVersion(value)),
    }
}
