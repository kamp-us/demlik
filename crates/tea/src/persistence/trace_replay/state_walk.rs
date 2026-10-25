use crate::{PlainData, data::JsText};
use indexmap::IndexMap;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueType {
    Null,
    Undefined,
    Array,
    Object,
    Primitive,
}
impl ValueType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Undefined => "undefined",
            Self::Array => "array",
            Self::Object => "object",
            Self::Primitive => "primitive",
        }
    }
}
pub fn type_of(value: &PlainData) -> ValueType {
    match value {
        PlainData::Null => ValueType::Null,
        PlainData::Undefined => ValueType::Undefined,
        PlainData::Array(_) => ValueType::Array,
        PlainData::Object(_) => ValueType::Object,
        _ => ValueType::Primitive,
    }
}
pub fn index_path(path: impl Into<JsText>, index: f64) -> JsText {
    let mut units = path.into().into_units();
    units.extend("[".encode_utf16());
    units.extend(crate::data::structural_hash(&PlainData::Number(index)).encode_utf16());
    units.push(b']' as u16);
    JsText::from_units(units)
}
pub fn key_path(path: impl Into<JsText>, key: impl Into<JsText>) -> JsText {
    let mut units = path.into().into_units();
    units.push(b'.' as u16);
    units.extend(key.into().into_units());
    JsText::from_units(units)
}
pub fn union_keys(
    left: &IndexMap<JsText, PlainData>,
    right: &IndexMap<JsText, PlainData>,
) -> Vec<JsText> {
    sorted_keys(left.keys().chain(right.keys()).cloned())
}
pub(super) fn sorted_keys(keys: impl IntoIterator<Item = JsText>) -> Vec<JsText> {
    let mut keys = keys.into_iter().collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys
}
