use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

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
impl<V> IdempotencyEntry<V> {
    fn expired(&self, now_ms: f64, ttl_ms: Option<f64>) -> bool {
        ttl_ms.is_some_and(|ttl| now_ms - self.at_ms >= ttl)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyStore<V> {
    pub entries: IndexMap<String, IdempotencyEntry<V>>,
    pub order: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<f64>,
}

pub fn init_store<V>(options: StoreOptions) -> IdempotencyStore<V> {
    IdempotencyStore {
        entries: IndexMap::new(),
        order: Vec::new(),
        capacity: options.capacity,
        ttl_ms: options.ttl_ms,
    }
}

pub fn seen<V>(store: &IdempotencyStore<V>, key: &str, now_ms: f64) -> bool {
    recall(store, key, now_ms).is_some()
}

pub fn recall<'a, V>(store: &'a IdempotencyStore<V>, key: &str, now_ms: f64) -> Option<&'a V> {
    store
        .entries
        .get(key)
        .filter(|entry| !entry.expired(now_ms, store.ttl_ms))
        .map(|entry| &entry.value)
}

pub fn evict_expired<V: Clone>(store: &IdempotencyStore<V>, now_ms: f64) -> IdempotencyStore<V> {
    if store.ttl_ms.is_none() {
        return store.clone();
    }
    let mut next = IdempotencyStore {
        entries: IndexMap::new(),
        order: Vec::new(),
        capacity: store.capacity,
        ttl_ms: store.ttl_ms,
    };
    for key in &store.order {
        if let Some(entry) = store
            .entries
            .get(key)
            .filter(|entry| !entry.expired(now_ms, store.ttl_ms))
        {
            next.entries.insert(key.clone(), entry.clone());
            next.order.push(key.clone());
        }
    }
    next
}

pub fn remember<V: Clone>(
    store: &IdempotencyStore<V>,
    key: impl Into<String>,
    value: V,
    now_ms: f64,
) -> IdempotencyStore<V> {
    let mut next = evict_expired(store, now_ms);
    let key = key.into();
    next.entries.insert(
        key.clone(),
        IdempotencyEntry {
            value,
            at_ms: now_ms,
        },
    );
    next.order.retain(|old| old != &key);
    next.order.push(key);
    if let Some(capacity) = store.capacity {
        while (next.order.len() as f64) > capacity {
            if next.order.is_empty() {
                break;
            }
            let oldest = next.order.remove(0);
            next.entries.shift_remove(&oldest);
        }
    }
    next
}
