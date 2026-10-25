use std::{
    cell::RefCell,
    fmt,
    marker::PhantomData,
    rc::Rc,
    sync::{Arc, Weak},
};

use serde::{Serialize, ser::SerializeMap};
use serde_json::{Value, json};

use crate::{PlainData, Tagged, data::plain_data};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Issue {
    pub path: String,
    pub message: String,
}
impl Issue {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug)]
pub enum SchemaError {
    Issues(Vec<Issue>),
    Async,
}
impl From<serde_json::Error> for SchemaError {
    fn from(error: serde_json::Error) -> Self {
        Self::Issues(vec![Issue::new("", error.to_string())])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(tag = "_tag", rename = "malformed_result")]
pub struct MalformedResult {
    pub issues: Vec<Issue>,
}
pub fn malformed_result(issues: Vec<Issue>) -> MalformedResult {
    MalformedResult { issues }
}

#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(tag = "_tag")]
pub enum Outcome<O, E> {
    Ok { value: O },
    Err { error: E },
}
impl<O, E> Outcome<O, E> {
    pub fn ok(value: O) -> Self {
        Self::Ok { value }
    }
    pub fn err(error: E) -> Self {
        Self::Err { error }
    }
}

pub trait CommandSpec {
    type Input;
    type RawOutput;
    type Output;
    type Error: Tagged;
    const NAME: &'static str;
    const ERROR_TAGS: &'static [&'static str];
    fn parse_input(value: Value) -> Result<Self::Input, SchemaError>;
    fn parse_output(value: Self::RawOutput) -> Result<Self::Output, SchemaError>;
}

/// A typed command-input record whose effect tag is owned by `Cmd`.
///
/// Implement this for input structs constructed from already-parsed domain
/// values. Their fields must form a record without a `type` field. Serialization
/// and external parsing keep their own checked boundaries.
pub trait CommandRecord {}

pub struct Cmd<D: CommandSpec> {
    input: D::Input,
    declaration: PhantomData<fn() -> D>,
}
impl<D: CommandSpec> Cmd<D> {
    pub fn input(&self) -> &D::Input {
        &self.input
    }
    pub fn into_input(self) -> D::Input {
        self.input
    }
}
impl<D: CommandSpec> Tagged for Cmd<D> {
    fn tag(&self) -> &str {
        D::NAME
    }
}
impl<D: CommandSpec> Serialize for Cmd<D>
where
    D::Input: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let PlainData::Object(mut input) =
            plain_data(&self.input).map_err(serde::ser::Error::custom)?
        else {
            return Err(serde::ser::Error::custom("command input must be a record"));
        };
        input.insert("type".into(), PlainData::String(D::NAME.into()));
        PlainData::Object(input).serialize(serializer)
    }
}
impl<'de, D: CommandSpec> serde::Deserialize<'de> for Cmd<D>
where
    D::Input: serde::de::DeserializeOwned + Serialize,
{
    fn deserialize<S: serde::Deserializer<'de>>(deserializer: S) -> Result<Self, S::Error> {
        let value = Value::deserialize(deserializer)?;
        let mut payload = value
            .as_object()
            .cloned()
            .ok_or_else(|| serde::de::Error::custom("command must be a record"))?;
        if payload.remove("type").as_ref().and_then(Value::as_str) != Some(D::NAME) {
            return Err(serde::de::Error::custom(format!(
                "expected command type {}",
                D::NAME
            )));
        }
        let input =
            serde_json::from_value(Value::Object(payload)).map_err(serde::de::Error::custom)?;
        CmdDef::<D>::new()
            .build(input)
            .map_err(serde::de::Error::custom)
    }
}

/// A handler reports only the declared output and failure channels.
///
/// ```compile_fail,E0308
/// use demlik_tea::command::{CommandSpec, Completion, Outcome};
/// fn wrong_success<D: CommandSpec<RawOutput = String>>() -> Completion<D> {
///     Some(Outcome::ok(42_u64))
/// }
/// ```
///
/// ```compile_fail,E0308
/// use demlik_tea::command::{CommandSpec, Completion, Outcome};
/// fn wrong_failure<D: CommandSpec>() -> Completion<D> {
///     Some(Outcome::err("an undeclared failure type"))
/// }
/// ```
pub type Completion<D> = Option<Outcome<<D as CommandSpec>::RawOutput, <D as CommandSpec>::Error>>;

#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum Failure<E> {
    Declared(E),
    Malformed(MalformedResult),
}
pub enum Settlement<O, E> {
    Ok(O),
    Err(Failure<E>),
}
pub type SettledParts<D> = (
    Cmd<D>,
    Settlement<<D as CommandSpec>::Output, <D as CommandSpec>::Error>,
    Option<f64>,
);
pub struct Settled<D: CommandSpec> {
    kind: String,
    cmd: Cmd<D>,
    outcome: Settlement<D::Output, D::Error>,
    at: Option<f64>,
    engine_stamp: Option<EngineStamp>,
}
impl<D: CommandSpec> Settled<D> {
    pub fn cmd(&self) -> &Cmd<D> {
        &self.cmd
    }
    pub fn outcome(&self) -> &Settlement<D::Output, D::Error> {
        &self.outcome
    }
    pub fn at(&self) -> Option<f64> {
        self.at
    }
    pub fn engine_stamp(&self) -> Option<&EngineStamp> {
        self.engine_stamp.as_ref()
    }
    pub fn into_parts(self) -> SettledParts<D> {
        (self.cmd, self.outcome, self.at)
    }
}
impl<D: CommandSpec> Tagged for Settled<D> {
    fn tag(&self) -> &str {
        &self.kind
    }
}
impl<D: CommandSpec> Serialize for Settled<D>
where
    D::Input: Serialize,
    D::Output: Serialize,
    D::Error: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut record = serializer.serialize_map(Some(if self.at.is_some() { 4 } else { 3 }))?;
        record.serialize_entry("type", &self.kind)?;
        record.serialize_entry("cmd", &self.cmd)?;
        match &self.outcome {
            Settlement::Ok(value) => record.serialize_entry("value", value)?,
            Settlement::Err(error) => record.serialize_entry("error", error)?,
        }
        if let Some(at) = self.at {
            record.serialize_entry("at", &at)?;
        }
        record.end()
    }
}
impl<'de, D: CommandSpec> serde::Deserialize<'de> for Settled<D>
where
    D::Input: serde::de::DeserializeOwned + Serialize,
    D::Output: serde::de::DeserializeOwned,
    D::Error: serde::de::DeserializeOwned,
{
    fn deserialize<S: serde::Deserializer<'de>>(deserializer: S) -> Result<Self, S::Error> {
        let mut value = Value::deserialize(deserializer)?;
        let record = value
            .as_object_mut()
            .ok_or_else(|| serde::de::Error::custom("settled message must be a record"))?;
        let kind = record
            .remove("type")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| serde::de::Error::custom("settled message needs a type"))?;
        let cmd = serde_json::from_value(
            record
                .remove("cmd")
                .ok_or_else(|| serde::de::Error::missing_field("cmd"))?,
        )
        .map_err(serde::de::Error::custom)?;
        let at = record
            .remove("at")
            .map(serde_json::from_value)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        let outcome = if kind == format!("{}_ok", D::NAME) {
            Settlement::Ok(
                serde_json::from_value(
                    record
                        .remove("value")
                        .ok_or_else(|| serde::de::Error::missing_field("value"))?,
                )
                .map_err(serde::de::Error::custom)?,
            )
        } else if kind == format!("{}_err", D::NAME) {
            let error = record
                .remove("error")
                .ok_or_else(|| serde::de::Error::missing_field("error"))?;
            Settlement::Err(
                if error.get("_tag").and_then(Value::as_str) == Some("malformed_result")
                    && !D::ERROR_TAGS.contains(&"malformed_result")
                {
                    Failure::Malformed(
                        serde_json::from_value(error).map_err(serde::de::Error::custom)?,
                    )
                } else {
                    Failure::Declared(
                        serde_json::from_value(error).map_err(serde::de::Error::custom)?,
                    )
                },
            )
        } else {
            return Err(serde::de::Error::custom(format!(
                "unexpected settled message type {kind}"
            )));
        };
        Ok(Self {
            kind,
            cmd,
            outcome,
            at,
            engine_stamp: None,
        })
    }
}

pub struct CmdDef<D>(PhantomData<fn() -> D>);
impl<D: CommandSpec> Default for CmdDef<D> {
    fn default() -> Self {
        Self::new()
    }
}
impl<D: CommandSpec> CmdDef<D> {
    pub const fn new() -> Self {
        Self(PhantomData)
    }
    pub fn cmd_type(&self) -> &'static str {
        D::NAME
    }
    pub fn ok_type(&self) -> String {
        format!("{}_ok", D::NAME)
    }
    pub fn err_type(&self) -> String {
        format!("{}_err", D::NAME)
    }
    pub fn error_tags(&self) -> &'static [&'static str] {
        D::ERROR_TAGS
    }
    /// Build from a trusted typed record without serializing the pure payload.
    /// Wire input uses `parse_input`; checked serializable input uses `build`.
    ///
    /// ```compile_fail,E0277
    /// use demlik_tea::{Tagged, command::{CmdDef, CommandSpec, SchemaError}};
    /// struct Scalar;
    /// struct Never;
    /// impl Tagged for Never { fn tag(&self) -> &str { "never" } }
    /// impl CommandSpec for Scalar {
    ///     type Input = u32;
    ///     type RawOutput = ();
    ///     type Output = ();
    ///     type Error = Never;
    ///     const NAME: &'static str = "scalar";
    ///     const ERROR_TAGS: &'static [&'static str] = &[];
    ///     fn parse_input(_: serde_json::Value) -> Result<u32, SchemaError> { Ok(0) }
    ///     fn parse_output(_: ()) -> Result<(), SchemaError> { Ok(()) }
    /// }
    /// CmdDef::<Scalar>::new().from_record(7);
    /// ```
    pub fn from_record(&self, input: D::Input) -> Cmd<D>
    where
        D::Input: CommandRecord,
    {
        self.wrap_input(input)
    }
    fn wrap_input(&self, input: D::Input) -> Cmd<D> {
        Cmd {
            input,
            declaration: PhantomData,
        }
    }
    pub fn build(&self, input: D::Input) -> Result<Cmd<D>, CommandContractError>
    where
        D::Input: Serialize,
    {
        let value = plain_data(&input).map_err(CommandContractError::serialization)?;
        if !matches!(&value, PlainData::Object(record) if !record.contains_key("type")) {
            return Err(CommandContractError::Input {
                cmd_type: D::NAME.into(),
                issues: vec![Issue::new(
                    "",
                    "command input must be a record without a type field",
                )],
            });
        }
        Ok(self.wrap_input(input))
    }
    pub fn parse_input(&self, value: Value) -> Result<Cmd<D>, CommandContractError>
    where
        D::Input: Serialize,
    {
        match D::parse_input(value) {
            Ok(input) => self.build(input),
            Err(SchemaError::Issues(issues)) => Err(CommandContractError::Input {
                cmd_type: D::NAME.into(),
                issues,
            }),
            Err(SchemaError::Async) => Err(CommandContractError::AsyncSchema {
                location: format!("the \"{}\" Cmd's input schema", D::NAME),
            }),
        }
    }
    pub fn ok(&self, cmd: Cmd<D>, value: D::Output, at: Option<f64>) -> Settled<D> {
        Settled {
            kind: self.ok_type(),
            cmd,
            outcome: Settlement::Ok(value),
            at,
            engine_stamp: None,
        }
    }
    pub fn err(&self, cmd: Cmd<D>, error: D::Error, at: Option<f64>) -> Settled<D> {
        Settled {
            kind: self.err_type(),
            cmd,
            outcome: Settlement::Err(Failure::Declared(error)),
            at,
            engine_stamp: None,
        }
    }
    pub fn settle(
        &self,
        cmd: Cmd<D>,
        completion: Completion<D>,
        at: f64,
    ) -> Result<Option<Settled<D>>, CommandContractError>
    where
        D::Error: Serialize,
    {
        let Some(completion) = completion else {
            return Ok(None);
        };
        Ok(Some(match completion {
            Outcome::Err { error } => {
                let failure =
                    serde_json::to_value(&error).map_err(CommandContractError::serialization)?;
                if !failure
                    .get("_tag")
                    .and_then(Value::as_str)
                    .is_some_and(|tag| D::ERROR_TAGS.contains(&tag))
                {
                    return Err(CommandContractError::UndeclaredFailure {
                        cmd_type: D::NAME.into(),
                        failure,
                        declared: D::ERROR_TAGS.iter().map(|tag| (*tag).into()).collect(),
                    });
                }
                self.err(cmd, error, Some(at))
            }
            Outcome::Ok { value } => match D::parse_output(value) {
                Ok(value) => self.ok(cmd, value, Some(at)),
                Err(SchemaError::Issues(issues)) => Settled {
                    kind: self.err_type(),
                    cmd,
                    at: Some(at),
                    outcome: Settlement::Err(Failure::Malformed(malformed_result(issues))),
                    engine_stamp: None,
                },
                Err(SchemaError::Async) => {
                    return Err(CommandContractError::AsyncSchema {
                        location: format!("the \"{}\" Cmd's ok schema", D::NAME),
                    });
                }
            },
        }))
    }
    pub fn settle_in(
        &self,
        cmd: Cmd<D>,
        completion: Completion<D>,
        edge: &CommandEdge,
    ) -> Result<Option<Settled<D>>, CommandContractError>
    where
        D::Error: Serialize,
    {
        if completion.is_none() {
            return Ok(None);
        }
        let at = (edge.clock)();
        let mut settled = self.settle(cmd, completion, at)?;
        if let Some(settled) = &mut settled {
            settled.engine_stamp = Some(EngineStamp {
                edge: Arc::clone(&edge.identity),
                at,
            });
        }
        Ok(settled)
    }
}

#[derive(Clone)]
pub struct CommandEdge {
    clock: Rc<dyn Fn() -> f64>,
    identity: Arc<()>,
}
impl CommandEdge {
    pub fn new(clock: impl Fn() -> f64 + 'static) -> Self {
        Self {
            clock: Rc::new(clock),
            identity: Arc::new(()),
        }
    }
    pub fn now(&self) -> f64 {
        (self.clock)()
    }
}

pub struct EngineStamp {
    edge: Arc<()>,
    at: f64,
}
impl EngineStamp {
    pub fn at(&self) -> f64 {
        self.at
    }
}

pub struct DispatchGuard<M> {
    command: String,
    defined: bool,
    edge: Arc<()>,
    stamp: fn(&M) -> Option<&EngineStamp>,
}
impl<M> Clone for DispatchGuard<M> {
    fn clone(&self) -> Self {
        Self {
            command: self.command.clone(),
            defined: self.defined,
            edge: Arc::clone(&self.edge),
            stamp: self.stamp,
        }
    }
}
impl<M: Tagged> DispatchGuard<M> {
    pub fn check(&self, message: &M) -> Result<(), CommandContractError> {
        let name = message.tag();
        if !self.defined
            || name != format!("{}_ok", self.command) && name != format!("{}_err", self.command)
        {
            return Ok(());
        }
        if (self.stamp)(message).is_some_and(|stamp| Arc::ptr_eq(&stamp.edge, &self.edge)) {
            return Ok(());
        }
        Err(CommandContractError::Outcome {
            cmd_type: self.command.clone(),
            detail: format!("dispatched its own \"{name}\" Msg"),
        })
    }
}

pub trait CommandFamily: Tagged {
    type Msg;
    type Completion;
    fn settle(
        self,
        completion: Self::Completion,
        at: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError>;
    fn is_defined(&self) -> bool {
        false
    }
    fn engine_stamp(_message: &Self::Msg) -> Option<&EngineStamp> {
        None
    }
    fn dispatch_guard(&self, edge: &CommandEdge) -> DispatchGuard<Self::Msg> {
        DispatchGuard {
            command: self.tag().into(),
            defined: self.is_defined(),
            edge: Arc::clone(&edge.identity),
            stamp: Self::engine_stamp,
        }
    }
    fn settle_in(
        self,
        completion: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Self::Msg>, CommandContractError>
    where
        Self: Sized,
    {
        if self.is_defined() {
            return Err(CommandContractError::Outcome {
                cmd_type: self.tag().into(),
                detail: "did not settle through the engine's command edge".into(),
            });
        }
        self.settle(completion, edge.now())
    }
}
impl<D: CommandSpec> CommandFamily for Cmd<D>
where
    D::Error: Serialize,
{
    type Msg = Settled<D>;
    type Completion = Completion<D>;
    fn is_defined(&self) -> bool {
        true
    }
    fn engine_stamp(message: &Self::Msg) -> Option<&EngineStamp> {
        message.engine_stamp()
    }
    fn settle(
        self,
        completion: Self::Completion,
        at: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(CmdDef::<D>::new()
            .settle(self, completion, at)?
            .into_iter()
            .collect())
    }
    fn settle_in(
        self,
        completion: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(CmdDef::<D>::new()
            .settle_in(self, completion, edge)?
            .into_iter()
            .collect())
    }
}

#[derive(Debug)]
pub enum CommandContractError {
    Input {
        cmd_type: String,
        issues: Vec<Issue>,
    },
    AsyncSchema {
        location: String,
    },
    UndeclaredFailure {
        cmd_type: String,
        failure: Value,
        declared: Vec<String>,
    },
    Outcome {
        cmd_type: String,
        detail: String,
    },
    CompletionMismatch {
        cmd_type: String,
        completion_type: String,
    },
    Serialization {
        message: String,
    },
    NullDispatch,
}
impl CommandContractError {
    fn serialization(error: impl fmt::Display) -> Self {
        Self::Serialization {
            message: error.to_string(),
        }
    }
    pub fn mismatched(cmd_type: impl Into<String>, completion_type: impl Into<String>) -> Self {
        Self::CompletionMismatch {
            cmd_type: cmd_type.into(),
            completion_type: completion_type.into(),
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Input { .. } => "CommandInputError",
            Self::AsyncSchema { .. } => "AsyncSchemaError",
            Self::UndeclaredFailure { .. } => "UndeclaredFailureError",
            Self::Outcome { .. } => "OutcomeContractError",
            Self::CompletionMismatch { .. } => "CompletionMismatchError",
            Self::Serialization { .. } => "CommandSerializationError",
            Self::NullDispatch => "TypeError",
        }
    }
}
impl fmt::Display for CommandContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input { cmd_type, .. } => {
                write!(f, "@demlik/tea: invalid input for Cmd \"{cmd_type}\"")
            }
            Self::AsyncSchema { location } => write!(
                f,
                "@demlik/tea: {location} validated asynchronously. tea checks schemas synchronously, so a schema whose `~standard.validate` returns a Promise cannot be used here."
            ),
            Self::UndeclaredFailure {
                cmd_type,
                failure,
                declared,
            } => {
                let description = failure
                    .get("_tag")
                    .and_then(Value::as_str)
                    .map(|tag| format!("_tag \"{tag}\""))
                    .unwrap_or_else(|| "a value with no _tag".into());
                let declared = if declared.is_empty() {
                    "none".into()
                } else {
                    declared
                        .iter()
                        .map(|tag| format!("\"{tag}\""))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                write!(
                    f,
                    "@demlik/tea: the \"{cmd_type}\" handler failed with {description}, which its Cmd.define does not declare (declared: {declared}). An undeclared failure goes to the error sink, never to \"{cmd_type}_err\"."
                )
            }
            Self::Outcome { cmd_type, detail } => write!(
                f,
                "@demlik/tea: the \"{cmd_type}\" handler {detail}. A Cmd.define'd handler returns an outcome — `ok(value)` or `err({{ _tag }})` — and the engine mints \"{cmd_type}_ok\" / \"{cmd_type}_err\" from it."
            ),
            Self::CompletionMismatch {
                cmd_type,
                completion_type,
            } => write!(
                f,
                "@demlik/tea: Cmd \"{cmd_type}\" received completion for \"{completion_type}\""
            ),
            Self::Serialization { message } => write!(
                f,
                "@demlik/tea: command data could not be serialized: {message}"
            ),
            Self::NullDispatch => f.write_str("Cannot read properties of null (reading 'type')"),
        }
    }
}
impl std::error::Error for CommandContractError {}
impl Serialize for CommandContractError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value =
            json!({ "name": self.name(), "_tag": self.name(), "message": self.to_string() });
        if matches!(self, Self::NullDispatch) {
            value
                .as_object_mut()
                .expect("error is a record")
                .remove("_tag");
        }
        match self {
            Self::Input { cmd_type, issues } => {
                value["cmdType"] = json!(cmd_type);
                value["issues"] = json!(issues);
            }
            Self::AsyncSchema { location } => value["where"] = json!(location),
            Self::UndeclaredFailure {
                cmd_type,
                failure,
                declared,
            } => {
                value["cmdType"] = json!(cmd_type);
                value["failure"] = failure.clone();
                value["declared"] = json!(declared);
            }
            Self::Outcome { cmd_type, .. } => value["cmdType"] = json!(cmd_type),
            Self::CompletionMismatch {
                cmd_type,
                completion_type,
            } => {
                value["cmdType"] = json!(cmd_type);
                value["completionType"] = json!(completion_type);
            }
            Self::Serialization { .. } => {}
            Self::NullDispatch => {}
        }
        value.serialize(serializer)
    }
}

pub struct WireDefinition<'a> {
    name: String,
    error_tags: Vec<String>,
    parse_output: Box<dyn Fn(Value) -> Result<Value, SchemaError> + 'a>,
}
impl<'a> WireDefinition<'a> {
    pub fn new(
        name: impl Into<String>,
        error_tags: &[&str],
        parse_output: impl Fn(Value) -> Result<Value, SchemaError> + 'a,
    ) -> Self {
        Self {
            name: name.into(),
            error_tags: error_tags.iter().map(|tag| (*tag).into()).collect(),
            parse_output: Box::new(parse_output),
        }
    }
}
impl<D: CommandSpec> CmdDef<D> {
    pub fn wire<'a>(&self) -> WireDefinition<'a>
    where
        D::RawOutput: serde::de::DeserializeOwned,
        D::Output: Serialize,
    {
        WireDefinition::new(D::NAME, D::ERROR_TAGS, |value| {
            let raw = serde_json::from_value(value).map_err(SchemaError::from)?;
            let parsed = D::parse_output(raw)?;
            serde_json::to_value(parsed).map_err(SchemaError::from)
        })
    }
}

/// A message's shared allocation retains the engine edge's mint provenance.
/// Encoding and decoding a replay message intentionally creates a new value.
#[derive(Clone, Debug)]
pub struct ContractValue(Arc<Value>);
impl ContractValue {
    pub fn new(value: Value) -> Self {
        Self(Arc::new(value))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn into_value(self) -> Value {
        Arc::try_unwrap(self.0).unwrap_or_else(|value| (*value).clone())
    }
}
impl Serialize for ContractValue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

pub struct CmdContract<'a> {
    definitions: Vec<WireDefinition<'a>>,
    minted: RefCell<Vec<Weak<Value>>>,
}
impl<'a> CmdContract<'a> {
    pub fn new(definitions: impl IntoIterator<Item = WireDefinition<'a>>) -> Self {
        Self {
            definitions: definitions.into_iter().collect(),
            minted: RefCell::new(Vec::new()),
        }
    }
    fn definition(&self, cmd: &Value) -> Option<&WireDefinition<'a>> {
        let name = cmd.get("type")?.as_str()?;
        self.definitions
            .iter()
            .rev()
            .find(|definition| definition.name == name)
    }
    pub fn settle(
        &self,
        cmd: &Value,
        returned: Option<Value>,
        clock: &mut impl FnMut() -> f64,
    ) -> Result<Option<ContractValue>, CommandContractError> {
        let Some(definition) = self.definition(cmd) else {
            return Ok(returned.map(ContractValue::new));
        };
        let Some(returned) = returned.filter(|value| !value.is_null()) else {
            return Ok(None);
        };
        let outcome_tag = returned.get("_tag").and_then(Value::as_str);
        let is_outcome = matches!(outcome_tag, Some("Ok")) && returned.get("value").is_some()
            || matches!(outcome_tag, Some("Err")) && returned.get("error").is_some();
        if !is_outcome {
            let detail = match returned.get("type").and_then(Value::as_str) {
                Some(name)
                    if name == format!("{}_ok", definition.name)
                        || name == format!("{}_err", definition.name) =>
                {
                    format!("returned its own \"{name}\" Msg")
                }
                Some(name) => format!("returned the \"{name}\" Msg"),
                None => "returned a value that is not an outcome".into(),
            };
            return Err(CommandContractError::Outcome {
                cmd_type: definition.name.clone(),
                detail,
            });
        }
        let at = clock();
        let message = if outcome_tag == Some("Err") {
            let failure = &returned["error"];
            let tag = failure.get("_tag").and_then(Value::as_str);
            if !tag.is_some_and(|tag| definition.error_tags.iter().any(|declared| declared == tag))
            {
                return Err(CommandContractError::UndeclaredFailure {
                    cmd_type: definition.name.clone(),
                    failure: failure.clone(),
                    declared: definition.error_tags.clone(),
                });
            }
            json!({ "type": format!("{}_err", definition.name), "cmd": cmd, "error": failure, "at": at })
        } else {
            match (definition.parse_output)(returned["value"].clone()) {
                Ok(value) => {
                    json!({ "type": format!("{}_ok", definition.name), "cmd": cmd, "value": value, "at": at })
                }
                Err(SchemaError::Issues(issues)) => {
                    json!({ "type": format!("{}_err", definition.name), "cmd": cmd, "error": malformed_result(issues), "at": at })
                }
                Err(SchemaError::Async) => {
                    return Err(CommandContractError::AsyncSchema {
                        location: format!("the \"{}\" Cmd's ok schema", definition.name),
                    });
                }
            }
        };
        let message = ContractValue::new(message);
        let mut minted = self.minted.borrow_mut();
        minted.retain(|value| value.strong_count() > 0);
        minted.push(Arc::downgrade(&message.0));
        Ok(Some(message))
    }
    pub fn check_dispatch(
        &self,
        cmd: &Value,
        message: &ContractValue,
    ) -> Result<(), CommandContractError> {
        let Some(definition) = self.definition(cmd) else {
            return Ok(());
        };
        if message.as_value().is_null() {
            return Err(CommandContractError::NullDispatch);
        }
        let Some(name) = message.as_value().get("type").and_then(Value::as_str) else {
            return Ok(());
        };
        if name != format!("{}_ok", definition.name) && name != format!("{}_err", definition.name) {
            return Ok(());
        }
        if self
            .minted
            .borrow()
            .iter()
            .any(|minted| minted.ptr_eq(&Arc::downgrade(&message.0)))
        {
            return Ok(());
        }
        Err(CommandContractError::Outcome {
            cmd_type: definition.name.clone(),
            detail: format!("dispatched its own \"{name}\" Msg"),
        })
    }
}

pub fn follow_ups(returned: Option<Value>) -> Vec<Value> {
    match returned {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(values)) => values,
        Some(value) => vec![value],
    }
}

pub fn none<C>() -> Vec<C> {
    Vec::new()
}
pub fn batch<C>(groups: impl IntoIterator<Item = impl IntoIterator<Item = C>>) -> Vec<C> {
    groups.into_iter().flatten().collect()
}
pub fn when<C>(condition: bool, command: C) -> Vec<C> {
    if condition { vec![command] } else { vec![] }
}
pub fn when_defined<T, C>(value: Option<T>, build: impl FnOnce(T) -> C) -> Vec<C> {
    value.map(build).into_iter().collect()
}
