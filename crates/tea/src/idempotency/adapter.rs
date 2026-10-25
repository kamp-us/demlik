use super::{IdempotencyStore, IdempotencyTime, StoreOptions};
use crate::{
    data::JsText,
    js_record::{JsAccessError, ProjectionFailure, RecordCodec},
};

#[derive(Debug)]
pub enum MemoryError {
    Access(JsAccessError),
    Projection(ProjectionFailure),
}
impl From<JsAccessError> for MemoryError {
    fn from(error: JsAccessError) -> Self {
        Self::Access(error)
    }
}

pub struct IdempotencyMemory<'a, V> {
    codec: RecordCodec<'a, V>,
}
pub fn idempotency_memory<'a, V>() -> IdempotencyMemory<'a, V> {
    IdempotencyMemory {
        codec: RecordCodec::refusing(),
    }
}
impl<'a, V> IdempotencyMemory<'a, V> {
    pub fn with_codec(mut self, codec: RecordCodec<'a, V>) -> Self {
        self.codec = codec;
        self
    }
    pub fn init(&self, options: StoreOptions) -> IdempotencyStore<V> {
        super::init_store(options)
    }
    pub fn is_seen(
        &self,
        store: &IdempotencyStore<V>,
        key: impl Into<JsText>,
        at: impl Into<IdempotencyTime>,
    ) -> Result<bool, JsAccessError> {
        super::seen_with_projection(store, key, at, |value| self.codec.project(value))
    }
    pub fn recall(
        &self,
        store: &IdempotencyStore<V>,
        key: impl Into<JsText>,
        at: impl Into<IdempotencyTime>,
    ) -> Result<Option<V>, MemoryError>
    where
        V: Clone,
    {
        super::recall_with_projection(store, key, at, |value| self.codec.project(value))?
            .map(|value| self.codec.read(value).map_err(MemoryError::Projection))
            .transpose()
    }
    pub fn remember(
        &self,
        store: &IdempotencyStore<V>,
        key: impl Into<JsText>,
        value: V,
        at: impl Into<IdempotencyTime>,
    ) -> Result<IdempotencyStore<V>, JsAccessError>
    where
        V: Clone,
    {
        super::remember_with_projection(store, key, value, at, |value| self.codec.project(value))
    }
    pub fn evict(
        &self,
        store: &IdempotencyStore<V>,
        at: impl Into<IdempotencyTime>,
    ) -> Result<IdempotencyStore<V>, JsAccessError>
    where
        V: Clone,
    {
        super::evict_expired_with_projection(store, at, |value| self.codec.project(value))
    }
}
