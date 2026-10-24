use crate::data::JsText;
use serde::{Deserialize, Serialize};

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
    pub at_ms: f64,
}
impl<V: Serialize> RecordEntry for IdempotencyEntry<V> {
    type Value = V;
    const TIMESTAMP_KEY: &'static str = "atMs";
    fn payload(&self) -> &V {
        &self.value
    }
    fn timestamp(&self) -> f64 {
        self.at_ms
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyStore<V> {
    pub entries: JsRecord<IdempotencyEntry<V>>,
    pub order: Vec<JsText>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<f64>,
}

pub fn init_store<V>(options: StoreOptions) -> IdempotencyStore<V> {
    IdempotencyStore {
        entries: JsRecord::default(),
        order: Vec::new(),
        capacity: options.capacity,
        ttl_ms: options.ttl_ms,
    }
}

fn live<'a, V: Serialize>(
    store: &'a IdempotencyStore<V>,
    key: &JsText,
    now_ms: f64,
) -> Result<Option<Resolved<'a, IdempotencyEntry<V>>>, JsAccessError> {
    let entry = store.entries.resolve(key)?;
    if entry.missing() {
        return Ok(None);
    }
    if let Some(ttl) = store.ttl_ms {
        if now_ms - entry.timestamp()? >= ttl {
            return Ok(None);
        }
    }
    Ok(Some(entry))
}

pub fn seen<V: Serialize>(
    store: &IdempotencyStore<V>,
    key: impl Into<JsText>,
    now_ms: f64,
) -> Result<bool, JsAccessError> {
    Ok(live(store, &key.into(), now_ms)?.is_some())
}

pub fn recall<'a, V: Serialize>(
    store: &'a IdempotencyStore<V>,
    key: impl Into<JsText>,
    now_ms: f64,
) -> Result<Option<JsRead<'a, V>>, JsAccessError> {
    match live(store, &key.into(), now_ms)? {
        Some(entry) => entry.payload(),
        None => Ok(None),
    }
}

pub fn evict_expired<V: Clone + Serialize>(
    store: &IdempotencyStore<V>,
    now_ms: f64,
) -> Result<IdempotencyStore<V>, JsAccessError> {
    let Some(ttl) = store.ttl_ms else {
        return Ok(store.clone());
    };
    let mut next = IdempotencyStore {
        entries: JsRecord::default(),
        order: Vec::new(),
        capacity: store.capacity,
        ttl_ms: store.ttl_ms,
    };
    for key in &store.order {
        let entry = store.entries.resolve(key)?;
        if entry.missing() || now_ms - entry.timestamp()? >= ttl {
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
    now_ms: f64,
) -> Result<IdempotencyStore<V>, JsAccessError> {
    let mut next = evict_expired(store, now_ms)?;
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
        while (next.order.len() as f64) > capacity {
            if next.order.is_empty() {
                break;
            }
            let oldest = next.order.remove(0);
            next.entries.delete(&oldest);
        }
    }
    Ok(next)
}
