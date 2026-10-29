//! Structured-output parsing around the existing retry-only resilient-call.
//! A host supplies purpose schemas and provider handlers; this module performs no I/O.

use crate::{
    PlainData, Tagged,
    command::{CmdDef, Failure, Outcome, Settled, Settlement},
    data::JsText,
    js_record::JsAccessError,
    resilience::resilient_call::{self as rc, CallValue, RunError},
    retry_backoff::{Budget, CountBound, DurationBound, RetryBudget, RetryPolicy, Unbounded},
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::rc::Rc;
mod wire;

pub trait Purpose: Clone {
    fn key(&self) -> JsText;
}
impl Purpose for JsText {
    fn key(&self) -> JsText {
        self.clone()
    }
}
impl Purpose for String {
    fn key(&self) -> JsText {
        self.into()
    }
}
impl Purpose for &str {
    fn key(&self) -> JsText {
        (*self).into()
    }
}

/// The configured schema remains host-owned. Tea only calls its typed parser.
///
/// ```compile_fail,E0308
/// use demlik_tea::{llm_call::{Schema,Config,LlmCall,Request},
///     resilience::resilient_call::CallValue};
/// use std::rc::Rc;
/// struct Parser;
/// impl Schema for Parser {
///     type Raw=u8; type Output=String; type Error=();
///     fn parse(&self,raw:u8)->Result<String,CallValue<()>> {Ok(raw.to_string())}
/// }
/// let llm:LlmCall<'_,&str,(),Parser>=LlmCall::new(
///     Config::new(|_|Rc::new(Parser)),|_|Ok("rejected".into()));
/// let started=llm.attempt(&llm.init(),Rc::new(Request::new("plan",None,())),0.0).unwrap();
/// llm.decode(&started.commands[0],"a value outside the parser's raw type");
/// ```
pub trait Schema {
    type Raw;
    type Output;
    type Error;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>>;
}
pub struct Request<P, I> {
    pub purpose: P,
    pub model: Option<JsText>,
    pub payload: I,
    payload_present: bool,
}
impl<P, I> Request<P, I> {
    pub fn new(purpose: P, model: Option<JsText>, payload: I) -> Self {
        Self {
            purpose,
            model,
            payload,
            payload_present: true,
        }
    }
    pub fn has_payload(&self) -> bool {
        self.payload_present
    }
}
#[derive(Serialize)]
pub struct LlmOk<P, O> {
    pub key: JsText,
    pub purpose: P,
    pub output: O,
}
#[derive(Deserialize, Serialize)]
#[serde(bound(deserialize = "P: Deserialize<'de>, E: Deserialize<'de>"))]
pub struct LlmErr<P, E> {
    pub key: JsText,
    pub purpose: P,
    pub reason: JsText,
    #[serde(
        default = "wire::missing_cause",
        skip_serializing_if = "LlmCause::is_undefined"
    )]
    pub error: LlmCause<E>,
}
pub enum LlmCause<E> {
    Value(Rc<E>),
    AccessError(Rc<JsAccessError>),
    Undefined,
    Missing,
    Carrier(Rc<RunError<Rejected<E>>>),
    Malformed(Rc<crate::command::MalformedResult>),
}
pub enum CauseField<E> {
    Missing,
    Own(CallValue<E>),
    Inherited(CallValue<E>),
    /// An own library-raised cause, independent of the caller's error family.
    AccessError(Rc<JsAccessError>),
}
struct Rejection<E> {
    cause: CauseField<E>,
    fields: IndexMap<JsText, PlainData>,
}
/// Shared handler failure data. JSON retains only own fields. A command-family
/// handler needs an explicit wire projection when its cause is opaque.
///
/// ```compile_fail,E0599
/// use demlik_tea::{command::{CommandFamily, Outcome}, llm_call::Rejected,
///     resilience::resilient_call::{CallValue, RunError, RunInput, run_cmd_def}};
/// struct Opaque;
/// let definition=run_cmd_def::<(),(),Rejected<Opaque>>("resilient");
/// let command=definition.from_record(RunInput { key:"plan".into(),input:CallValue::value(()) });
/// command.settle(Some(Outcome::err(RunError::port_rejected(
///     Rejected::new(CallValue::value(Opaque))
/// ))),0.0); // Opaque has no Serialize projection at the command boundary.
/// ```
pub struct Rejected<E>(Rc<Rejection<E>>);
#[derive(Debug, PartialEq, Eq)]
pub struct RejectedFieldsError {
    pub field: JsText,
}
impl<E> Clone for Rejected<E> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}
impl<E> Rejected<E> {
    pub fn new(cause: CallValue<E>) -> Self {
        let cause = match cause {
            CallValue::Missing => CallValue::Undefined,
            cause => cause,
        };
        Self(Rc::new(Rejection {
            cause: CauseField::Own(cause),
            fields: IndexMap::new(),
        }))
    }
    pub(crate) fn access_error(cause: JsAccessError) -> Self {
        Self(Rc::new(Rejection {
            cause: CauseField::AccessError(Rc::new(cause)),
            fields: IndexMap::new(),
        }))
    }
    pub fn from_field(
        cause: CauseField<E>,
        fields: IndexMap<JsText, PlainData>,
    ) -> Result<Self, RejectedFieldsError> {
        if let Some(field) = fields
            .keys()
            .find(|field| matches!(field.as_utf8(), Some("cause" | "_tag")))
        {
            return Err(RejectedFieldsError {
                field: field.clone(),
            });
        }
        let cause = match cause {
            CauseField::Own(CallValue::Missing) => CauseField::Own(CallValue::Undefined),
            cause => cause,
        };
        Ok(Self(Rc::new(Rejection { cause, fields })))
    }
    pub fn cause(&self) -> &CauseField<E> {
        &self.0.cause
    }
    pub fn additional_fields(&self) -> &IndexMap<JsText, PlainData> {
        &self.0.fields
    }
    pub fn same(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

pub type State<P, I, O, E> = rc::State<Request<P, I>, LlmOk<P, O>, LlmErr<P, E>>;
pub type RunSpec<P, I, O, E> = rc::RunSpec<Request<P, I>, LlmOk<P, O>, Rejected<E>>;
pub type RunCmd<P, I, O, E> = rc::RunCommand<Request<P, I>, LlmOk<P, O>, Rejected<E>>;
pub type CallStep<P, I, O, E> = rc::CallStep<Request<P, I>, LlmOk<P, O>, LlmErr<P, E>, Rejected<E>>;
pub type LlmOutcome<P, O, E> = Outcome<CallValue<LlmOk<P, O>>, RunError<Rejected<E>>>;
pub type LlmMsg<P, I, O, E> = Settled<RunSpec<P, I, O, E>>;
type Description<'a, E> = dyn Fn(&E) -> Result<JsText, JsAccessError> + 'a;
type Selector<'a, P, S> = dyn Fn(&P) -> Rc<S> + 'a;
type Inner<'a, P, I, O, E> =
    rc::ResilientCall<'a, Request<P, I>, LlmOk<P, O>, LlmErr<P, E>, RetryBudget, Rejected<E>>;

pub struct Config<'a, P, S: Schema + ?Sized, B = CountBound> {
    schemas: Box<Selector<'a, P, S>>,
    pub retry: Option<RetryPolicy<B>>,
}
impl<'a, P, S: Schema + ?Sized> Config<'a, P, S> {
    pub fn new(schemas: impl Fn(&P) -> Rc<S> + 'a) -> Self {
        Self {
            schemas: Box::new(schemas),
            retry: None,
        }
    }
}
impl<'a, P, S: Schema + ?Sized, B> Config<'a, P, S, B> {
    pub fn with_retry<C>(self, retry: RetryPolicy<C>) -> Config<'a, P, S, C> {
        Config {
            schemas: self.schemas,
            retry: Some(retry),
        }
    }
}
#[derive(Debug)]
pub enum LlmCallError {
    Resilience(rc::ResilientError),
    MissingInput {
        command: String,
    },
    WrongSettlement {
        expected: &'static str,
        actual: String,
    },
    Description(JsAccessError),
}
impl From<rc::ResilientError> for LlmCallError {
    fn from(value: rc::ResilientError) -> Self {
        Self::Resilience(value)
    }
}
impl From<JsAccessError> for LlmCallError {
    fn from(value: JsAccessError) -> Self {
        Self::Description(value)
    }
}
pub struct LlmCall<'a, P, I, S: Schema + ?Sized, B = CountBound> {
    rc: Inner<'a, P, I, S::Output, S::Error>,
    budget: std::marker::PhantomData<fn() -> B>,
    schemas: Box<Selector<'a, P, S>>,
    describe: Box<Description<'a, S::Error>>,
}
impl<'a, P: Purpose, I, S: Schema + ?Sized, B: Budget> LlmCall<'a, P, I, S, B> {
    pub fn new(
        config: Config<'a, P, S, B>,
        describe: impl Fn(&S::Error) -> Result<JsText, JsAccessError> + 'a,
    ) -> Self {
        Self {
            rc: rc::ResilientCall::new(rc::Config {
                retry: config.retry.map(|policy| RetryPolicy {
                    curve: policy.curve,
                    budget: match (policy.budget.max_elapsed_ms(), policy.budget.max_attempts()) {
                        (Some(max_elapsed_ms), max_attempts) => {
                            RetryBudget::Duration(DurationBound {
                                max_elapsed_ms,
                                max_attempts,
                            })
                        }
                        (None, Some(max_attempts)) => {
                            RetryBudget::Count(CountBound { max_attempts })
                        }
                        (None, None) => RetryBudget::Unbounded(Unbounded),
                    },
                }),
                ..rc::Config::default()
            }),
            budget: std::marker::PhantomData,
            schemas: config.schemas,
            describe: Box::new(describe),
        }
    }
    /// Selects a brain-call retry policy without changing its durable state type.
    pub(crate) fn with_retry(mut self, retry: crate::retry_backoff::AnyRetryPolicy) -> Self {
        self.rc = self.rc.with_retry(retry);
        self
    }
    pub fn with_rng(mut self, rng: impl Fn() -> f64 + 'a) -> Self {
        self.rc = self.rc.with_rng(rng);
        self
    }
    pub fn name(&self) -> &str {
        self.rc.name()
    }
    pub fn run(&self) -> &CmdDef<RunSpec<P, I, S::Output, S::Error>> {
        &self.rc.run
    }
    pub fn init(&self) -> State<P, I, S::Output, S::Error> {
        self.rc.init()
    }
    pub fn schema_of(&self, purpose: &P) -> Rc<S> {
        (self.schemas)(purpose)
    }
    pub fn attempt(
        &self,
        state: &State<P, I, S::Output, S::Error>,
        input: Rc<Request<P, I>>,
        at: impl Into<rc::CallNumber>,
    ) -> Result<CallStep<P, I, S::Output, S::Error>, LlmCallError> {
        self.attempt_keyed(state, input.purpose.key(), input, at)
    }
    pub fn attempt_keyed(
        &self,
        state: &State<P, I, S::Output, S::Error>,
        key: impl Into<JsText>,
        input: Rc<Request<P, I>>,
        at: impl Into<rc::CallNumber>,
    ) -> Result<CallStep<P, I, S::Output, S::Error>, LlmCallError> {
        self.rc
            .attempt(state, key, CallValue::shared(input), at)
            .map_err(Into::into)
    }
    pub fn decode(
        &self,
        cmd: &RunCmd<P, I, S::Output, S::Error>,
        raw: S::Raw,
    ) -> Result<LlmOutcome<P, S::Output, S::Error>, LlmCallError> {
        let CallValue::Shared(input) = &cmd.input().input else {
            return Err(LlmCallError::MissingInput {
                command: cmd.tag().into(),
            });
        };
        let purpose = input.purpose.clone();
        let schema = self.schema_of(&purpose);
        Ok(match schema.parse(raw) {
            Ok(output) => Outcome::ok(CallValue::value(LlmOk {
                key: cmd.input().key.clone(),
                purpose,
                output,
            })),
            Err(cause) => self.rejected(cause),
        })
    }
    pub fn rejected(&self, cause: CallValue<S::Error>) -> LlmOutcome<P, S::Output, S::Error> {
        Outcome::err(RunError::port_rejected(Rejected::new(cause)))
    }
    pub(crate) fn rejected_access_error(
        &self,
        cause: JsAccessError,
    ) -> LlmOutcome<P, S::Output, S::Error> {
        Outcome::err(RunError::port_rejected(Rejected::access_error(cause)))
    }
    pub fn err_of(
        &self,
        msg: &LlmMsg<P, I, S::Output, S::Error>,
    ) -> Result<LlmErr<P, S::Error>, LlmCallError> {
        let Settlement::Err(failure) = msg.outcome() else {
            return Err(LlmCallError::WrongSettlement {
                expected: "failure",
                actual: msg.tag().into(),
            });
        };
        let CallValue::Shared(input) = &msg.cmd().input().input else {
            return Err(LlmCallError::MissingInput {
                command: msg.cmd().tag().into(),
            });
        };
        let error = match failure {
            Failure::Declared(error) => match error.details.cause() {
                CauseField::AccessError(cause) => LlmCause::AccessError(Rc::clone(cause)),
                CauseField::Missing => LlmCause::Carrier(Rc::new(error.clone())),
                CauseField::Own(cause) | CauseField::Inherited(cause) => match cause {
                    CallValue::Shared(value) => LlmCause::Value(Rc::clone(value)),
                    CallValue::Undefined | CallValue::Missing => LlmCause::Undefined,
                },
            },
            Failure::Malformed(error) => {
                LlmCause::Malformed(Rc::new(crate::command::MalformedResult {
                    issues: error.issues.clone(),
                }))
            }
        };
        let reason = match &error {
            LlmCause::Value(value) => (self.describe)(value)?,
            LlmCause::AccessError(error) => crate::describe_error::describe_error(
                crate::describe_error::ErrorView::ErrorMessage(&error.message.as_str().into()),
            )?,
            LlmCause::Undefined | LlmCause::Missing => crate::describe_error::describe_error(
                crate::describe_error::ErrorView::Value(&PlainData::Undefined),
            )?,
            LlmCause::Carrier(carrier) => {
                let mut fields = carrier.details.0.fields.clone();
                fields.insert("_tag".into(), PlainData::String(carrier.kind.tag().into()));
                crate::describe_error::describe_error(crate::describe_error::ErrorView::Value(
                    &PlainData::Object(fields),
                ))?
            }
            LlmCause::Malformed(value) => {
                crate::describe_error::describe_error(crate::describe_error::ErrorView::Value(
                    &crate::data::plain_data(value.as_ref())
                        .expect("malformed issues contain plain fields"),
                ))?
            }
        };
        Ok(LlmErr {
            key: msg.cmd().input().key.clone(),
            purpose: input.purpose.clone(),
            reason,
            error,
        })
    }
    pub fn fail(
        &self,
        state: &State<P, I, S::Output, S::Error>,
        msg: &LlmMsg<P, I, S::Output, S::Error>,
    ) -> Result<CallStep<P, I, S::Output, S::Error>, LlmCallError> {
        let error = self.err_of(msg)?;
        let at = msg.at().ok_or_else(|| rc::ResilientError::MissingStamp {
            command: msg.cmd().tag().into(),
        })?;
        let settled = self.rc.settle(
            state,
            rc::SettleInput::err(
                msg.cmd().input().key.clone(),
                rc::CallFailure::external(error),
                at,
            ),
        )?;
        Ok(crate::Step::new(settled.call, settled.commands))
    }
    pub fn succeed(
        &self,
        state: &State<P, I, S::Output, S::Error>,
        msg: &LlmMsg<P, I, S::Output, S::Error>,
    ) -> Result<CallStep<P, I, S::Output, S::Error>, LlmCallError> {
        let Settlement::Ok(value) = msg.outcome() else {
            return Err(LlmCallError::WrongSettlement {
                expected: "success",
                actual: msg.tag().into(),
            });
        };
        let at = msg.at().ok_or_else(|| rc::ResilientError::MissingStamp {
            command: msg.cmd().tag().into(),
        })?;
        let settled = self.rc.settle(
            state,
            rc::SettleInput::ok(msg.cmd().input().key.clone(), value.clone(), at),
        )?;
        Ok(crate::Step::new(settled.call, settled.commands))
    }
    pub fn on_timer(
        &self,
        state: &State<P, I, S::Output, S::Error>,
        msg: &crate::resilience::deadline::DeadlineExceeded,
    ) -> Result<CallStep<P, I, S::Output, S::Error>, LlmCallError> {
        self.rc.on_timer(state, msg).map_err(Into::into)
    }
    pub fn deadlines(
        &self,
        state: &State<P, I, S::Output, S::Error>,
    ) -> Vec<crate::resilience::deadline::Deadline> {
        self.rc.deadlines(state)
    }
    pub fn timer(
        &self,
        state: &State<P, I, S::Output, S::Error>,
    ) -> Option<crate::TimerDeps<crate::resilience::deadline::DeadlineExceeded>> {
        self.rc.timer(state)
    }
}

pub fn lift_llm_call<S, P, I, O, E, C>(
    state: S,
    result: crate::Step<State<P, I, O, E>, C>,
    replace: impl FnOnce(S, State<P, I, O, E>) -> S,
) -> crate::Step<S, C> {
    rc::lift_resilience(state, result, replace)
}

impl<'a, P, I, S: Schema + ?Sized> LlmCall<'a, P, I, S> {
    pub(crate) fn retry_sibling<J, U, E>(&self) -> rc::ResilientCall<'a, J, U, E, RetryBudget> {
        self.retry_sibling_with(rc::Config {
            retry: self.rc.retry_policy().copied(),
            ..Default::default()
        })
    }
    pub(crate) fn retry_sibling_with<J, U, E, B: Budget>(
        &self,
        config: rc::Config<B>,
    ) -> rc::ResilientCall<'a, J, U, E, B> {
        self.rc.retry_sibling_with(config)
    }
}

#[cfg(test)]
mod tool_policy_interface_tests;
