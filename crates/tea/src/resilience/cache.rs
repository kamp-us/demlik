use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry<V> {
    pub value: V,
    pub expires_at_ms: f64,
}
impl<V> CacheEntry<V> {
    fn expired(&self, now_ms: f64) -> bool {
        now_ms >= self.expires_at_ms
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TtlCache<V> {
    pub entries: IndexMap<String, CacheEntry<V>>,
}

pub fn init_cache<V>() -> TtlCache<V> {
    TtlCache {
        entries: IndexMap::new(),
    }
}

pub fn get<'a, V>(cache: &'a TtlCache<V>, key: &str, now_ms: f64) -> Option<&'a V> {
    cache
        .entries
        .get(key)
        .filter(|entry| !entry.expired(now_ms))
        .map(|entry| &entry.value)
}

pub fn has<V>(cache: &TtlCache<V>, key: &str, now_ms: f64) -> bool {
    get(cache, key, now_ms).is_some()
}

pub fn set<V: Clone>(
    cache: &TtlCache<V>,
    key: impl Into<String>,
    value: V,
    now_ms: f64,
    ttl_ms: f64,
) -> TtlCache<V> {
    let mut next = cache.clone();
    next.entries.insert(
        key.into(),
        CacheEntry {
            value,
            expires_at_ms: now_ms + ttl_ms,
        },
    );
    next
}

pub fn remove<V: Clone>(cache: &TtlCache<V>, key: &str) -> TtlCache<V> {
    let mut next = cache.clone();
    next.entries.shift_remove(key);
    next
}

pub fn evict_expired<V: Clone>(cache: &TtlCache<V>, now_ms: f64) -> TtlCache<V> {
    let mut next = cache.clone();
    next.entries.retain(|_, entry| !entry.expired(now_ms));
    next
}
