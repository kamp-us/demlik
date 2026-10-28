use super::{Question, Questions, ordered};
use crate::{PlainData, Tagged, data::JsText};
use indexmap::IndexMap;
use serde::{Serialize, ser::SerializeMap};

const TAGS: [&str; 6] = [
    "malformed_body",
    "missing_answer",
    "answer_type_mismatch",
    "off_criteria_choice",
    "off_criteria_probabilities",
    "malformed_answer",
];

pub enum JevErr {
    MalformedBody {
        reason: JsText,
    },
    MissingAnswer {
        id: JsText,
    },
    AnswerTypeMismatch {
        id: JsText,
        expected: &'static str,
        received: JsText,
    },
    OffCriteriaChoice {
        id: JsText,
        choice: JsText,
        options: Vec<JsText>,
    },
    OffCriteriaProbabilities {
        id: JsText,
        missing: Vec<JsText>,
        extra: Vec<JsText>,
        options: Vec<JsText>,
    },
    MalformedAnswer {
        id: JsText,
        reason: JsText,
    },
}
impl Tagged for JevErr {
    fn tag(&self) -> &str {
        match self {
            Self::MalformedBody { .. } => TAGS[0],
            Self::MissingAnswer { .. } => TAGS[1],
            Self::AnswerTypeMismatch { .. } => TAGS[2],
            Self::OffCriteriaChoice { .. } => TAGS[3],
            Self::OffCriteriaProbabilities { .. } => TAGS[4],
            Self::MalformedAnswer { .. } => TAGS[5],
        }
    }
}
impl Serialize for JevErr {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("_tag", self.tag())?;
        match self {
            Self::MalformedBody { reason } => m.serialize_entry("reason", reason)?,
            Self::MissingAnswer { id } => m.serialize_entry("id", id)?,
            Self::AnswerTypeMismatch {
                id,
                expected,
                received,
            } => {
                m.serialize_entry("id", id)?;
                m.serialize_entry("expected", expected)?;
                m.serialize_entry("received", received)?;
            }
            Self::OffCriteriaChoice {
                id,
                choice,
                options,
            } => {
                m.serialize_entry("id", id)?;
                m.serialize_entry("choice", choice)?;
                m.serialize_entry("options", options)?;
            }
            Self::OffCriteriaProbabilities {
                id,
                missing,
                extra,
                options,
            } => {
                m.serialize_entry("id", id)?;
                m.serialize_entry("missing", missing)?;
                m.serialize_entry("extra", extra)?;
                m.serialize_entry("options", options)?;
            }
            Self::MalformedAnswer { id, reason } => {
                m.serialize_entry("id", id)?;
                m.serialize_entry("reason", reason)?;
            }
        }
        m.end()
    }
}
/// Tag membership only, matching the source guard rather than revalidating payloads.
pub fn is_jev_err(value: &PlainData) -> bool {
    match field(value, "_tag") {
        PlainData::String(tag) => tag.as_utf8().is_some_and(|s| TAGS.contains(&s)),
        _ => false,
    }
}
#[derive(Serialize)]
pub struct JevUsage {
    pub input_tokens: f64,
    pub output_tokens: f64,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Answer {
    Choice {
        choice: JsText,
        confidence: f64,
        probabilities: IndexMap<JsText, f64>,
    },
    Score {
        confidence: f64,
        score: f64,
        legend: IndexMap<JsText, JsText>,
        probabilities: IndexMap<JsText, f64>,
    },
    Noul {
        noul: f64,
    },
}
pub type Answers = IndexMap<JsText, Answer>;
#[derive(Serialize)]
pub struct ParsedAnswers {
    pub answers: Answers,
    pub model: JsText,
    pub usage: JevUsage,
}

static UNDEFINED: PlainData = PlainData::Undefined;
pub(crate) fn field<'a>(value: &'a PlainData, key: &str) -> &'a PlainData {
    if let PlainData::Object(map) = value {
        map.get(&JsText::from(key)).unwrap_or(&UNDEFINED)
    } else {
        &UNDEFINED
    }
}
fn object(value: &PlainData) -> Option<&IndexMap<JsText, PlainData>> {
    if let PlainData::Object(map) = value {
        Some(map)
    } else {
        None
    }
}
fn finite(value: &PlainData) -> Option<f64> {
    if let PlainData::Number(n) = value {
        n.is_finite().then_some(*n)
    } else {
        None
    }
}
fn string(value: &PlainData) -> Option<JsText> {
    if let PlainData::String(s) = value {
        Some(s.clone())
    } else {
        None
    }
}
fn malformed_body(reason: &str) -> JevErr {
    JevErr::MalformedBody {
        reason: reason.into(),
    }
}
fn bad(id: &JsText, reason: &str) -> JevErr {
    JevErr::MalformedAnswer {
        id: id.clone(),
        reason: reason.into(),
    }
}
fn number_map(value: &PlainData) -> Option<IndexMap<JsText, f64>> {
    ordered(object(value)?)
        .into_iter()
        .map(|(k, v)| finite(v).map(|v| (k.clone(), v)))
        .collect()
}
fn string_map(value: &PlainData) -> Option<IndexMap<JsText, JsText>> {
    ordered(object(value)?)
        .into_iter()
        .map(|(k, v)| string(v).map(|v| (k.clone(), v)))
        .collect()
}
fn check_answer(id: &JsText, question: &Question, value: &PlainData) -> Result<Answer, JevErr> {
    object(value).ok_or_else(|| bad(id, "answer is not an object"))?;
    let expected = match question {
        Question::Choice { .. } => "choice",
        Question::Score { .. } => "score",
        Question::Noul { .. } => "noul",
    };
    let received = string(field(value, "type")).ok_or_else(|| bad(id, "answer has no `type`"))?;
    if received != JsText::from(expected) {
        return Err(JevErr::AnswerTypeMismatch {
            id: id.clone(),
            expected,
            received,
        });
    }
    match question {
        Question::Choice { criteria, .. } => {
            let options: Vec<_> = ordered(criteria)
                .into_iter()
                .map(|(k, _)| k.clone())
                .collect();
            let choice = string(field(value, "choice"))
                .ok_or_else(|| bad(id, "`choice` is not a string"))?;
            if !options.contains(&choice) {
                return Err(JevErr::OffCriteriaChoice {
                    id: id.clone(),
                    choice,
                    options,
                });
            }
            let confidence = finite(field(value, "confidence"))
                .ok_or_else(|| bad(id, "`confidence` is not a number"))?;
            let probabilities = object(field(value, "probabilities"))
                .ok_or_else(|| bad(id, "`probabilities` is not a map of numbers"))?;
            let missing = || {
                options
                    .iter()
                    .filter(|k| !probabilities.contains_key(*k))
                    .cloned()
                    .collect()
            };
            let extra = || {
                ordered(probabilities)
                    .into_iter()
                    .filter(|(k, _)| !options.contains(k))
                    .map(|(k, _)| k.clone())
                    .collect()
            };
            let mut parsed = IndexMap::new();
            for option in &options {
                match probabilities.get(option) {
                    Some(raw) => {
                        let n = finite(raw)
                            .ok_or_else(|| bad(id, "`probabilities` is not a map of numbers"))?;
                        parsed.insert(option.clone(), n);
                    }
                    None => {
                        return Err(JevErr::OffCriteriaProbabilities {
                            id: id.clone(),
                            missing: missing(),
                            extra: extra(),
                            options,
                        });
                    }
                }
            }
            if probabilities.keys().any(|k| !options.contains(k)) {
                return Err(JevErr::OffCriteriaProbabilities {
                    id: id.clone(),
                    missing: missing(),
                    extra: extra(),
                    options,
                });
            }
            Ok(Answer::Choice {
                choice,
                confidence,
                probabilities: parsed,
            })
        }
        Question::Score { .. } => {
            let confidence = finite(field(value, "confidence"))
                .ok_or_else(|| bad(id, "`confidence` is not a number"))?;
            let score =
                finite(field(value, "score")).ok_or_else(|| bad(id, "`score` is not a number"))?;
            let legend = string_map(field(value, "legend"))
                .ok_or_else(|| bad(id, "`legend` is not a map of strings"))?;
            let probabilities = number_map(field(value, "probabilities"))
                .ok_or_else(|| bad(id, "`probabilities` is not a map of numbers"))?;
            Ok(Answer::Score {
                confidence,
                score,
                legend,
                probabilities,
            })
        }
        Question::Noul { .. } => Ok(Answer::Noul {
            noul: finite(field(value, "noul")).ok_or_else(|| bad(id, "`noul` is not a number"))?,
        }),
    }
}
/// Validate a decoded body against valid typed questions. Extras are never retained.
pub fn parse_answers(questions: &Questions, body: &PlainData) -> Result<ParsedAnswers, JevErr> {
    object(body).ok_or_else(|| malformed_body("body is not an object"))?;
    let model =
        string(field(body, "model")).ok_or_else(|| malformed_body("`model` is not a string"))?;
    let usage = field(body, "usage");
    let usage = object(usage)
        .and_then(|_| {
            Some(JevUsage {
                input_tokens: finite(field(usage, "input_tokens"))?,
                output_tokens: finite(field(usage, "output_tokens"))?,
            })
        })
        .ok_or_else(|| malformed_body("`usage` is not `{ input_tokens, output_tokens }`"))?;
    let raw = object(field(body, "answers"))
        .ok_or_else(|| malformed_body("`answers` is not an object"))?;
    let mut answers = IndexMap::new();
    for (id, question) in ordered(questions) {
        let value = raw
            .get(id)
            .ok_or_else(|| JevErr::MissingAnswer { id: id.clone() })?;
        answers.insert(id.clone(), check_answer(id, question, value)?);
    }
    Ok(ParsedAnswers {
        answers,
        model,
        usage,
    })
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HttpStatus {
    Ok,
    Retry,
    Terminal,
}
pub fn classify_status(status: f64) -> HttpStatus {
    if (200.0..300.0).contains(&status) {
        HttpStatus::Ok
    } else if status == 429.0 || status == 529.0 {
        HttpStatus::Retry
    } else {
        HttpStatus::Terminal
    }
}
