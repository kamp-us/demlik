use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde::Serialize;

use crate::{PlainData, data::JsText};

/// A plain storage value. Cloning containers retains their actual identity;
/// `snapshot` copies their acyclic plain payload at a codec/coercion boundary.
/// Container roots share identity; nested values remain `PlainData` payloads.
#[derive(Clone, Debug)]
pub enum StoredCell {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(JsText),
    Array(StoredArray),
    Object(StoredObject),
}

#[derive(Clone)]
pub struct StoredArray(Arc<Mutex<Vec<PlainData>>>);
impl std::fmt::Debug for StoredArray {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let snapshot = self.snapshot();
        output.debug_tuple("StoredArray").field(&snapshot).finish()
    }
}
impl StoredArray {
    pub fn new(values: Vec<PlainData>) -> Self {
        Self(Arc::new(Mutex::new(values)))
    }
    pub fn snapshot(&self) -> Vec<PlainData> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
    pub fn replace(&self, values: Vec<PlainData>) -> Vec<PlainData> {
        std::mem::replace(
            &mut *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            values,
        )
    }
}

#[derive(Clone)]
pub struct StoredObject(Arc<Mutex<IndexMap<JsText, PlainData>>>);
impl std::fmt::Debug for StoredObject {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let snapshot = self.snapshot();
        output.debug_tuple("StoredObject").field(&snapshot).finish()
    }
}
impl StoredObject {
    pub fn new(values: IndexMap<JsText, PlainData>) -> Self {
        Self(Arc::new(Mutex::new(values)))
    }
    pub fn snapshot(&self) -> IndexMap<JsText, PlainData> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
    pub fn insert(&self, key: JsText, value: PlainData) -> Option<PlainData> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key, value)
    }
    pub fn replace(&self, values: IndexMap<JsText, PlainData>) -> IndexMap<JsText, PlainData> {
        std::mem::replace(
            &mut *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            values,
        )
    }
}

impl StoredCell {
    pub fn snapshot(&self) -> PlainData {
        match self {
            Self::Undefined => PlainData::Undefined,
            Self::Null => PlainData::Null,
            Self::Bool(value) => PlainData::Bool(*value),
            Self::Number(value) => PlainData::Number(*value),
            Self::String(value) => PlainData::String(value.clone()),
            Self::Array(value) => PlainData::Array(value.snapshot()),
            Self::Object(value) => PlainData::Object(value.snapshot()),
        }
    }
}
impl PartialEq for StoredCell {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Undefined, Self::Undefined) | (Self::Null, Self::Null) => true,
            (Self::Bool(left), Self::Bool(right)) => left == right,
            (Self::Number(left), Self::Number(right)) => left == right,
            (Self::String(left), Self::String(right)) => left == right,
            (Self::Array(left), Self::Array(right)) => Arc::ptr_eq(&left.0, &right.0),
            (Self::Object(left), Self::Object(right)) => Arc::ptr_eq(&left.0, &right.0),
            _ => false,
        }
    }
}
impl From<PlainData> for StoredCell {
    fn from(value: PlainData) -> Self {
        match value {
            PlainData::Undefined => Self::Undefined,
            PlainData::Null => Self::Null,
            PlainData::Bool(value) => Self::Bool(value),
            PlainData::Number(value) => Self::Number(value),
            PlainData::String(value) => Self::String(value),
            PlainData::Array(value) => Self::Array(StoredArray::new(value)),
            PlainData::Object(value) => Self::Object(StoredObject::new(value)),
        }
    }
}
impl From<f64> for StoredCell {
    fn from(value: f64) -> Self {
        Self::Number(value)
    }
}
impl Serialize for StoredCell {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.snapshot().serialize(serializer)
    }
}
