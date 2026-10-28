//! Typed tool declarations and a finite, exhaustive router over them.
use super::{
    content::Parts,
    tool_resilience::ToolResilience,
    types::{ToolCall, ToolOutcome},
};
use crate::{
    PlainData, Tagged,
    command::{
        self, Cmd, CmdDef, CommandContractError, CommandEdge, CommandFamily, CommandRecord,
        CommandSpec, Failure, Issue, Outcome, SchemaError, Settled,
    },
    data::{JsText, plain_data, stringify_json},
    describe_error::{ErrorView, describe_error},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
    runtime,
};
use futures::future::LocalBoxFuture;
use serde::{Serialize, ser::SerializeMap};
use std::{convert::Infallible, fmt, marker::PhantomData, rc::Rc};
mod empty;
mod router;
pub use empty::{EmptyInterpreter, EmptyRouter};
#[doc(hidden)]
pub use serde as __serde;

const PROTOCOL: &[&str] = &[
    "resilient_run",
    "resilient_run_ok",
    "resilient_run_err",
    "agent_start",
    "agent_tool_ok",
    "agent_tool_err",
    "agent_boot",
    "agent_cancel",
    "compact_run",
    "compact_ok",
    "compact_err",
    "unauthorized",
];
pub const REJECTED_TYPE: &str = "tool_rejected";
pub fn is_reserved_tool_name(name: &str) -> bool {
    name == REJECTED_TYPE
        || name == "snapshot_write"
        || PROTOCOL.iter().any(|tag| {
            *tag == name
                || ["_ok", "_err", "_run"]
                    .iter()
                    .any(|suffix| tag.strip_suffix(suffix) == Some(name))
        })
}
#[derive(Debug)]
pub enum ToolError {
    Reserved { name: String },
    Duplicate { name: String },
    Contract(CommandContractError),
    MissingPortEmitter,
    MissingSchemaFailure { undefined: bool },
    Schema(SchemaError),
    Access(crate::js_record::JsAccessError),
}
impl ToolError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Contract(e) => e.name(),
            Self::Access(e) => e.name,
            _ => "Error",
        }
    }
}
impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Reserved { name } => write!(
                f,
                "tool: \"{name}\" is reserved — it is an agent-owned Msg prefix"
            ),
            Self::Duplicate { name } => write!(f, "toolRouter: tool \"{name}\" is declared twice"),
            Self::Contract(e) => e.fmt(f),
            Self::MissingPortEmitter => f.write_str("tool context has no runtime port emitter"),
            Self::MissingSchemaFailure { undefined } => write!(
                f,
                "tool schema returned an unsupported {} failure carrier",
                if *undefined { "undefined" } else { "missing" }
            ),
            Self::Schema(e) => write!(f, "tool schema validation failed: {e:?}"),
            Self::Access(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for ToolError {}
impl From<CommandContractError> for ToolError {
    fn from(e: CommandContractError) -> Self {
        Self::Contract(e)
    }
}
impl From<crate::js_record::JsAccessError> for ToolError {
    fn from(e: crate::js_record::JsAccessError) -> Self {
        Self::Access(e)
    }
}

/// Services are borrowed; a live interpreter forwards the canonical port owner.
pub struct ToolContext<'a, H> {
    pub host: &'a H,
    ports: Option<runtime::PortEmitter>,
}
impl<'a, H> ToolContext<'a, H> {
    pub fn bare(host: &'a H) -> Self {
        Self { host, ports: None }
    }
    #[doc(hidden)]
    pub fn runtime<M, E>(host: &'a H, context: &runtime::CommandContext<M, E>) -> Self {
        Self {
            host,
            ports: Some(context.ports.clone()),
        }
    }
    pub fn emit<T: 'static>(
        &self,
        port: &crate::ports::Port<T>,
        value: &T,
    ) -> Result<(), ToolError> {
        self.ports
            .as_ref()
            .ok_or(ToolError::MissingPortEmitter)?
            .emit(port, value);
        Ok(())
    }
}
pub enum Raised<E, X = PlainData> {
    Declared(Rc<E>),
    Error { message: JsText, cause: Rc<X> },
    Value(Rc<PlainData>),
}
pub enum ThrownCause<X> {
    Error(Rc<X>),
    Value(Rc<PlainData>),
}
pub enum ToolFailure<E, X> {
    Declared(Rc<E>),
    Thrown {
        message: JsText,
        cause: ThrownCause<X>,
    },
}
impl<E, X> Clone for ToolFailure<E, X> {
    fn clone(&self) -> Self {
        match self {
            Self::Declared(e) => Self::Declared(Rc::clone(e)),
            Self::Thrown { message, cause } => Self::Thrown {
                message: message.clone(),
                cause: match cause {
                    ThrownCause::Error(e) => ThrownCause::Error(Rc::clone(e)),
                    ThrownCause::Value(e) => ThrownCause::Value(Rc::clone(e)),
                },
            },
        }
    }
}
impl<E: Tagged, X> Tagged for ToolFailure<E, X> {
    fn tag(&self) -> &str {
        match self {
            Self::Declared(e) => e.tag(),
            Self::Thrown { .. } => "thrown",
        }
    }
}
impl<E: Serialize, X> Serialize for ToolFailure<E, X> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Declared(e) => e.serialize(s),
            Self::Thrown { message, .. } => {
                let mut m = s.serialize_map(Some(2))?;
                m.serialize_entry("_tag", "thrown")?;
                m.serialize_entry("message", message)?;
                m.end()
            }
        }
    }
}

type ErrorProjection<'a, E> = Box<dyn Fn(&E) -> Result<PlainData, CommandContractError> + 'a>;
pub struct ErrorFamily<'a, E> {
    tags: Vec<String>,
    view: ErrorProjection<'a, E>,
}
impl<'a, E> ErrorFamily<'a, E> {
    pub fn new(
        tags: impl IntoIterator<Item = impl Into<String>>,
        view: impl Fn(&E) -> Result<PlainData, CommandContractError> + 'a,
    ) -> Self {
        Self {
            tags: tags.into_iter().map(Into::into).collect(),
            view: Box::new(view),
        }
    }
}
type Content<'a, O, C> = Box<dyn Fn(&Rc<O>) -> Result<Parts, C> + 'a>;
pub struct ToolSpec<'a, R, A, O, IS, OS, E, C = Infallible, X = PlainData> {
    input: Rc<IS>,
    ok: Rc<OS>,
    family: ErrorFamily<'a, E>,
    description: JsText,
    content: Option<Content<'a, O, C>>,
    resilience: Option<ToolResilience>,
    marker: PhantomData<fn(R, A, X)>,
}
impl<'a, R, A, O, IS, OS, E> ToolSpec<'a, R, A, O, IS, OS, E>
where
    IS: Schema<Raw = Rc<R>, Output = Rc<A>, Error = SchemaError>,
    OS: Schema<Output = Rc<O>, Error = SchemaError>,
{
    pub fn new(input: Rc<IS>, ok: Rc<OS>, family: ErrorFamily<'a, E>) -> Self {
        Self {
            input,
            ok,
            family,
            description: "".into(),
            content: None,
            resilience: None,
            marker: PhantomData,
        }
    }
}
impl<'a, R, A, O, IS, OS, E, C, X> ToolSpec<'a, R, A, O, IS, OS, E, C, X> {
    pub fn description(mut self, description: impl Into<JsText>) -> Self {
        self.description = description.into();
        self
    }
    pub fn resilience(mut self, value: ToolResilience) -> Self {
        self.resilience = if value.timeout_ms.is_none() && value.retry.is_none() {
            None
        } else {
            Some(value)
        };
        self
    }
    pub fn raised<Y>(self) -> ToolSpec<'a, R, A, O, IS, OS, E, C, Y> {
        ToolSpec {
            input: self.input,
            ok: self.ok,
            family: self.family,
            description: self.description,
            content: self.content,
            resilience: self.resilience,
            marker: PhantomData,
        }
    }
    pub fn try_content<D>(
        self,
        content: impl Fn(&Rc<O>) -> Result<Parts, D> + 'a,
    ) -> ToolSpec<'a, R, A, O, IS, OS, E, D, X> {
        ToolSpec {
            input: self.input,
            ok: self.ok,
            family: self.family,
            description: self.description,
            content: Some(Box::new(content)),
            resilience: self.resilience,
            marker: PhantomData,
        }
    }
    pub fn content(
        self,
        content: impl Fn(&Rc<O>) -> Parts + 'a,
    ) -> ToolSpec<'a, R, A, O, IS, OS, E, Infallible, X> {
        self.try_content(move |result| Ok(content(result)))
    }
}
type Handler<'a, A, R, E, X, H> = Box<
    dyn for<'s> Fn(
            &'s Rc<A>,
            ToolContext<'s, H>,
        ) -> LocalBoxFuture<'s, Result<Outcome<R, Rc<E>>, Raised<E, X>>>
        + 'a,
>;
pub struct ToolDef<'a, R, A, O, IS, OS, E, X, H, C>
where
    OS: Schema,
{
    name: String,
    spec: ToolSpec<'a, R, A, O, IS, OS, E, C, X>,
    tags: Vec<String>,
    handler: Handler<'a, A, OS::Raw, E, X, H>,
}
#[expect(
    clippy::type_complexity,
    reason = "Construction infers the actual schemas, host, opaque failure, and content channels."
)]
pub fn tool<'a, R, A, O, IS, OS, E, X, H, C>(
    name: impl Into<String>,
    spec: ToolSpec<'a, R, A, O, IS, OS, E, C, X>,
    handler: impl for<'s> Fn(
        &'s Rc<A>,
        ToolContext<'s, H>,
    ) -> LocalBoxFuture<'s, Result<Outcome<OS::Raw, Rc<E>>, Raised<E, X>>>
    + 'a,
) -> Result<Rc<ToolDef<'a, R, A, O, IS, OS, E, X, H, C>>, ToolError>
where
    IS: Schema<Raw = Rc<R>, Output = Rc<A>, Error = SchemaError>,
    OS: Schema<Output = Rc<O>, Error = SchemaError>,
    E: Tagged,
{
    let name = name.into();
    if is_reserved_tool_name(&name) {
        return Err(ToolError::Reserved { name });
    }
    let mut tags = spec.family.tags.clone();
    tags.push("thrown".into());
    Ok(Rc::new(ToolDef {
        name,
        spec,
        tags,
        handler: Box::new(handler),
    }))
}
impl<R, A, O, IS, OS, E, X, H, C> ToolDef<'_, R, A, O, IS, OS, E, X, H, C>
where
    OS: Schema,
{
    pub fn input_schema(&self) -> &Rc<IS> {
        &self.spec.input
    }
    pub fn output_schema(&self) -> &Rc<OS> {
        &self.spec.ok
    }
    pub fn description(&self) -> &JsText {
        &self.spec.description
    }
}
fn parse<S: Schema<Error = SchemaError>>(schema: &S, raw: S::Raw) -> Result<S::Output, ToolError> {
    schema.parse(raw).map_err(|failure| match failure {
        CallValue::Shared(e) => ToolError::Schema(match e.as_ref() {
            SchemaError::Issues(issues) => SchemaError::Issues(issues.clone()),
            SchemaError::Async => SchemaError::Async,
        }),
        CallValue::Missing => ToolError::MissingSchemaFailure { undefined: false },
        CallValue::Undefined => ToolError::MissingSchemaFailure { undefined: true },
    })
}

/// Associated types keep the heterogeneous table exhaustive without erasing payloads.
pub trait ToolDefinition: Sized {
    type RawArgs;
    type Args;
    type RawResult;
    type Ok;
    type Error: Tagged;
    type Thrown;
    type Host;
    type ContentError;
    fn name(&self) -> &str;
    fn tags(&self) -> &[String];
    fn parse_args(&self, raw: Rc<Self::RawArgs>) -> Result<Rc<Self::Args>, ToolError>;
    fn parse_result(&self, raw: Self::RawResult) -> Result<Rc<Self::Ok>, ToolError>;
    fn failure_view(
        &self,
        error: &ToolFailure<Self::Error, Self::Thrown>,
    ) -> Result<PlainData, CommandContractError>;
    fn handle<'s>(
        &'s self,
        args: &'s Rc<Self::Args>,
        context: ToolContext<'s, Self::Host>,
    ) -> LocalBoxFuture<'s, Result<command::Completion<SignatureOf<Self>>, ToolError>>;
    fn parts(&self, result: &Rc<Self::Ok>) -> Result<Option<Parts>, Self::ContentError>;
    fn resilience(&self) -> Option<&ToolResilience>;
    /// Build a command from already-parsed arguments without running the input schema.
    fn from_input(self: &Rc<Self>, input: ToolInput<Self::Args>) -> ToolCommand<Self> {
        ToolCommand {
            command: CmdDef::<SignatureOf<Self>>::named(self.name()).from_record(input),
            tool: Rc::clone(self),
        }
    }
    fn command(
        self: &Rc<Self>,
        call: &ToolCall<Self::RawArgs>,
    ) -> Result<ToolCommand<Self>, ToolError> {
        let args = match self.parse_args(Rc::clone(&call.args)) {
            Ok(args) => args,
            Err(ToolError::Schema(SchemaError::Issues(issues))) => {
                return Err(ToolError::Contract(CommandContractError::Input {
                    cmd_type: self.name().into(),
                    issues,
                }));
            }
            Err(ToolError::Schema(SchemaError::Async)) => {
                return Err(CommandContractError::AsyncSchema {
                    location: format!("the \"{}\" tool's input schema", self.name()),
                }
                .into());
            }
            Err(error) => return Err(error),
        };
        Ok(self.from_input(ToolInput {
            call_id: call.call_id.clone(),
            args,
        }))
    }
}
impl<R, A, O, IS, OS, E, X, H, C> ToolDefinition for ToolDef<'_, R, A, O, IS, OS, E, X, H, C>
where
    IS: Schema<Raw = Rc<R>, Output = Rc<A>, Error = SchemaError>,
    OS: Schema<Output = Rc<O>, Error = SchemaError>,
    E: Tagged,
{
    type RawArgs = R;
    type Args = A;
    type RawResult = OS::Raw;
    type Ok = O;
    type Error = E;
    type Thrown = X;
    type Host = H;
    type ContentError = C;
    fn name(&self) -> &str {
        &self.name
    }
    fn tags(&self) -> &[String] {
        &self.tags
    }
    fn parse_args(&self, raw: Rc<R>) -> Result<Rc<A>, ToolError> {
        parse(self.spec.input.as_ref(), raw)
    }
    fn parse_result(&self, raw: OS::Raw) -> Result<Rc<O>, ToolError> {
        parse(self.spec.ok.as_ref(), raw)
    }
    fn failure_view(&self, error: &ToolFailure<E, X>) -> Result<PlainData, CommandContractError> {
        match error {
            ToolFailure::Declared(e) => (self.spec.family.view)(e),
            ToolFailure::Thrown { message, .. } => Ok(PlainData::Object(
                [
                    ("_tag".into(), PlainData::String("thrown".into())),
                    ("message".into(), PlainData::String(message.clone())),
                ]
                .into_iter()
                .collect(),
            )),
        }
    }
    fn handle<'s>(
        &'s self,
        args: &'s Rc<A>,
        context: ToolContext<'s, H>,
    ) -> LocalBoxFuture<'s, Result<Option<Outcome<OS::Raw, ToolFailure<E, X>>>, ToolError>> {
        Box::pin(async move {
            Ok(Some(match (self.handler)(args, context).await {
                Ok(Outcome::Ok { value }) => Outcome::ok(value),
                Ok(Outcome::Err { error }) => Outcome::err(ToolFailure::Declared(error)),
                Err(Raised::Declared(error)) => {
                    if self.spec.family.tags.iter().any(|tag| tag == error.tag()) {
                        Outcome::err(ToolFailure::Declared(error))
                    } else {
                        let value = (self.spec.family.view)(&error)?;
                        let message = describe_error(ErrorView::Value(&value))?;
                        Outcome::err(ToolFailure::Thrown {
                            message,
                            cause: ThrownCause::Value(Rc::new(value)),
                        })
                    }
                }
                Err(Raised::Error { message, cause }) => Outcome::err(ToolFailure::Thrown {
                    message: describe_error(ErrorView::ErrorMessage(&message))?,
                    cause: ThrownCause::Error(cause),
                }),
                Err(Raised::Value(value)) => {
                    let message = describe_error(ErrorView::Value(&value))?;
                    Outcome::err(ToolFailure::Thrown {
                        message,
                        cause: ThrownCause::Value(value),
                    })
                }
            }))
        })
    }
    fn parts(&self, result: &Rc<O>) -> Result<Option<Parts>, C> {
        self.spec.content.as_ref().map(|f| f(result)).transpose()
    }
    fn resilience(&self) -> Option<&ToolResilience> {
        self.spec.resilience.as_ref()
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInput<A> {
    pub call_id: JsText,
    pub args: Rc<A>,
}
impl<A> CommandRecord for ToolInput<A> {}
#[expect(
    clippy::type_complexity,
    reason = "The contravariant marker names five typed channels without owning or bounding their payloads."
)]
pub struct ToolSignature<A, R, O, E, X>(PhantomData<fn(A, R, O, E, X)>);
pub type SignatureOf<T> = ToolSignature<
    <T as ToolDefinition>::Args,
    <T as ToolDefinition>::RawResult,
    <T as ToolDefinition>::Ok,
    <T as ToolDefinition>::Error,
    <T as ToolDefinition>::Thrown,
>;
impl<A, R, O, E: Tagged, X> CommandSpec for ToolSignature<A, R, O, E, X> {
    type Input = ToolInput<A>;
    type RawOutput = R;
    type Output = Rc<O>;
    type Error = ToolFailure<E, X>;
    const NAME: &'static str = "tool";
    const ERROR_TAGS: &'static [&'static str] = &[];
    fn parse_input(_: serde_json::Value) -> Result<Self::Input, SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "tool arguments require their declared schema",
        )]))
    }
    fn parse_output(_: R) -> Result<Rc<O>, SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "tool result requires its declared schema",
        )]))
    }
}
/// The selected interpreter's immutable instance contract travels with its raw outcome.
/// Serialization still writes only the ordinary Outcome record.
pub struct ToolCompletion<T: ToolDefinition> {
    chosen: Rc<T>,
    outcome: command::Completion<SignatureOf<T>>,
}
impl<T: ToolDefinition> ToolCompletion<T> {
    pub fn new(chosen: Rc<T>, outcome: command::Completion<SignatureOf<T>>) -> Self {
        Self { chosen, outcome }
    }
    pub fn tool(&self) -> &Rc<T> {
        &self.chosen
    }
    pub fn outcome(&self) -> &command::Completion<SignatureOf<T>> {
        &self.outcome
    }
}
impl<T: ToolDefinition> Serialize for ToolCompletion<T>
where
    T::RawResult: Serialize,
    T::Error: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.outcome.serialize(serializer)
    }
}
pub struct ToolCommand<T: ToolDefinition> {
    command: Cmd<SignatureOf<T>>,
    tool: Rc<T>,
}
impl<T: ToolDefinition> ToolCommand<T> {
    pub fn tool(&self) -> &Rc<T> {
        &self.tool
    }
    pub fn cmd(&self) -> &Cmd<SignatureOf<T>> {
        &self.command
    }
}
impl<T: ToolDefinition> Tagged for ToolCommand<T> {
    fn tag(&self) -> &str {
        self.command.tag()
    }
}
impl<T: ToolDefinition> Serialize for ToolCommand<T>
where
    T::Args: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.command.serialize(s)
    }
}
impl<T: ToolDefinition> CommandFamily for ToolCommand<T> {
    type Msg = Settled<SignatureOf<T>>;
    type Completion = ToolCompletion<T>;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(m: &Self::Msg) -> Option<&command::EngineStamp> {
        m.engine_stamp()
    }
    fn settle(
        self,
        completion: Self::Completion,
        at: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        let chosen = completion.chosen;
        if chosen.name() != self.tag() {
            return Err(CommandContractError::mismatched(self.tag(), chosen.name()));
        }
        let outcome = completion.outcome;
        self.command
            .with_contract_view(
                |raw| match chosen.parse_result(raw) {
                    Ok(value) => Ok(Ok(value)),
                    Err(ToolError::Schema(error)) => Ok(Err(error)),
                    Err(error) => Err(CommandContractError::Outcome {
                        cmd_type: chosen.name().into(),
                        detail: error.to_string(),
                    }),
                },
                chosen.tags(),
                |error| chosen.failure_view(error),
            )
            .settle(outcome, at)
    }
    fn settle_in(
        self,
        completion: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        let chosen = completion.chosen;
        if chosen.name() != self.tag() {
            return Err(CommandContractError::mismatched(self.tag(), chosen.name()));
        }
        let outcome = completion.outcome;
        self.command
            .with_contract_view(
                |raw| match chosen.parse_result(raw) {
                    Ok(value) => Ok(Ok(value)),
                    Err(ToolError::Schema(error)) => Ok(Err(error)),
                    Err(error) => Err(CommandContractError::Outcome {
                        cmd_type: chosen.name().into(),
                        detail: error.to_string(),
                    }),
                },
                chosen.tags(),
                |error| chosen.failure_view(error),
            )
            .settle_in(outcome, edge)
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "_tag", rename_all = "snake_case")]
pub enum ToolRejection {
    UnknownTool { name: JsText },
    MalformedArgs { name: JsText, issues: Vec<Issue> },
}
impl Tagged for ToolRejection {
    fn tag(&self) -> &str {
        match self {
            Self::UnknownTool { .. } => "unknown_tool",
            Self::MalformedArgs { .. } => "malformed_args",
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedInput {
    pub call_id: JsText,
    pub error: ToolRejection,
}
impl CommandRecord for RejectedInput {}
pub struct RejectedSpec;
impl CommandSpec for RejectedSpec {
    type Input = RejectedInput;
    type RawOutput = ();
    type Output = ();
    type Error = ToolRejection;
    const NAME: &'static str = REJECTED_TYPE;
    const ERROR_TAGS: &'static [&'static str] = &["unknown_tool", "malformed_args"];
    fn parse_input(_: serde_json::Value) -> Result<RejectedInput, SchemaError> {
        Err(SchemaError::Issues(vec![]))
    }
    fn parse_output(_: ()) -> Result<(), SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new(
            "",
            "Expected no successful tool rejection",
        )]))
    }
}
#[doc(hidden)]
pub fn rejected(call_id: JsText, error: ToolRejection) -> Cmd<RejectedSpec> {
    CmdDef::<RejectedSpec>::new().from_record(RejectedInput { call_id, error })
}
#[doc(hidden)]
pub fn reject_route<T: ToolDefinition>(
    tool: &Rc<T>,
    call: &ToolCall<T::RawArgs>,
) -> Result<Result<ToolCommand<T>, Cmd<RejectedSpec>>, ToolError> {
    match tool.command(call) {
        Ok(cmd) => Ok(Ok(cmd)),
        Err(ToolError::Contract(CommandContractError::Input { issues, .. })) => Ok(Err(rejected(
            call.call_id.clone(),
            ToolRejection::MalformedArgs {
                name: call.name.clone(),
                issues,
            },
        ))),
        Err(e) => Err(e),
    }
}

pub struct ToolSettlement<R, E> {
    pub call_id: JsText,
    pub outcome: ToolOutcome<R, E>,
}
pub type FailureOf<D> = FailureView<Failure<<D as CommandSpec>::Error>>;
pub struct FailureView<E> {
    pub error: E,
    pub reason: JsText,
    fields: PlainData,
}
impl<E> Serialize for FailureView<E> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.fields.serialize(s)
    }
}
impl<R: Serialize, E: Serialize> Serialize for ToolSettlement<R, E> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(2))?;
        m.serialize_entry("callId", &self.call_id)?;
        m.serialize_entry("outcome", &self.outcome)?;
        m.end()
    }
}
pub fn tool_error_reason(error: &PlainData) -> Result<JsText, CommandContractError> {
    let PlainData::Object(fields) = error else {
        return Err(CommandContractError::serialization(
            "tool error must be a record",
        ));
    };
    let mut detail = fields.clone();
    let tag = detail.shift_remove("_tag").unwrap_or(PlainData::Undefined);
    let tag = crate::js_record::string(&tag)
        .map_err(|e| CommandContractError::serialization(e.to_string()))?;
    if detail.is_empty() {
        Ok(tag)
    } else {
        let json = stringify_json(&PlainData::Object(detail)).ok_or_else(|| {
            CommandContractError::serialization("tool error detail cannot be encoded")
        })?;
        {
            let mut units = tag.as_units().to_vec();
            units.push(32);
            units.extend(json.encode_utf16());
            Ok(JsText::from_units(units))
        }
    }
}
#[doc(hidden)]
pub fn failure<E>(error: E, view: PlainData) -> Result<FailureView<E>, CommandContractError> {
    let reason = tool_error_reason(&view)?;
    let PlainData::Object(mut fields) = view else {
        unreachable!()
    };
    fields.insert("reason".into(), PlainData::String(reason.clone()));
    fields.insert("kind".into(), PlainData::String("error".into()));
    Ok(FailureView {
        error,
        reason,
        fields: PlainData::Object(fields),
    })
}
#[doc(hidden)]
pub fn snapshot_error<T: ToolDefinition>(
    tool: &T,
    error: &Failure<ToolFailure<T::Error, T::Thrown>>,
) -> Result<FailureOf<SignatureOf<T>>, CommandContractError> {
    let (error, view) = match error {
        Failure::Declared(e) => (Failure::Declared(e.clone()), tool.failure_view(e)?),
        Failure::Malformed(e) => (
            Failure::Malformed(e.clone()),
            plain_data(e).map_err(CommandContractError::serialization)?,
        ),
    };
    failure(error, view)
}

#[doc(hidden)]
pub fn rejected_error(
    error: &Failure<ToolRejection>,
) -> Result<FailureOf<RejectedSpec>, CommandContractError> {
    match error {
        Failure::Declared(e) => failure(
            Failure::Declared(e.clone()),
            plain_data(e).map_err(CommandContractError::serialization)?,
        ),
        Failure::Malformed(e) => failure(
            Failure::Malformed(e.clone()),
            plain_data(e).map_err(CommandContractError::serialization)?,
        ),
    }
}
