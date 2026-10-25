use crate::{PlainData, data::JsText};
use indexmap::IndexMap;

/// A caller-decoded input. No decoder is retained by the command definition.
pub struct DecodedInput<I> {
    pub(super) input: I,
    pub(super) fields: Option<Box<InputFields>>,
}
impl<I> DecodedInput<I> {
    /// Use a native typed record without a wire-field layout.
    pub fn new(input: I) -> Self {
        Self {
            input,
            fields: None,
        }
    }
}

/// Own fields at a plain-record codec seam. `take` moves known values into
/// the caller's typed input; the remaining values are the unknown fields.
/// The original keys retain own presence and order without a second payload.
pub struct InputFields {
    remaining: IndexMap<JsText, PlainData>,
    order: Vec<JsText>,
    absent: Vec<JsText>,
}
impl TryFrom<PlainData> for InputFields {
    type Error = PlainData;
    fn try_from(value: PlainData) -> Result<Self, Self::Error> {
        match value {
            PlainData::Object(remaining) => {
                let mut order = remaining.keys().cloned().collect::<Vec<_>>();
                order.sort_by_key(|key| key.array_index().map_or((1, 0), |index| (0, index)));
                Ok(Self {
                    remaining,
                    order,
                    absent: vec![],
                })
            }
            other => Err(other),
        }
    }
}
impl InputFields {
    pub fn take(&mut self, key: impl Into<JsText>) -> Option<PlainData> {
        let key = key.into();
        let value = self.remaining.shift_remove(&key);
        if !self.order.contains(&key) && !self.absent.contains(&key) {
            self.absent.push(key);
        }
        value
    }
    pub fn has_own(&self, key: impl Into<JsText>) -> bool {
        self.order.contains(&key.into())
    }
    pub fn remaining(&self) -> &IndexMap<JsText, PlainData> {
        &self.remaining
    }
    pub fn finish<I>(self, input: I) -> DecodedInput<I> {
        DecodedInput {
            input,
            fields: Some(Box::new(self)),
        }
    }
    pub(super) fn project(
        &self,
        mut input: IndexMap<JsText, PlainData>,
    ) -> Result<IndexMap<JsText, PlainData>, String> {
        let mut fields = IndexMap::new();
        for key in &self.order {
            let value = if let Some(extra) = self.remaining.get(key) {
                if input.contains_key(key) {
                    return Err(format!(
                        "unconsumed input field {} also occurs in the typed projection",
                        serde_json::to_string(key).map_err(|error| error.to_string())?
                    ));
                }
                extra.clone()
            } else {
                // A present undefined field can be omitted by a typed JSON
                // serializer. Its original own presence remains authoritative.
                input.shift_remove(key).unwrap_or(PlainData::Undefined)
            };
            fields.insert(key.clone(), value);
        }
        for key in &self.absent {
            input.shift_remove(key);
        }
        fields.extend(input);
        Ok(fields)
    }
}
