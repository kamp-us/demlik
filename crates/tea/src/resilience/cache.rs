use crate::data::JsText;
pub use crate::work_queue::QueueTime as CacheNumber;
use serde::{Deserialize, Serialize};

use crate::js_record::{JsAccessError, JsRead, JsRecord, RecordEntry, RecordValue, Resolved};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry<V> {
    pub value: V,
    pub expires_at_ms: CacheNumber,
}
impl<'de, V: Deserialize<'de>> Deserialize<'de> for CacheEntry<V> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields<V>(std::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> serde::de::Visitor<'de> for Fields<V> {
            type Value = CacheEntry<V>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a cache entry")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut fields: M,
            ) -> Result<Self::Value, M::Error> {
                let (mut value, mut expires_at_ms) = (None, None);
                while let Some(key) = fields.next_key::<JsText>()? {
                    match key.as_utf8() {
                        Some("value") => value = Some(fields.next_value()?),
                        Some("expiresAtMs") => expires_at_ms = Some(fields.next_value()?),
                        _ => {
                            fields.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(CacheEntry {
                    value: match value {
                        Some(value) => value,
                        None => crate::data::decode_missing("value")?,
                    },
                    expires_at_ms: expires_at_ms
                        .ok_or_else(|| serde::de::Error::missing_field("expiresAtMs"))?,
                })
            }
        }
        deserializer.deserialize_map(Fields(std::marker::PhantomData))
    }
}
impl<V> RecordEntry for CacheEntry<V> {
    type Value = V;
    const TIMESTAMP_KEY: &'static str = "expiresAtMs";
    fn payload(&self) -> &V {
        &self.value
    }
    fn timestamp(&self) -> f64 {
        self.expires_at_ms.number_or_zero()
    }
    fn timestamp_data(&self) -> crate::PlainData {
        self.expires_at_ms
            .number()
            .map_or(crate::PlainData::Null, crate::PlainData::Number)
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
    now_ms: CacheNumber,
) -> Result<Option<Resolved<'a, CacheEntry<V>>>, JsAccessError> {
    live_with_projection(cache, key, now_ms, crate::js_record::plain)
}
fn live_with_projection<'a, V>(
    cache: &'a TtlCache<V>,
    key: &JsText,
    now_ms: CacheNumber,
    project: impl FnOnce(&V) -> Result<crate::PlainData, JsAccessError>,
) -> Result<Option<Resolved<'a, CacheEntry<V>>>, JsAccessError> {
    let entry = cache.entries.resolve_with(key, project)?;
    if entry.missing() || now_ms.number_or_zero() >= entry.timestamp()? {
        Ok(None)
    } else {
        Ok(Some(entry))
    }
}

pub fn get<'a, V: Serialize>(
    cache: &'a TtlCache<V>,
    key: impl Into<JsText>,
    now_ms: impl Into<CacheNumber>,
) -> Result<Option<JsRead<'a, V>>, JsAccessError> {
    match live(cache, &key.into(), now_ms.into())? {
        Some(entry) => entry.payload(),
        None => Ok(None),
    }
}

/// Typed stored values need no serializer. Only a read through an injected
/// record's `value` property calls the supplied projection boundary.
pub fn get_with_projection<'a, V>(
    cache: &'a TtlCache<V>,
    key: impl Into<JsText>,
    now_ms: impl Into<CacheNumber>,
    project: impl FnOnce(&V) -> Result<crate::PlainData, JsAccessError>,
) -> Result<Option<JsRead<'a, V>>, JsAccessError> {
    match live_with_projection(cache, &key.into(), now_ms.into(), project)? {
        Some(entry) => entry.payload(),
        None => Ok(None),
    }
}

pub fn has<V: Serialize>(
    cache: &TtlCache<V>,
    key: impl Into<JsText>,
    now_ms: impl Into<CacheNumber>,
) -> Result<bool, JsAccessError> {
    Ok(live(cache, &key.into(), now_ms.into())?.is_some())
}

pub fn set<V: Clone>(
    cache: &TtlCache<V>,
    key: impl Into<JsText>,
    value: V,
    now_ms: impl Into<CacheNumber>,
    ttl_ms: f64,
) -> TtlCache<V> {
    let mut entries = cache.entries.spread();
    entries.assign(
        key.into(),
        RecordValue::Entry(CacheEntry {
            value,
            expires_at_ms: (now_ms.into().number_or_zero() + ttl_ms).into(),
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
    now_ms: impl Into<CacheNumber>,
) -> Result<TtlCache<V>, JsAccessError> {
    let now_ms = now_ms.into().number_or_zero();
    let mut entries = JsRecord::default();
    for (key, entry) in cache.entries.own_entries() {
        if now_ms >= Resolved::from(entry).timestamp()? {
            continue;
        }
        entries.assign(key.clone(), entry.clone());
    }
    Ok(TtlCache { entries })
}
