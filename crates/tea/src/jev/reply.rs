use super::{
    JevRequest,
    protocol::{self, Answers, HttpStatus, JevErr, JevUsage},
};
use crate::{
    PlainData, Tagged,
    command::Outcome,
    data::{JsText, NumberOrNull},
    resilience::resilient_call::RunError,
};
use serde::{Serialize, ser::SerializeMap};
use std::rc::Rc;

pub struct HttpReply<'a> {
    pub status: f64,
    pub body: &'a PlainData,
}
pub enum JevAskErr {
    Protocol(JevErr),
    HttpRetry { status: NumberOrNull },
    HttpTerminal { status: NumberOrNull },
    PortThrew { reason: JsText },
    NoAnswerPath,
}
impl Tagged for JevAskErr {
    fn tag(&self) -> &str {
        match self {
            Self::Protocol(e) => e.tag(),
            Self::HttpRetry { .. } => "http_retry",
            Self::HttpTerminal { .. } => "http_terminal",
            Self::PortThrew { .. } => "port_threw",
            Self::NoAnswerPath => "no_answer_path",
        }
    }
}
impl Serialize for JevAskErr {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if let Self::Protocol(error) = self {
            return error.serialize(s);
        }
        let mut m = s.serialize_map(None)?;
        m.serialize_entry("_tag", self.tag())?;
        match self {
            Self::HttpRetry { status } | Self::HttpTerminal { status } => {
                m.serialize_entry("status", status)?
            }
            Self::PortThrew { reason } => m.serialize_entry("reason", reason)?,
            Self::NoAnswerPath => (),
            Self::Protocol(_) => unreachable!(),
        };
        m.end()
    }
}
pub fn is_transient_ask_err(error: &JevAskErr) -> bool {
    matches!(
        error,
        JevAskErr::HttpRetry { .. } | JevAskErr::PortThrew { .. }
    )
}
#[derive(Serialize)]
pub struct JevFailureDetails {
    pub jev: Rc<JevAskErr>,
}
/// The canonical run failure owns its tag and shared error; this wire view keeps Source field order.
pub struct JevRejected {
    run: RunError<JevFailureDetails>,
}
impl JevRejected {
    pub fn new(jev: Rc<JevAskErr>) -> Self {
        Self {
            run: RunError::port_rejected(JevFailureDetails { jev }),
        }
    }
    pub fn jev(&self) -> &Rc<JevAskErr> {
        &self.run.details.jev
    }
}
impl Tagged for JevRejected {
    fn tag(&self) -> &str {
        self.run.tag()
    }
}
impl Serialize for JevRejected {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("_tag", self.run.tag())?;
        m.serialize_entry("jev", self.jev())?;
        m.end()
    }
}
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnswerSource {
    Port,
    Fallback,
}
#[derive(Serialize)]
pub struct JevOk {
    pub answers: Answers,
    pub model: JsText,
    pub usage: JevUsage,
    pub source: AnswerSource,
}
fn reject(error: JevAskErr) -> Outcome<JevOk, JevRejected> {
    Outcome::err(JevRejected::new(Rc::new(error)))
}
pub fn decode_reply(request: &JevRequest, reply: HttpReply<'_>) -> Outcome<JevOk, JevRejected> {
    match protocol::classify_status(reply.status) {
        HttpStatus::Retry => {
            return reject(JevAskErr::HttpRetry {
                status: reply.status.into(),
            });
        }
        HttpStatus::Terminal => {
            return reject(JevAskErr::HttpTerminal {
                status: reply.status.into(),
            });
        }
        HttpStatus::Ok => (),
    }
    match protocol::parse_answers(&request.questions, reply.body) {
        Ok(parsed) => Outcome::ok(JevOk {
            answers: parsed.answers,
            model: parsed.model,
            usage: parsed.usage,
            source: AnswerSource::Port,
        }),
        Err(error) => reject(JevAskErr::Protocol(error)),
    }
}
