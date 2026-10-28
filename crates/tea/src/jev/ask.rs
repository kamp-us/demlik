//! Jev's online call policy over the existing resilient-call state and verbs.
//! The host supplies HTTP and returns `decode`, `rejected`, or `offline`.
//! Configured fallback and unclassified foreign failures are separate profiles.

use super::{
    JevRequest, JevState, Questions,
    reply::{self, HttpReply, JevAskErr, JevFailureDetails, JevOk, JevRejected},
};
use crate::{
    Step, Tagged,
    command::{CmdDef, Failure, Outcome, Settled, Settlement},
    data::JsText,
    describe_error::{ErrorView, describe_error},
    js_record::JsAccessError,
    resilience::{
        deadline::{Deadline, DeadlineExceeded},
        resilient_call::{self as rc, CallFailure, CallValue, SettleInput},
    },
    retry_backoff::{Budget, CountBound, RetryPolicy},
};
use std::rc::Rc;

pub const DEFAULT_JEV_MODEL: &str = "jev-latest";
pub type State = rc::State<JevRequest, JevOk, JevAskErr>;
pub type RunSpec = rc::RunSpec<JevRequest, JevOk, JevFailureDetails>;
pub type RunCmd = rc::RunCommand<JevRequest, JevOk, JevFailureDetails>;
pub type JevMsg = Settled<RunSpec>;
pub type CallStep = Step<State, RunCmd>;
pub type JevOutcome = Outcome<CallValue<JevOk>, rc::RunError<JevFailureDetails>>;

pub struct JevAskConfig<B = CountBound> {
    pub questions: Rc<Questions>,
    pub model: Option<JsText>,
    pub name: Option<String>,
    pub retry: Option<RetryPolicy<B>>,
}
impl JevAskConfig {
    pub fn new(questions: Rc<Questions>) -> Self {
        Self {
            questions,
            model: None,
            name: None,
            retry: None,
        }
    }
}
impl<B> JevAskConfig<B> {
    pub fn with_retry<C>(self, retry: RetryPolicy<C>) -> JevAskConfig<C> {
        JevAskConfig {
            questions: self.questions,
            model: self.model,
            name: self.name,
            retry: Some(retry),
        }
    }
}

#[derive(Debug)]
pub enum JevAskError {
    Resilience(rc::ResilientError),
    WrongSettlement {
        expected: &'static str,
        actual: String,
    },
    UnclassifiedMalformed(crate::command::MalformedResult),
}
impl From<rc::ResilientError> for JevAskError {
    fn from(value: rc::ResilientError) -> Self {
        Self::Resilience(value)
    }
}

pub struct JevAsk<'a, B = CountBound> {
    rc: rc::ResilientCall<'a, JevRequest, JevOk, JevAskErr, B, JevFailureDetails>,
    questions: Rc<Questions>,
    model: JsText,
}
impl<'a, B: Budget> JevAsk<'a, B> {
    pub fn new(config: JevAskConfig<B>) -> Self {
        Self {
            rc: rc::ResilientCall::new(rc::Config {
                name: config
                    .name
                    .unwrap_or_else(|| rc::DEFAULT_RESILIENT_NAME.into()),
                retry: config.retry,
                ..rc::Config::default()
            }),
            questions: config.questions,
            model: config.model.unwrap_or_else(|| DEFAULT_JEV_MODEL.into()),
        }
    }
    pub fn with_rng(mut self, rng: impl Fn() -> f64 + 'a) -> Self {
        self.rc = self.rc.with_rng(rng);
        self
    }
    pub fn name(&self) -> &str {
        self.rc.name()
    }
    pub fn run(&self) -> &CmdDef<RunSpec> {
        &self.rc.run
    }
    pub fn init(&self) -> State {
        self.rc.init()
    }
    pub fn attempt(
        &self,
        state: &State,
        key: impl Into<JsText>,
        content: Rc<JevState>,
        at: impl Into<rc::CallNumber>,
    ) -> Result<CallStep, rc::ResilientError> {
        self.rc.attempt(
            state,
            key,
            CallValue::value(JevRequest {
                state: content,
                model: self.model.clone(),
                questions: Rc::clone(&self.questions),
            }),
            at,
        )
    }
    pub fn decode(&self, request: &JevRequest, reply: HttpReply<'_>) -> JevOutcome {
        canonical(reply::decode_reply(request, reply))
    }
    pub fn rejected(&self, cause: ErrorView<'_>) -> Result<JevOutcome, JsAccessError> {
        Ok(canonical(Outcome::err(JevRejected::new(Rc::new(
            JevAskErr::PortThrew {
                reason: describe_error(cause)?,
            },
        )))))
    }
    pub fn offline(&self, _: &JevRequest) -> JevOutcome {
        canonical(Outcome::err(JevRejected::new(Rc::new(
            JevAskErr::NoAnswerPath,
        ))))
    }
    pub fn err_of(&self, msg: &JevMsg) -> Result<Rc<JevAskErr>, JevAskError> {
        match msg.outcome() {
            Settlement::Err(Failure::Declared(error)) => Ok(Rc::clone(&error.details.jev)),
            Settlement::Err(Failure::Malformed(error)) => {
                Err(JevAskError::UnclassifiedMalformed(error.clone()))
            }
            Settlement::Ok(_) => Err(JevAskError::WrongSettlement {
                expected: "failure",
                actual: msg.tag().into(),
            }),
        }
    }
    pub fn succeed(&self, state: &State, msg: &JevMsg) -> Result<CallStep, JevAskError> {
        let Settlement::Ok(value) = msg.outcome() else {
            return Err(JevAskError::WrongSettlement {
                expected: "success",
                actual: msg.tag().into(),
            });
        };
        let at = stamp(msg)?;
        let step = self.rc.settle(
            state,
            SettleInput::ok(msg.cmd().input().key.clone(), value.clone(), at),
        )?;
        Ok(Step::new(step.call, step.commands))
    }
    pub fn fail(&self, state: &State, msg: &JevMsg) -> Result<CallStep, JevAskError> {
        let key = msg.cmd().input().key.clone();
        let error = self.err_of(msg)?;
        let at = stamp(msg)?;
        if !reply::is_transient_ask_err(&error) {
            return Ok(self
                .rc
                .settle_failed(state, key, CallFailure::External(error), at));
        }
        let step = self.rc.settle(
            state,
            SettleInput::err(key, CallFailure::External(error), at),
        )?;
        Ok(Step::new(step.call, step.commands))
    }
    pub fn on_timer(
        &self,
        state: &State,
        msg: &DeadlineExceeded,
    ) -> Result<CallStep, rc::ResilientError> {
        self.rc.on_timer(state, msg)
    }
    pub fn deadlines(&self, state: &State) -> Vec<Deadline> {
        self.rc.deadlines(state)
    }
    pub fn timer(&self, state: &State) -> Option<crate::TimerDeps<DeadlineExceeded>> {
        self.rc.timer(state)
    }
}
fn canonical(outcome: Outcome<JevOk, JevRejected>) -> JevOutcome {
    match outcome {
        Outcome::Ok { value } => Outcome::ok(CallValue::value(value)),
        Outcome::Err { error } => Outcome::err(error.into_run_error()),
    }
}
fn stamp(msg: &JevMsg) -> Result<rc::CallNumber, rc::ResilientError> {
    msg.at().ok_or_else(|| rc::ResilientError::MissingStamp {
        command: msg.cmd().tag().into(),
    })
}
