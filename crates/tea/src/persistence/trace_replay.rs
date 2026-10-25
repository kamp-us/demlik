//! Update-only replay and deterministic structural comparison of recorded state.
pub mod state_walk;
use super::recorder::Trace;
use crate::{
    Machine, NoCellError, PlainData, Tagged,
    data::{DependencyError, JsText, JsonData, plain_data},
    fold_msgs_shared,
    js_record::RecordValue,
};
use serde::Serialize;
use state_walk::{ValueType, index_path, key_path};
use std::{fmt, sync::Arc};

pub struct ReplayResult<S, D = Divergence> {
    pub matches: bool,
    pub expected: Arc<S>,
    pub actual: Arc<S>,
    pub divergence: Option<D>,
}
#[derive(Debug)]
pub enum ReplayError<E = DependencyError> {
    MissingAnchor,
    NoCell(NoCellError),
    Comparison(E),
}
impl<E> ReplayError<E> {
    pub fn name(&self) -> &'static str {
        match self {
            Self::NoCell(error) => error.name(),
            _ => "Error",
        }
    }
}
impl<E: fmt::Display> fmt::Display for ReplayError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingAnchor => {
                f.write_str("tea replayTrace: trace has no captured initial State; record boot before replaying.")
            }
            Self::NoCell(error) => error.fmt(f),
            Self::Comparison(error) => error.fmt(f),
        }
    }
}
impl<E: std::error::Error + 'static> std::error::Error for ReplayError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::NoCell(error) => Some(error),
            Self::Comparison(error) => Some(error),
            _ => None,
        }
    }
}
pub fn replay_trace_with<S: Tagged, M: Tagged, C, U, X, D, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    trace: &Trace<S, M>,
    compare: impl FnOnce(&S, &S) -> Result<Option<D>, E>,
) -> Result<ReplayResult<S, D>, ReplayError<E>> {
    let seed = trace.loaded.as_ref().ok_or(ReplayError::MissingAnchor)?;
    let actual = fold_msgs_shared(machine, Arc::clone(seed), trace.msgs.iter().cloned())
        .map_err(ReplayError::NoCell)?;
    let expected = Arc::clone(&trace.final_state);
    let divergence = compare(&expected, &actual).map_err(ReplayError::Comparison)?;
    Ok(ReplayResult {
        matches: divergence.is_none(),
        expected,
        actual,
        divergence,
    })
}
/// The standard comparison projects serializable DTOs only at this boundary.
/// Opaque state uses replay_trace_with and a typed domain comparator.
pub fn replay_trace<S: Tagged + Serialize, M: Tagged, C, U, X>(
    machine: &Machine<'_, S, M, C, U, X>,
    trace: &Trace<S, M>,
) -> Result<ReplayResult<S>, ReplayError> {
    if let Some(seed) = &trace.loaded
        && matches!(
            plain_data(seed).map_err(ReplayError::Comparison)?,
            PlainData::Null
        )
    {
        return Err(ReplayError::MissingAnchor);
    }
    replay_trace_with(machine, trace, |expected, actual| {
        let expected = plain_data(expected)?;
        let actual = plain_data(actual)?;
        Ok(first_divergence(&expected, &actual, "state"))
    })
}
#[derive(Clone, Debug)]
pub struct Divergence {
    pub path: JsText,
    pub expected: RecordValue<PlainData>,
    pub actual: RecordValue<PlainData>,
}
type View<'a> = RecordValue<&'a PlainData>;
fn data<'a, 'b: 'a>(view: &'a View<'b>) -> Option<&'a PlainData> {
    match view {
        RecordValue::Entry(value) => Some(value),
        RecordValue::Data(value) => Some(value),
        _ => None,
    }
}
fn kind(view: &View<'_>) -> ValueType {
    match view {
        RecordValue::Builtin(_) => ValueType::Primitive,
        RecordValue::ObjectPrototype => ValueType::Object,
        _ => state_walk::type_of(data(view).expect("data view")),
    }
}
fn same(left: &View<'_>, right: &View<'_>) -> bool {
    match (left, right) {
        (RecordValue::Builtin(left), RecordValue::Builtin(right)) => return left == right,
        (RecordValue::ObjectPrototype, RecordValue::ObjectPrototype) => return true,
        _ => {}
    }
    let (Some(left), Some(right)) = (data(left), data(right)) else {
        return false;
    };
    if std::ptr::eq(left, right) {
        return true;
    }
    match (left, right) {
        (PlainData::Null, PlainData::Null) | (PlainData::Undefined, PlainData::Undefined) => true,
        (PlainData::Bool(left), PlainData::Bool(right)) => left == right,
        (PlainData::String(left), PlainData::String(right)) => left == right,
        (PlainData::Number(left), PlainData::Number(right)) => {
            left.to_bits() == right.to_bits() || left.is_nan() && right.is_nan()
        }
        _ => false,
    }
}
fn owned(view: &View<'_>) -> RecordValue<PlainData> {
    match view {
        RecordValue::Entry(value) => RecordValue::Entry((*value).clone()),
        RecordValue::Data(value) => RecordValue::Data(value.clone()),
        RecordValue::Builtin(name) => RecordValue::Builtin(name),
        RecordValue::ObjectPrototype => RecordValue::ObjectPrototype,
    }
}
fn difference(left: &View<'_>, right: &View<'_>, path: JsText) -> Divergence {
    Divergence {
        path,
        expected: owned(left),
        actual: owned(right),
    }
}
fn keys(view: &View<'_>) -> Vec<JsText> {
    match data(view) {
        Some(PlainData::Object(fields)) => fields.keys().cloned().collect(),
        _ => vec![],
    }
}
fn child<'a, 'b: 'a>(view: &'a View<'b>, key: &JsText) -> View<'a> {
    if let Some(PlainData::Object(fields)) = data(view)
        && let Some(value) = fields.get(key)
    {
        return RecordValue::Entry(value);
    }
    if key.as_utf8() == Some("__proto__") {
        return if matches!(view, RecordValue::ObjectPrototype) {
            RecordValue::Data(PlainData::Null)
        } else {
            RecordValue::ObjectPrototype
        };
    }
    match key.as_utf8().and_then(crate::js_record::builtin) {
        Some(name) => RecordValue::Builtin(name),
        None => RecordValue::Data(PlainData::Undefined),
    }
}
fn walk(left: &View<'_>, right: &View<'_>, path: JsText) -> Option<Divergence> {
    if same(left, right) {
        return None;
    }
    let expected_type = kind(left);
    if expected_type != kind(right) {
        return Some(difference(left, right, path));
    }
    match expected_type {
        ValueType::Array => {
            let (Some(PlainData::Array(expected)), Some(PlainData::Array(actual))) =
                (data(left), data(right))
            else {
                unreachable!()
            };
            if expected.len() != actual.len() {
                return Some(difference(left, right, path));
            }
            for (i, (expected, actual)) in expected.iter().zip(actual).enumerate() {
                if let Some(result) = walk(
                    &RecordValue::Entry(expected),
                    &RecordValue::Entry(actual),
                    index_path(&path, i as f64),
                ) {
                    return Some(result);
                }
            }
            None
        }
        ValueType::Object => {
            for key in state_walk::sorted_keys(keys(left).into_iter().chain(keys(right))) {
                if let Some(result) = walk(
                    &child(left, &key),
                    &child(right, &key),
                    key_path(&path, key),
                ) {
                    return Some(result);
                }
            }
            None
        }
        _ => Some(difference(left, right, path)),
    }
}
pub fn first_divergence(
    expected: &PlainData,
    actual: &PlainData,
    path: impl Into<JsText>,
) -> Option<Divergence> {
    walk(
        &RecordValue::Entry(expected),
        &RecordValue::Entry(actual),
        path.into(),
    )
}
pub fn deep_equal(expected: &PlainData, actual: &PlainData) -> bool {
    first_divergence(expected, actual, "state").is_none()
}
fn as_data(value: &RecordValue<PlainData>) -> PlainData {
    match value {
        RecordValue::Entry(value) | RecordValue::Data(value) => value.clone(),
        RecordValue::Builtin(_) => PlainData::Undefined,
        RecordValue::ObjectPrototype => PlainData::Object(Default::default()),
    }
}
impl Serialize for Divergence {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = PlainData::Object(
            [
                ("path".into(), PlainData::String(self.path.clone())),
                ("expected".into(), as_data(&self.expected)),
                ("actual".into(), as_data(&self.actual)),
            ]
            .into_iter()
            .collect(),
        );
        JsonData(&value).serialize(serializer)
    }
}
impl<S: Serialize, D: Serialize> Serialize for ReplayResult<S, D> {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        #[derive(Serialize)]
        struct Fields<'a, S, D> {
            matches: bool,
            expected: &'a Arc<S>,
            actual: &'a Arc<S>,
            #[serde(skip_serializing_if = "Option::is_none")]
            divergence: &'a Option<D>,
        }
        let value = plain_data(&Fields {
            matches: self.matches,
            expected: &self.expected,
            actual: &self.actual,
            divergence: &self.divergence,
        })
        .map_err(serde::ser::Error::custom)?;
        JsonData(&value).serialize(serializer)
    }
}
