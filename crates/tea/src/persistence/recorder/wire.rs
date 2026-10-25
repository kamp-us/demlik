use super::{Recorder, RecorderError, Trace, TraceStep};
use crate::{
    PlainData,
    data::{DependencyError, JsText, JsonData, decode_json_text, plain_data, stringify_json},
};
use serde::Serialize;
use std::{convert::Infallible, fmt, sync::Arc};

#[derive(Debug)]
pub enum JsonlWriteError<E> {
    Recorder(RecorderError),
    Codec(E),
}
impl<E: fmt::Display> fmt::Display for JsonlWriteError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Recorder(error) => error.fmt(f),
            Self::Codec(error) => error.fmt(f),
        }
    }
}
impl<E: std::error::Error + 'static> std::error::Error for JsonlWriteError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Recorder(error) => Some(error),
            Self::Codec(error) => Some(error),
        }
    }
}

pub fn trace_to_jsonl_with<S, M, E>(
    trace: &Trace<S, M>,
    mut encode_state: impl FnMut(&S) -> Result<PlainData, E>,
    mut encode_msg: impl FnMut(&M) -> Result<PlainData, E>,
) -> Result<String, E> {
    let loaded = match &trace.loaded {
        Some(state) => encode_state(state)?,
        None => PlainData::Null,
    };
    let mut lines = vec![
        stringify_json(&object([
            ("kind", PlainData::String("boot".into())),
            ("state", loaded),
        ]))
        .expect("an object has a JSON encoding"),
    ];
    for (i, msg) in trace.msgs.iter().enumerate() {
        let msg = encode_msg(msg)?;
        let state = match &trace.steps {
            Some(steps) => match steps.get(i) {
                Some(step) => encode_state(&step.state)?,
                None => PlainData::Undefined,
            },
            None if i == trace.msgs.len() - 1 => encode_state(&trace.final_state)?,
            None => PlainData::Null,
        };
        lines.push(
            stringify_json(&object([
                ("kind", PlainData::String("step".into())),
                ("msg", msg),
                ("state", state),
            ]))
            .expect("an object has a JSON encoding"),
        );
    }
    Ok(lines.join("\n"))
}
pub fn trace_to_jsonl<S: Serialize, M: Serialize>(
    trace: &Trace<S, M>,
) -> Result<String, DependencyError> {
    trace_to_jsonl_with(trace, plain_data, plain_data)
}
impl<S, M> Recorder<'_, S, M> {
    pub fn to_jsonl_with<E>(
        &self,
        encode_state: impl FnMut(&S) -> Result<PlainData, E>,
        encode_msg: impl FnMut(&M) -> Result<PlainData, E>,
    ) -> Result<String, JsonlWriteError<E>> {
        let trace = self
            .snapshot("toJSONL")
            .map_err(JsonlWriteError::Recorder)?;
        trace_to_jsonl_with(&trace, encode_state, encode_msg).map_err(JsonlWriteError::Codec)
    }
}
impl<S: Serialize, M: Serialize> Recorder<'_, S, M> {
    /// JSON encoding requires codecs at this boundary, rather than on recording.
    /// Use `to_jsonl_with` for an opaque state or message.
    ///
    /// ```compile_fail,E0599
    /// use demlik_tea::persistence::recorder::{Recorder, RecorderOptions};
    /// use std::sync::Arc;
    /// struct Opaque<'a>(&'a str);
    /// let name = String::from("borrowed");
    /// let rec = Recorder::<Opaque<'_>, ()>::new(RecorderOptions::default());
    /// rec.record_boot(Arc::new(Opaque(&name)));
    /// rec.to_jsonl().unwrap(); // An explicit codec is required for Opaque.
    /// ```
    pub fn to_jsonl(&self) -> Result<String, JsonlWriteError<DependencyError>> {
        self.to_jsonl_with(plain_data, plain_data)
    }
}

#[derive(Debug)]
pub enum JsonlError<E = Infallible> {
    Syntax {
        line: usize,
        cause: serde_json::Error,
    },
    NullLine {
        line: usize,
    },
    DuplicateBoot {
        line: usize,
    },
    StepBeforeBoot {
        line: usize,
    },
    UnknownKind {
        line: usize,
        kind: PlainData,
    },
    MissingBoot,
    UnknownFinalState,
    Codec {
        line: usize,
        field: &'static str,
        value: PlainData,
        cause: E,
    },
}
impl<E> JsonlError<E> {
    pub fn name(&self) -> &'static str {
        if matches!(self, Self::NullLine { .. }) {
            "TypeError"
        } else {
            "Error"
        }
    }
}
impl<E: fmt::Display> fmt::Display for JsonlError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax { line, cause } => {
                write!(f, "tea recorder: parseJSONL failed on line {line}: not valid JSON. {cause}")
            }
            Self::NullLine { .. } => {
                f.write_str("Cannot read properties of null (reading 'kind')")
            }
            Self::DuplicateBoot { line } => {
                write!(f, "tea recorder: parseJSONL saw a second boot header on line {line}. A trace has exactly one boot line.")
            }
            Self::StepBeforeBoot { line } => {
                write!(f, "tea recorder: parseJSONL saw a step line before the boot header on line {line}.")
            }
            Self::UnknownKind { line, kind } => {
                write!(f, "tea recorder: parseJSONL saw an unknown line kind on line {line}: {}", stringify_json(kind).unwrap_or_else(|| "undefined".into()))
            }
            Self::MissingBoot => {
                f.write_str("tea recorder: parseJSONL found no boot header. A trace must start with { kind: \"boot\", state }.")
            }
            Self::UnknownFinalState => {
                f.write_str("tea recorder: parseJSONL could not determine finalState — the boot state was null and no step carried a non-null state. The trace is unusable for replay.")
            }
            Self::Codec { line, field, cause, .. } => {
                write!(f, "tea recorder: parseJSONL cannot decode {field} on line {line}: {cause}")
            }
        }
    }
}
impl<E: std::error::Error + 'static> std::error::Error for JsonlError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Syntax { cause, .. } => Some(cause),
            Self::Codec { cause, .. } => Some(cause),
            _ => None,
        }
    }
}
fn field<'a>(value: &'a PlainData, key: &str) -> &'a PlainData {
    match value {
        PlainData::Object(fields) => fields.get(key).unwrap_or(&PlainData::Undefined),
        _ => &PlainData::Undefined,
    }
}
pub fn parse_jsonl_with<S, M, E>(
    text: &str,
    decode_state: impl FnMut(&PlainData) -> Result<S, E>,
    decode_msg: impl FnMut(&PlainData) -> Result<M, E>,
) -> Result<Trace<S, M>, JsonlError<E>> {
    parse_jsonl_text_with(&JsText::from(text), decode_state, decode_msg)
}
pub fn parse_jsonl_text_with<S, M, E>(
    text: &JsText,
    mut decode_state: impl FnMut(&PlainData) -> Result<S, E>,
    mut decode_msg: impl FnMut(&PlainData) -> Result<M, E>,
) -> Result<Trace<S, M>, JsonlError<E>> {
    let mut loaded = None;
    let mut saw_boot = false;
    let mut msgs = vec![];
    let mut steps = vec![];
    let mut final_state = None;
    for (i, raw) in text
        .as_units()
        .split(|unit| *unit == u16::from(b'\n'))
        .enumerate()
    {
        let line = i + 1;
        let text = crate::js_record::trim_js_units(raw);
        if text.is_empty() {
            continue;
        }
        let parsed = decode_json_text(&JsText::from_units(text.to_vec()))
            .map_err(|cause| JsonlError::Syntax { line, cause })?;
        if matches!(parsed, PlainData::Null) {
            return Err(JsonlError::NullLine { line });
        }
        let kind = field(&parsed, "kind");
        match kind {
            PlainData::String(kind) if kind.as_utf8() == Some("boot") => {
                if saw_boot {
                    return Err(JsonlError::DuplicateBoot { line });
                }
                saw_boot = true;
                let state = field(&parsed, "state");
                if !matches!(state, PlainData::Null) {
                    let state =
                        Arc::new(decode_state(state).map_err(|cause| JsonlError::Codec {
                            line,
                            field: "state",
                            value: state.clone(),
                            cause,
                        })?);
                    loaded = Some(Arc::clone(&state));
                    final_state = Some(state);
                }
            }
            PlainData::String(kind) if kind.as_utf8() == Some("step") => {
                if !saw_boot {
                    return Err(JsonlError::StepBeforeBoot { line });
                }
                let raw_msg = field(&parsed, "msg");
                let msg = Arc::new(decode_msg(raw_msg).map_err(|cause| JsonlError::Codec {
                    line,
                    field: "msg",
                    value: raw_msg.clone(),
                    cause,
                })?);
                msgs.push(Arc::clone(&msg));
                let raw_state = field(&parsed, "state");
                if !matches!(raw_state, PlainData::Null) {
                    let state =
                        Arc::new(decode_state(raw_state).map_err(|cause| JsonlError::Codec {
                            line,
                            field: "state",
                            value: raw_state.clone(),
                            cause,
                        })?);
                    steps.push(TraceStep {
                        msg,
                        state: Arc::clone(&state),
                    });
                    final_state = Some(state);
                }
            }
            _ => {
                return Err(JsonlError::UnknownKind {
                    line,
                    kind: kind.clone(),
                });
            }
        }
    }
    if !saw_boot {
        return Err(JsonlError::MissingBoot);
    }
    let Some(final_state) = final_state else {
        return Err(JsonlError::UnknownFinalState);
    };
    Ok(Trace {
        loaded,
        msgs,
        final_state,
        steps: Some(steps),
    })
}
pub fn parse_jsonl(text: &str) -> Result<Trace<PlainData, PlainData>, JsonlError> {
    parse_jsonl_with(text, |value| Ok(value.clone()), |value| Ok(value.clone()))
}
pub fn parse_jsonl_text(text: &JsText) -> Result<Trace<PlainData, PlainData>, JsonlError> {
    parse_jsonl_text_with(text, |value| Ok(value.clone()), |value| Ok(value.clone()))
}
fn object<const N: usize>(fields: [(&str, PlainData); N]) -> PlainData {
    PlainData::Object(
        fields
            .into_iter()
            .map(|(key, value)| (JsText::from(key), value))
            .collect(),
    )
}

#[derive(Debug, Serialize)]
pub struct TraceAttachment {
    pub filename: &'static str,
    pub data: String,
    #[serde(rename = "contentType")]
    pub content_type: &'static str,
}
pub fn trace_attachment_with<S, M, E>(
    trace: &Trace<S, M>,
    encode_state: impl FnMut(&S) -> Result<PlainData, E>,
    encode_msg: impl FnMut(&M) -> Result<PlainData, E>,
) -> Result<TraceAttachment, E> {
    Ok(TraceAttachment {
        filename: "tea-trace.jsonl",
        data: trace_to_jsonl_with(trace, encode_state, encode_msg)?,
        content_type: "application/x-ndjson",
    })
}
pub fn trace_attachment<S: Serialize, M: Serialize>(
    trace: &Trace<S, M>,
) -> Result<TraceAttachment, DependencyError> {
    trace_attachment_with(trace, plain_data, plain_data)
}
impl<S: Serialize, M: Serialize> Serialize for TraceStep<S, M> {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        #[derive(Serialize)]
        struct Fields<'a, S, M> {
            msg: &'a Arc<M>,
            state: &'a Arc<S>,
        }
        Fields {
            msg: &self.msg,
            state: &self.state,
        }
        .serialize(serializer)
    }
}
impl<S: Serialize, M: Serialize> Serialize for Trace<S, M> {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields<'a, S, M> {
            loaded: &'a Option<Arc<S>>,
            msgs: &'a Vec<Arc<M>>,
            final_state: &'a Arc<S>,
            #[serde(skip_serializing_if = "Option::is_none")]
            steps: &'a Option<Vec<TraceStep<S, M>>>,
        }
        let data = plain_data(&Fields {
            loaded: &self.loaded,
            msgs: &self.msgs,
            final_state: &self.final_state,
            steps: &self.steps,
        })
        .map_err(serde::ser::Error::custom)?;
        JsonData(&data).serialize(serializer)
    }
}
