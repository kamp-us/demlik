use crate::data::JsText;
use serde::{Deserialize, Serialize};

use crate::js_record::{JsAccessError, JsRead, JsRecord, RecordEntry, RecordValue, Resolved};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry<V> {
    pub value: V,
    pub expires_at_ms: f64,
}
impl<V: Serialize> RecordEntry for CacheEntry<V> {
    type Value = V;
    const TIMESTAMP_KEY: &'static str = "expiresAtMs";
    fn payload(&self) -> &V {
        &self.value
    }
    fn timestamp(&self) -> f64 {
        self.expires_at_ms
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TtlCache<V> {
    pub entries: JsRecord<CacheEntry<V>>,
}

pub fn init_cache<V>() -> TtlCache<V> {
    TtlCache {
        entries: JsRecord::default(),
    }
}

fn live<'a, V: Serialize>(
    cache: &'a TtlCache<V>,
    key: &JsText,
    now_ms: f64,
) -> Result<Option<Resolved<'a, CacheEntry<V>>>, JsAccessError> {
    let entry = cache.entries.resolve(key)?;
    if entry.missing() || now_ms >= entry.timestamp()? {
        Ok(None)
    } else {
        Ok(Some(entry))
    }
}

pub fn get<'a, V: Serialize>(
    cache: &'a TtlCache<V>,
    key: impl Into<JsText>,
    now_ms: f64,
) -> Result<Option<JsRead<'a, V>>, JsAccessError> {
    match live(cache, &key.into(), now_ms)? {
        Some(entry) => entry.payload(),
        None => Ok(None),
    }
}

pub fn has<V: Serialize>(
    cache: &TtlCache<V>,
    key: impl Into<JsText>,
    now_ms: f64,
) -> Result<bool, JsAccessError> {
    Ok(live(cache, &key.into(), now_ms)?.is_some())
}

pub fn set<V: Clone>(
    cache: &TtlCache<V>,
    key: impl Into<JsText>,
    value: V,
    now_ms: f64,
    ttl_ms: f64,
) -> TtlCache<V> {
    let mut entries = cache.entries.spread();
    entries.assign(
        key.into(),
        RecordValue::Entry(CacheEntry {
            value,
            expires_at_ms: now_ms + ttl_ms,
        }),
    );
    TtlCache { entries }
}

pub fn remove<V: Clone>(cache: &TtlCache<V>, key: impl Into<JsText>) -> TtlCache<V> {
    let mut entries = cache.entries.spread();
    entries.delete(&key.into());
    TtlCache { entries }
}

pub fn evict_expired<V: Clone + Serialize>(
    cache: &TtlCache<V>,
    now_ms: f64,
) -> Result<TtlCache<V>, JsAccessError> {
    let mut entries = JsRecord::default();
    for (key, entry) in cache.entries.own_entries() {
        if now_ms >= Resolved::from(entry).timestamp()? {
            continue;
        }
        entries.assign(key.clone(), entry.clone());
    }
    Ok(TtlCache { entries })
}
