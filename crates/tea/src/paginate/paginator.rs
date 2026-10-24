use std::rc::Rc;

use serde::{Deserialize, Serialize};

/// JSON turns a nonfinite JS number into null. Keep that restored value until
/// an arithmetic transition coerces it, rather than silently changing a model.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(transparent)]
pub struct PaginatorCount(pub Option<f64>);
impl<'de> Deserialize<'de> for PaginatorCount {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match crate::PlainData::deserialize(deserializer)? {
            crate::PlainData::Number(value) => Ok(Self(Some(value))),
            crate::PlainData::Null => Ok(Self(None)),
            _ => Err(serde::de::Error::custom(
                "expected a number or restored JSON null",
            )),
        }
    }
}
impl From<f64> for PaginatorCount {
    fn from(value: f64) -> Self {
        Self(Some(value))
    }
}
impl PaginatorCount {
    pub fn number(self) -> f64 {
        self.0.unwrap_or(0.0)
    }
    fn equals_number(self, number: f64) -> bool {
        self.0.is_some_and(|value| value == number)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatorPolicy<C> {
    pub first_cursor: Rc<C>,
    pub high_water_mark: f64,
}
impl<C> PaginatorPolicy<C> {
    pub fn new(first_cursor: C, high_water_mark: f64) -> Self {
        Self {
            first_cursor: Rc::new(first_cursor),
            high_water_mark,
        }
    }
}
pub fn default_paginator_policy() -> PaginatorPolicy<f64> {
    PaginatorPolicy::new(0.0, 1000.0)
}

#[derive(Debug)]
pub enum PaginatorCursor<C> {
    Shared(Rc<C>),
    Undefined,
    Missing,
}
impl<C> From<Rc<C>> for PaginatorCursor<C> {
    fn from(value: Rc<C>) -> Self {
        Self::Shared(value)
    }
}
impl<C> Clone for PaginatorCursor<C> {
    fn clone(&self) -> Self {
        match self {
            Self::Shared(cursor) => Self::Shared(cursor.clone()),
            Self::Undefined => Self::Undefined,
            Self::Missing => Self::Missing,
        }
    }
}
impl<C> PaginatorCursor<C> {
    fn resumed(&self) -> Self {
        match self {
            Self::Missing => Self::Undefined,
            _ => self.clone(),
        }
    }
}
#[derive(Debug)]
pub enum PaginatorPhase<C> {
    Idle,
    Fetching { cursor: PaginatorCursor<C> },
    Paused { cursor: PaginatorCursor<C> },
    Done,
}
impl<C> Clone for PaginatorPhase<C> {
    fn clone(&self) -> Self {
        match self {
            Self::Idle => Self::Idle,
            Self::Done => Self::Done,
            Self::Fetching { cursor } => Self::Fetching {
                cursor: cursor.clone(),
            },
            Self::Paused { cursor } => Self::Paused {
                cursor: cursor.clone(),
            },
        }
    }
}
#[derive(Debug)]
pub struct PaginatorSnapshot<C> {
    pub phase: PaginatorPhase<C>,
    pub seen: PaginatorCount,
    pub pages: PaginatorCount,
}
impl<C: Serialize> Serialize for PaginatorSnapshot<C> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use crate::{
            PlainData,
            data::{JsonData, plain_data},
        };
        let (phase, cursor) = match &self.phase {
            PaginatorPhase::Idle => ("idle", None),
            PaginatorPhase::Done => ("done", None),
            PaginatorPhase::Fetching { cursor } => ("fetching", Some(cursor)),
            PaginatorPhase::Paused { cursor } => ("paused", Some(cursor)),
        };
        let mut fields =
            indexmap::IndexMap::from([("phase".into(), PlainData::String(phase.into()))]);
        match cursor {
            Some(PaginatorCursor::Shared(value)) => {
                fields.insert(
                    "cursor".into(),
                    plain_data(value).map_err(serde::ser::Error::custom)?,
                );
            }
            Some(PaginatorCursor::Undefined) => {
                fields.insert("cursor".into(), PlainData::Undefined);
            }
            _ => {}
        }
        fields.insert(
            "seen".into(),
            self.seen.0.map_or(PlainData::Null, PlainData::Number),
        );
        fields.insert(
            "pages".into(),
            self.pages.0.map_or(PlainData::Null, PlainData::Number),
        );
        JsonData(&PlainData::Object(fields)).serialize(serializer)
    }
}
impl<'de, C: Deserialize<'de>> Deserialize<'de> for PaginatorSnapshot<C> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields<C>(std::marker::PhantomData<C>);
        impl<'de, C: Deserialize<'de>> serde::de::Visitor<'de> for Fields<C> {
            type Value = PaginatorSnapshot<C>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a paginator snapshot")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut fields: M,
            ) -> Result<Self::Value, M::Error> {
                let (mut phase, mut seen, mut pages) = (None, None, None);
                let mut cursor = PaginatorCursor::Missing;
                while let Some(key) = fields.next_key::<String>()? {
                    match key.as_str() {
                        "phase" => phase = Some(fields.next_value::<String>()?),
                        "seen" => seen = Some(fields.next_value::<PaginatorCount>()?),
                        "pages" => pages = Some(fields.next_value::<PaginatorCount>()?),
                        "cursor" => cursor = PaginatorCursor::Shared(fields.next_value()?),
                        _ => {
                            fields.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                let phase = match phase.as_deref() {
                    Some("idle") => PaginatorPhase::Idle,
                    Some("done") => PaginatorPhase::Done,
                    Some("fetching") => PaginatorPhase::Fetching { cursor },
                    Some("paused") => PaginatorPhase::Paused { cursor },
                    Some(other) => {
                        return Err(serde::de::Error::unknown_variant(
                            other,
                            &["idle", "fetching", "paused", "done"],
                        ));
                    }
                    None => return Err(serde::de::Error::missing_field("phase")),
                };
                Ok(PaginatorSnapshot {
                    phase,
                    seen: seen.ok_or_else(|| serde::de::Error::missing_field("seen"))?,
                    pages: pages.ok_or_else(|| serde::de::Error::missing_field("pages"))?,
                })
            }
        }
        deserializer.deserialize_map(Fields(std::marker::PhantomData))
    }
}

/// A pure snapshot. Cursor references are shared, including borrowed values;
/// cloning the snapshot never requires cloning or serializing the cursor.
#[derive(Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PaginatorState<C>(Rc<PaginatorSnapshot<C>>);
impl<C> Clone for PaginatorState<C> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<C> PaginatorState<C> {
    pub fn from_snapshot(snapshot: PaginatorSnapshot<C>) -> Self {
        Self(Rc::new(snapshot))
    }
    pub fn snapshot(&self) -> &PaginatorSnapshot<C> {
        &self.0
    }
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
    pub fn seen(&self) -> f64 {
        self.0.seen.number()
    }
    pub fn pages(&self) -> f64 {
        self.0.pages.number()
    }
    pub fn cursor(&self) -> Option<&Rc<C>> {
        match &self.0.phase {
            PaginatorPhase::Fetching {
                cursor: PaginatorCursor::Shared(cursor),
            }
            | PaginatorPhase::Paused {
                cursor: PaginatorCursor::Shared(cursor),
            } => Some(cursor),
            _ => None,
        }
    }
    pub fn phase_name(&self) -> &'static str {
        match self.0.phase {
            PaginatorPhase::Idle => "idle",
            PaginatorPhase::Fetching { .. } => "fetching",
            PaginatorPhase::Paused { .. } => "paused",
            PaginatorPhase::Done => "done",
        }
    }
}
pub fn init_paginator<C>() -> PaginatorState<C> {
    PaginatorState::from_snapshot(PaginatorSnapshot {
        phase: PaginatorPhase::Idle,
        seen: 0.0.into(),
        pages: 0.0.into(),
    })
}
pub fn start<C>(state: &PaginatorState<C>, policy: &PaginatorPolicy<C>) -> PaginatorState<C> {
    if !matches!(state.0.phase, PaginatorPhase::Idle) {
        return state.clone();
    }
    PaginatorState::from_snapshot(PaginatorSnapshot {
        phase: PaginatorPhase::Fetching {
            cursor: policy.first_cursor.clone().into(),
        },
        seen: state.0.seen,
        pages: state.0.pages,
    })
}
pub fn record_page<C>(
    state: &PaginatorState<C>,
    count: f64,
    next: Option<Rc<C>>,
    policy: &PaginatorPolicy<C>,
) -> PaginatorState<C> {
    if !matches!(state.0.phase, PaginatorPhase::Fetching { .. }) {
        return state.clone();
    }
    let safe_count = if count.is_finite() {
        crate::js_math::max(0.0, count)
    } else {
        0.0
    };
    let seen = state.seen() + safe_count;
    let phase = match next {
        None => PaginatorPhase::Done,
        Some(cursor) if policy.high_water_mark > 0.0 && seen >= policy.high_water_mark => {
            PaginatorPhase::Paused {
                cursor: cursor.into(),
            }
        }
        Some(cursor) => PaginatorPhase::Fetching {
            cursor: cursor.into(),
        },
    };
    PaginatorState::from_snapshot(PaginatorSnapshot {
        phase,
        seen: seen.into(),
        pages: (state.pages() + 1.0).into(),
    })
}
pub fn drain<C>(state: &PaginatorState<C>, n: f64) -> PaginatorState<C> {
    if n <= 0.0 {
        return state.clone();
    }
    let seen = crate::js_math::max(0.0, state.seen() - n);
    if state.0.seen.equals_number(seen) {
        return state.clone();
    }
    PaginatorState::from_snapshot(PaginatorSnapshot {
        phase: state.0.phase.clone(),
        seen: seen.into(),
        pages: state.0.pages,
    })
}
pub fn resume<C>(state: &PaginatorState<C>, policy: &PaginatorPolicy<C>) -> PaginatorState<C> {
    if let PaginatorPhase::Paused { cursor } = &state.0.phase {
        if state.seen() < policy.high_water_mark {
            return PaginatorState::from_snapshot(PaginatorSnapshot {
                phase: PaginatorPhase::Fetching {
                    cursor: cursor.resumed(),
                },
                seen: state.0.seen,
                pages: state.0.pages,
            });
        }
    }
    state.clone()
}
pub fn is_done<C>(state: &PaginatorState<C>) -> bool {
    matches!(state.0.phase, PaginatorPhase::Done)
}
