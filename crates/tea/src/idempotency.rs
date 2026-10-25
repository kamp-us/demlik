use crate::data::JsText;
pub use crate::work_queue::QueueTime as IdempotencyNumber;
pub type IdempotencyTime = IdempotencyNumber;
use serde::{Deserialize, Serialize};
mod adapter;
pub use adapter::*;

use crate::js_record::{JsAccessError, JsRead, JsRecord, RecordEntry, RecordValue, Resolved};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyEntry<V> {
    pub value: V,
    pub at_ms: IdempotencyTime,
}
impl<V> RecordEntry for IdempotencyEntry<V> {
    type Value = V;
    const TIMESTAMP_KEY: &'static str = "atMs";
    fn payload(&self) -> &V {
        &self.value
    }
    fn timestamp(&self) -> f64 {
        self.at_ms.number_or_zero()
    }
    fn timestamp_data(&self) -> crate::PlainData {
        self.at_ms
            .number()
            .map_or(crate::PlainData::Null, crate::PlainData::Number)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyStore<V> {
    pub entries: JsRecord<IdempotencyEntry<V>>,
    pub order: Vec<JsText>,
    #[serde(
        default,
        deserialize_with = "deserialize_bound",
        skip_serializing_if = "Option::is_none"
    )]
    pub capacity: Option<IdempotencyNumber>,
    #[serde(
        default,
        deserialize_with = "deserialize_bound",
        skip_serializing_if = "Option::is_none"
    )]
    pub ttl_ms: Option<IdempotencyNumber>,
}

fn deserialize_bound<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<IdempotencyNumber>, D::Error> {
    IdempotencyNumber::deserialize(deserializer).map(Some)
}

pub fn init_store<V>(options: StoreOptions) -> IdempotencyStore<V> {
    IdempotencyStore {
        entries: JsRecord::default(),
        order: Vec::new(),
        capacity: options.capacity.map(Into::into),
        ttl_ms: options.ttl_ms.map(Into::into),
    }
}

fn live<'a, V>(
    store: &'a IdempotencyStore<V>,
    key: &JsText,
    now_ms: IdempotencyTime,
    project: impl FnOnce(&V) -> Result<crate::PlainData, JsAccessError>,
) -> Result<Option<Resolved<'a, IdempotencyEntry<V>>>, JsAccessError> {
    let entry = store.entries.resolve_with(key, project)?;
    if entry.missing() {
        return Ok(None);
    }
    if let Some(ttl) = store.ttl_ms
        && now_ms.number_or_zero() - entry.timestamp()? >= ttl.number_or_zero()
    {
        return Ok(None);
    }
    Ok(Some(entry))
}

pub fn seen<V: Serialize>(
    store: &IdempotencyStore<V>,
    key: impl Into<JsText>,
    now_ms: impl Into<IdempotencyTime>,
) -> Result<bool, JsAccessError> {
    seen_with_projection(store, key, now_ms, crate::js_record::plain)
}
pub fn seen_with_projection<V>(
    store: &IdempotencyStore<V>,
    key: impl Into<JsText>,
    now_ms: impl Into<IdempotencyTime>,
    project: impl FnOnce(&V) -> Result<crate::PlainData, JsAccessError>,
) -> Result<bool, JsAccessError> {
    Ok(live(store, &key.into(), now_ms.into(), project)?.is_some())
}

pub fn recall<'a, V: Serialize>(
    store: &'a IdempotencyStore<V>,
    key: impl Into<JsText>,
    now_ms: impl Into<IdempotencyTime>,
) -> Result<Option<JsRead<'a, V>>, JsAccessError> {
    recall_with_projection(store, key, now_ms, crate::js_record::plain)
}
pub fn recall_with_projection<'a, V>(
    store: &'a IdempotencyStore<V>,
    key: impl Into<JsText>,
    now_ms: impl Into<IdempotencyTime>,
    project: impl FnOnce(&V) -> Result<crate::PlainData, JsAccessError>,
) -> Result<Option<JsRead<'a, V>>, JsAccessError> {
    match live(store, &key.into(), now_ms.into(), project)? {
        Some(entry) => entry.payload(),
        None => Ok(None),
    }
}

pub fn evict_expired<V: Clone + Serialize>(
    store: &IdempotencyStore<V>,
    now_ms: impl Into<IdempotencyTime>,
) -> Result<IdempotencyStore<V>, JsAccessError> {
    evict_expired_with_projection(store, now_ms, crate::js_record::plain)
}
pub fn evict_expired_with_projection<V: Clone>(
    store: &IdempotencyStore<V>,
    now_ms: impl Into<IdempotencyTime>,
    project: impl Fn(&V) -> Result<crate::PlainData, JsAccessError>,
) -> Result<IdempotencyStore<V>, JsAccessError> {
    let Some(ttl) = store.ttl_ms else {
        return Ok(store.clone());
    };
    let now_ms = now_ms.into().number_or_zero();
    let mut next = IdempotencyStore {
        entries: JsRecord::default(),
        order: Vec::new(),
        capacity: store.capacity,
        ttl_ms: store.ttl_ms,
    };
    for key in &store.order {
        let entry = store.entries.resolve_with(key, &project)?;
        if entry.missing() || now_ms - entry.timestamp()? >= ttl.number_or_zero() {
            continue;
        }
        if let Some(entry) = entry.into_owned() {
            next.entries.assign(key.clone(), entry);
            next.order.push(key.clone());
        }
    }
    Ok(next)
}

pub fn remember<V: Clone + Serialize>(
    store: &IdempotencyStore<V>,
    key: impl Into<JsText>,
    value: V,
    now_ms: impl Into<IdempotencyTime>,
) -> Result<IdempotencyStore<V>, JsAccessError> {
    remember_with_projection(store, key, value, now_ms, crate::js_record::plain)
}
pub fn remember_with_projection<V: Clone>(
    store: &IdempotencyStore<V>,
    key: impl Into<JsText>,
    value: V,
    now_ms: impl Into<IdempotencyTime>,
    project: impl Fn(&V) -> Result<crate::PlainData, JsAccessError>,
) -> Result<IdempotencyStore<V>, JsAccessError> {
    let now_ms = now_ms.into();
    let mut next = evict_expired_with_projection(store, now_ms, project)?;
    next.entries = next.entries.spread();
    let key = key.into();
    next.entries.assign(
        key.clone(),
        RecordValue::Entry(IdempotencyEntry {
            value,
            at_ms: now_ms,
        }),
    );
    next.order.retain(|old| old != &key);
    next.order.push(key);
    if let Some(capacity) = store.capacity {
        while (next.order.len() as f64) > capacity.number_or_zero() {
            if next.order.is_empty() {
                break;
            }
            let oldest = next.order.remove(0);
            next.entries.delete(&oldest);
        }
    }
    Ok(next)
}
