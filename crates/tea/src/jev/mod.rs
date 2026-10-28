//! Pure interpretation of the frozen Jev wire contract. The caller owns HTTP.
pub mod ask;
pub mod protocol;
pub mod reply;

use crate::{PlainData, data::JsText};
use indexmap::IndexMap;
use serde::{Serialize, ser::SerializeSeq};
use std::rc::Rc;

pub const JEV_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";

#[derive(Serialize)]
#[serde(untagged)]
pub enum JevText {
    Text(JsText),
    Object(IndexMap<JsText, PlainData>),
    Array(Vec<PlainData>),
}
pub type JevState = JevText;

pub struct ScoreCriteria {
    first: JevText,
    second: JevText,
    rest: Vec<JevText>,
}
impl ScoreCriteria {
    pub fn new(first: JevText, second: JevText, rest: Vec<JevText>) -> Self {
        Self {
            first,
            second,
            rest,
        }
    }
}
impl Serialize for ScoreCriteria {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(2 + self.rest.len()))?;
        seq.serialize_element(&self.first)?;
        seq.serialize_element(&self.second)?;
        for level in &self.rest {
            seq.serialize_element(level)?;
        }
        seq.end()
    }
}
#[derive(Serialize)]
pub struct NoulCriteria {
    #[serde(rename = "true")]
    pub when_true: JevText,
    #[serde(rename = "false")]
    pub when_false: JevText,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Question {
    Choice {
        instructions: JevText,
        criteria: IndexMap<JsText, Option<JevText>>,
    },
    Score {
        instructions: JevText,
        criteria: ScoreCriteria,
    },
    Noul {
        instructions: JevText,
        #[serde(skip_serializing_if = "Option::is_none")]
        criteria: Option<NoulCriteria>,
    },
}
pub type Questions = IndexMap<JsText, Question>;
#[derive(Serialize)]
pub struct JevRequest {
    pub state: Rc<JevState>,
    pub model: JsText,
    pub questions: Rc<Questions>,
}

pub(crate) fn ordered<V>(map: &IndexMap<JsText, V>) -> Vec<(&JsText, &V)> {
    let mut entries: Vec<_> = map.iter().collect();
    entries.sort_by_key(|(key, _)| key.array_index().map_or((1, 0), |n| (0, n)));
    entries
}
