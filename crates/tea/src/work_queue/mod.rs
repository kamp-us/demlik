mod adapter;
mod ops;
mod store;
pub use adapter::*;
pub use ops::*;
pub use store::*;

use std::{
    cell::{Ref, RefCell, RefMut},
    ops::Deref,
    rc::Rc,
};

use crate::{
    PlainData,
    data::{JsText, JsonData, plain_data},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueItemStatus {
    Pending,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(transparent)]
pub struct QueueTime(pub Option<f64>);
impl<'de> Deserialize<'de> for QueueTime {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match PlainData::deserialize(deserializer)? {
            PlainData::Number(value) => Ok(Self(Some(value))),
            PlainData::Null => Ok(Self(None)),
            _ => Err(serde::de::Error::custom(
                "expected a number or restored JSON null",
            )),
        }
    }
}
impl From<f64> for QueueTime {
    fn from(value: f64) -> Self {
        Self(Some(value))
    }
}
impl QueueTime {
    pub fn number(self) -> Option<f64> {
        self.0
    }
}

/// `retry` and recovery explicitly assign undefined; a newly enqueued item
/// has no such own property. JSON omits both, while pure observations differ.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum QueueField<T> {
    #[default]
    Absent,
    Undefined,
    Value(T),
}
impl<T> QueueField<T> {
    pub fn value(&self) -> Option<&T> {
        if let Self::Value(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }
    pub fn is_undefined(&self) -> bool {
        matches!(self, Self::Undefined)
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for QueueField<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Self::Value)
    }
}

#[derive(Debug)]
pub struct QueueItem<I> {
    fields: QueueItemFields<I>,
    field_order: Vec<JsText>,
    extra: indexmap::IndexMap<JsText, Rc<PlainData>>,
}
#[derive(Debug)]
pub struct QueueItemFields<I> {
    pub id: JsText,
    pub status: QueueItemStatus,
    pub input: Rc<I>,
    pub enqueued_at: QueueTime,
    pub started_at: QueueField<QueueTime>,
    pub finished_at: QueueField<QueueTime>,
    pub output: QueueField<JsText>,
    pub error: QueueField<JsText>,
}
impl<I> Deref for QueueItem<I> {
    type Target = QueueItemFields<I>;
    fn deref(&self) -> &Self::Target {
        &self.fields
    }
}
impl<I> Clone for QueueItem<I> {
    fn clone(&self) -> Self {
        Self {
            fields: QueueItemFields {
                id: self.id.clone(),
                status: self.status,
                input: self.input.clone(),
                enqueued_at: self.enqueued_at,
                started_at: self.started_at.clone(),
                finished_at: self.finished_at.clone(),
                output: self.output.clone(),
                error: self.error.clone(),
            },
            field_order: self.field_order.clone(),
            extra: self.extra.clone(),
        }
    }
}
impl<I> QueueItem<I> {
    /// Fields can be read directly. Changes go through value-returning methods
    /// so the item owns optional-property presence and insertion order.
    ///
    /// ```compile_fail,E0594
    /// use demlik_tea::work_queue::{QueueItem, QueueItemStatus};
    /// let mut item = QueueItem::new(std::rc::Rc::new("job"), 0.0, "id");
    /// item.status = QueueItemStatus::Failed;
    /// ```
    pub fn new(input: Rc<I>, at: f64, id: impl Into<JsText>) -> Self {
        Self {
            fields: QueueItemFields {
                id: id.into(),
                status: QueueItemStatus::Pending,
                input,
                enqueued_at: at.into(),
                started_at: QueueField::Absent,
                finished_at: QueueField::Absent,
                output: QueueField::Absent,
                error: QueueField::Absent,
            },
            field_order: ["id", "status", "input", "enqueuedAt"]
                .map(JsText::from)
                .to_vec(),
            extra: indexmap::IndexMap::new(),
        }
    }
    pub fn extra(&self) -> &indexmap::IndexMap<JsText, Rc<PlainData>> {
        &self.extra
    }
    pub fn with_status(&self, status: QueueItemStatus) -> Self {
        let mut item = self.clone();
        item.fields.status = status;
        item
    }
    fn assigned(&mut self, key: &str, absent: bool) {
        if absent {
            self.field_order.retain(|field| field != &JsText::from(key));
        } else if !self
            .field_order
            .iter()
            .any(|field| field == &JsText::from(key))
        {
            self.field_order.push(key.into());
        }
    }
    pub fn with_started_at(&self, value: QueueField<QueueTime>) -> Self {
        let mut item = self.clone();
        item.assigned("startedAt", value.is_absent());
        item.fields.started_at = value;
        item
    }
    pub fn with_finished_at(&self, value: QueueField<QueueTime>) -> Self {
        let mut item = self.clone();
        item.assigned("finishedAt", value.is_absent());
        item.fields.finished_at = value;
        item
    }
    /// A correlation token is text, while structured output belongs in the
    /// consumer's own record.
    ///
    /// ```compile_fail,E0308
    /// use demlik_tea::work_queue::{QueueItem, QueueField};
    /// let item = QueueItem::new(std::rc::Rc::new("job"), 0.0, "id");
    /// item.with_output(QueueField::Value(vec![1, 2]));
    /// ```
    pub fn with_output(&self, value: QueueField<JsText>) -> Self {
        let mut item = self.clone();
        item.assigned("output", value.is_absent());
        item.fields.output = value;
        item
    }
    pub fn with_error(&self, value: QueueField<JsText>) -> Self {
        let mut item = self.clone();
        item.assigned("error", value.is_absent());
        item.fields.error = value;
        item
    }
    pub fn retried(&self) -> Self {
        self.with_status(QueueItemStatus::Pending)
            .with_started_at(QueueField::Undefined)
            .with_finished_at(QueueField::Undefined)
            .with_error(QueueField::Undefined)
            .with_output(QueueField::Undefined)
    }
}
impl<I: Serialize> Serialize for QueueItem<I> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut fields = indexmap::IndexMap::new();
        fn field<T: Serialize, E: serde::ser::Error>(
            value: &QueueField<T>,
        ) -> Result<Option<PlainData>, E> {
            Ok(match value {
                QueueField::Absent => None,
                QueueField::Undefined => Some(PlainData::Undefined),
                QueueField::Value(value) => Some(plain_data(value).map_err(E::custom)?),
            })
        }
        for key in &self.field_order {
            let value = match key.as_utf8() {
                Some("id") => Some(PlainData::String(self.id.clone())),
                Some("status") => {
                    Some(plain_data(&self.status).map_err(serde::ser::Error::custom)?)
                }
                Some("input") => Some(plain_data(&self.input).map_err(serde::ser::Error::custom)?),
                Some("enqueuedAt") => {
                    Some(plain_data(&self.enqueued_at).map_err(serde::ser::Error::custom)?)
                }
                Some("startedAt") => field::<_, S::Error>(&self.started_at)?,
                Some("finishedAt") => field::<_, S::Error>(&self.finished_at)?,
                Some("output") => field::<_, S::Error>(&self.output)?,
                Some("error") => field::<_, S::Error>(&self.error)?,
                _ => self.extra.get(key).map(|value| value.as_ref().clone()),
            };
            if let Some(value) = value {
                fields.insert(key.clone(), value);
            }
        }
        JsonData(&PlainData::Object(fields)).serialize(serializer)
    }
}
impl<'de, I: Deserialize<'de>> Deserialize<'de> for QueueItem<I> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields<I>(std::marker::PhantomData<I>);
        impl<'de, I: Deserialize<'de>> serde::de::Visitor<'de> for Fields<I> {
            type Value = QueueItem<I>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a queue item")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut fields: M,
            ) -> Result<Self::Value, M::Error> {
                let (mut id, mut status, mut input, mut enqueued_at) = (None, None, None, None);
                let (mut started_at, mut finished_at, mut output, mut error) = (
                    QueueField::Absent,
                    QueueField::Absent,
                    QueueField::Absent,
                    QueueField::Absent,
                );
                let mut field_order = Vec::new();
                let mut extra = indexmap::IndexMap::new();
                while let Some(key) = fields.next_key::<JsText>()? {
                    if !field_order.contains(&key) {
                        field_order.push(key.clone());
                    }
                    match key.as_utf8() {
                        Some("id") => id = Some(fields.next_value()?),
                        Some("status") => status = Some(fields.next_value()?),
                        Some("input") => input = Some(fields.next_value()?),
                        Some("enqueuedAt") => enqueued_at = Some(fields.next_value()?),
                        Some("startedAt") => started_at = fields.next_value()?,
                        Some("finishedAt") => finished_at = fields.next_value()?,
                        Some("output") => output = fields.next_value()?,
                        Some("error") => error = fields.next_value()?,
                        _ => {
                            extra.insert(key, fields.next_value()?);
                        }
                    }
                }
                Ok(QueueItem {
                    fields: QueueItemFields {
                        id: id.ok_or_else(|| serde::de::Error::missing_field("id"))?,
                        status: status.ok_or_else(|| serde::de::Error::missing_field("status"))?,
                        input: input.ok_or_else(|| serde::de::Error::missing_field("input"))?,
                        enqueued_at: enqueued_at
                            .ok_or_else(|| serde::de::Error::missing_field("enqueuedAt"))?,
                        started_at,
                        finished_at,
                        output,
                        error,
                    },
                    field_order,
                    extra,
                })
            }
        }
        deserializer.deserialize_map(Fields(std::marker::PhantomData))
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Queue<I>(Rc<RefCell<Vec<Rc<QueueItem<I>>>>>);
impl<I> Clone for Queue<I> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<I> Default for Queue<I> {
    fn default() -> Self {
        Self::new()
    }
}
impl<I> Queue<I> {
    pub fn new() -> Self {
        Self::from_items(Vec::new())
    }
    pub fn from_items(items: Vec<Rc<QueueItem<I>>>) -> Self {
        Self(Rc::new(RefCell::new(items)))
    }
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
    pub fn items(&self) -> Ref<'_, Vec<Rc<QueueItem<I>>>> {
        self.0.borrow()
    }
    pub fn items_mut(&self) -> RefMut<'_, Vec<Rc<QueueItem<I>>>> {
        self.0.borrow_mut()
    }
    pub fn to_vec(&self) -> Vec<Rc<QueueItem<I>>> {
        self.0.borrow().clone()
    }
    pub fn iter(&self) -> std::vec::IntoIter<Rc<QueueItem<I>>> {
        self.to_vec().into_iter()
    }
    pub fn get(&self, index: usize) -> Option<Rc<QueueItem<I>>> {
        self.0.borrow().get(index).cloned()
    }
    pub fn len(&self) -> usize {
        self.0.borrow().len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.borrow().is_empty()
    }
}
