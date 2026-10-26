mod input;
pub use input::{DecodedInput, InputFields};

use std::{
    borrow::Cow,
    cell::RefCell,
    fmt,
    marker::PhantomData,
    rc::Rc,
    sync::{Arc, Weak},
};

use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    PlainData, Tagged,
    data::{NumberOrNull, plain_data},
};

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
    /// A declaration with an undefined output can restore its omitted JSON
    /// field. Required output types keep the default missing-field refusal.
    fn missing_output() -> Option<Self::Output> {
        None
    }
}

/// A typed command-input record whose effect tag is owned by `Cmd`.
///
/// Implement this for input structs constructed from already-parsed domain
/// values. Their fields must form a record without a `type` field. Serialization
/// and external parsing keep their own checked boundaries.
pub trait CommandRecord {}

pub struct Cmd<D: CommandSpec> {
    input: D::Input,
    fields: Option<Box<InputFields>>,
    name: Cow<'static, str>,
    declaration: PhantomData<fn() -> D>,
}
impl<D: CommandSpec> Cmd<D> {
    pub fn input(&self) -> &D::Input {
        &self.input
    }
    pub fn fields(&self) -> Option<&InputFields> {
        self.fields.as_deref()
    }
    pub fn into_input(self) -> D::Input {
        self.input
    }
    pub fn definition(&self) -> CmdDef<D> {
        CmdDef {
            name: self.name.clone(),
            declaration: PhantomData,
        }
    }
    /// Supply the error family's contract view without serializing its opaque
    /// payload. The view supplies the checked `_tag` and refusal diagnostics;
    /// an accepted settlement retains the original typed error unchanged.
    pub fn with_error_classifier(
        self,
        classify_error: fn(&D::Error) -> Result<PlainData, CommandContractError>,
    ) -> ClassifiedCmd<D> {
        ClassifiedCmd {
            cmd: self,
            classify_error,
        }
    }
}
impl<D: CommandSpec> Tagged for Cmd<D> {
    fn tag(&self) -> &str {
        &self.name
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
        if let Some(fields) = &self.fields {
            input = fields.project(input).map_err(serde::ser::Error::custom)?;
        }
        input.insert("type".into(), PlainData::String(self.name.as_ref().into()));
        PlainData::Object(input).serialize(serializer)
    }
}
impl<'de, D: CommandSpec> serde::Deserialize<'de> for Cmd<D>
where
    D::Input: serde::de::DeserializeOwned + Serialize,
{
    fn deserialize<S: serde::Deserializer<'de>>(deserializer: S) -> Result<Self, S::Error> {
        CmdDef::<D>::new()
            .restore_command(Value::deserialize(deserializer)?)
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
    Option<NumberOrNull>,
);
pub struct Settled<D: CommandSpec> {
    kind: String,
    cmd: Cmd<D>,
    outcome: Settlement<D::Output, D::Error>,
    at: Option<NumberOrNull>,
    engine_stamp: Option<EngineStamp>,
}
impl<D: CommandSpec> Settled<D> {
    pub fn cmd(&self) -> &Cmd<D> {
        &self.cmd
    }
    pub fn outcome(&self) -> &Settlement<D::Output, D::Error> {
        &self.outcome
    }
    pub fn at(&self) -> Option<NumberOrNull> {
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
        let mut record = indexmap::IndexMap::from([
            ("type".into(), PlainData::String(self.kind.as_str().into())),
            (
                "cmd".into(),
                plain_data(&self.cmd).map_err(serde::ser::Error::custom)?,
            ),
        ]);
        let (key, value) = match &self.outcome {
            Settlement::Ok(value) => ("value", plain_data(value)),
            Settlement::Err(error) => ("error", plain_data(error)),
        };
        record.insert(key.into(), value.map_err(serde::ser::Error::custom)?);
        if let Some(at) = self.at {
            record.insert(
                "at".into(),
                plain_data(&at).map_err(serde::ser::Error::custom)?,
            );
        }
        PlainData::Object(record).serialize(serializer)
    }
}
impl<'de, D: CommandSpec> serde::Deserialize<'de> for Settled<D>
where
    D::Input: serde::de::DeserializeOwned + Serialize,
    D::Output: serde::de::DeserializeOwned,
    D::Error: serde::de::DeserializeOwned,
{
    fn deserialize<S: serde::Deserializer<'de>>(deserializer: S) -> Result<Self, S::Error> {
        restore_settled_value(
            &CmdDef::<D>::new(),
            Value::deserialize(deserializer)?,
            serde_json::from_value,
        )
        .map_err(serde::de::Error::custom)
    }
}
fn wire_error(message: impl fmt::Display) -> serde_json::Error {
    serde::de::Error::custom(message)
}
fn restore_settled_value<D: CommandSpec>(
    definition: &CmdDef<D>,
    mut value: Value,
    restore_command: impl FnOnce(Value) -> Result<Cmd<D>, serde_json::Error>,
) -> Result<Settled<D>, serde_json::Error>
where
    D::Output: serde::de::DeserializeOwned,
    D::Error: serde::de::DeserializeOwned,
{
    let record = value
        .as_object_mut()
        .ok_or_else(|| wire_error("settled message must be a record"))?;
    let kind = record
        .remove("type")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| wire_error("settled message needs a type"))?;
    let cmd = restore_command(
        record
            .remove("cmd")
            .ok_or_else(|| wire_error("missing field `cmd`"))?,
    )?;
    let at = record
        .remove("at")
        .map(serde_json::from_value)
        .transpose()?;
    let outcome = if kind == definition.ok_type() {
        Settlement::Ok(match record.remove("value") {
            Some(value) => serde_json::from_value(value)?,
            None => D::missing_output().ok_or_else(|| wire_error("missing field `value`"))?,
        })
    } else if kind == definition.err_type() {
        let error = record
            .remove("error")
            .ok_or_else(|| wire_error("missing field `error`"))?;
        Settlement::Err(
            if error.get("_tag").and_then(Value::as_str) == Some("malformed_result")
                && !D::ERROR_TAGS.contains(&"malformed_result")
            {
                Failure::Malformed(serde_json::from_value(error)?)
            } else {
                Failure::Declared(serde_json::from_value(error)?)
            },
        )
    } else {
        return Err(wire_error(format!(
            "unexpected settled message type {kind}"
        )));
    };
    Ok(Settled {
        kind,
        cmd,
        outcome,
        at,
        engine_stamp: None,
    })
}

pub struct CmdDef<D> {
    name: Cow<'static, str>,
    declaration: PhantomData<fn() -> D>,
}
impl<D> Clone for CmdDef<D> {
    fn clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            declaration: PhantomData,
        }
    }
}
impl<D: CommandSpec> Default for CmdDef<D> {
    fn default() -> Self {
        Self::new()
    }
}
impl<D: CommandSpec> CmdDef<D> {
    pub const fn new() -> Self {
        Self {
            name: Cow::Borrowed(D::NAME),
            declaration: PhantomData,
        }
    }
    /// Use an owned family name while retaining this declaration's typed
    /// input, output parser, and declared failure channel.
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: Cow::Owned(name.into()),
            declaration: PhantomData,
        }
    }
    pub fn cmd_type(&self) -> &str {
        &self.name
    }
    pub fn ok_type(&self) -> String {
        format!("{}_ok", self.name)
    }
    pub fn err_type(&self) -> String {
        format!("{}_err", self.name)
    }
    pub fn error_tags(&self) -> &'static [&'static str] {
        D::ERROR_TAGS
    }
    /// Decode a serialized command against this definition's name. The default
    /// `Deserialize` implementation uses `NAME`; named families use this owner.
    pub fn restore_command(&self, value: Value) -> Result<Cmd<D>, serde_json::Error>
    where
        D::Input: serde::de::DeserializeOwned + Serialize,
    {
        let mut payload = value
            .as_object()
            .cloned()
            .ok_or_else(|| wire_error("command must be a record"))?;
        if payload.remove("type").as_ref().and_then(Value::as_str) != Some(self.cmd_type()) {
            return Err(wire_error(format!(
                "expected command type {}",
                self.cmd_type()
            )));
        }
        let input = serde_json::from_value(Value::Object(payload))?;
        self.build(input).map_err(wire_error)
    }
    /// Restore replay data without minting engine provenance. A replay builder
    /// may refer to another named command; the referenced command keeps its tag.
    pub fn restore_settled(&self, value: Value) -> Result<Settled<D>, serde_json::Error>
    where
        D::Input: serde::de::DeserializeOwned + Serialize,
        D::Output: serde::de::DeserializeOwned,
        D::Error: serde::de::DeserializeOwned,
    {
        restore_settled_value(self, value, |command| {
            let name = command
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| wire_error("command needs a type"))?
                .to_owned();
            Self::named(name).restore_command(command)
        })
    }
    /// Build from a trusted typed record without serializing the pure payload.
    /// Wire input uses `parse_input` or `decode_input`; `build` checks a
    /// serializable input record.
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
    /// Decode once with a caller-owned rule, preserving its exact error type.
    /// Unlike `parse_input`, this does not invoke the declaration's static
    /// schema or serialize the typed input. Source unchecked schemas validate
    /// no fields; any field checks here belong to the supplied decoder.
    pub fn decode_input<R, E>(
        &self,
        raw: R,
        decode: impl FnOnce(R) -> Result<DecodedInput<D::Input>, E>,
    ) -> Result<Cmd<D>, E>
    where
        D::Input: CommandRecord,
    {
        let decoded = decode(raw)?;
        let mut cmd = self.wrap_input(decoded.input);
        cmd.fields = decoded.fields;
        Ok(cmd)
    }
    fn wrap_input(&self, input: D::Input) -> Cmd<D> {
        Cmd {
            input,
            fields: None,
            name: self.name.clone(),
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
                cmd_type: self.cmd_type().into(),
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
                cmd_type: self.cmd_type().into(),
                issues,
            }),
            Err(SchemaError::Async) => Err(CommandContractError::AsyncSchema {
                location: format!("the \"{}\" Cmd's input schema", self.cmd_type()),
            }),
        }
    }
    pub fn ok(&self, cmd: Cmd<D>, value: D::Output, at: Option<f64>) -> Settled<D> {
        Settled {
            kind: self.ok_type(),
            cmd,
            outcome: Settlement::Ok(value),
            at: at.map(Into::into),
            engine_stamp: None,
        }
    }
    pub fn err(&self, cmd: Cmd<D>, error: D::Error, at: Option<f64>) -> Settled<D> {
        Settled {
            kind: self.err_type(),
            cmd,
            outcome: Settlement::Err(Failure::Declared(error)),
            at: at.map(Into::into),
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
        self.settle_over(cmd, completion, at, |error| {
            plain_data(error).map_err(CommandContractError::serialization)
        })
    }
    fn settle_over(
        &self,
        cmd: Cmd<D>,
        completion: Completion<D>,
        at: f64,
        classify_error: impl FnOnce(&D::Error) -> Result<PlainData, CommandContractError>,
    ) -> Result<Option<Settled<D>>, CommandContractError> {
        let Some(completion) = completion else {
            return Ok(None);
        };
        let definition = cmd.definition();
        Ok(Some(match completion {
            Outcome::Err { error } => {
                let failure = classify_error(&error)?;
                if !failure_tag(&failure)
                    .and_then(crate::data::JsText::as_utf8)
                    .is_some_and(|tag| D::ERROR_TAGS.contains(&tag))
                {
                    return Err(CommandContractError::UndeclaredFailure {
                        cmd_type: definition.cmd_type().into(),
                        failure,
                        declared: D::ERROR_TAGS.iter().map(|tag| (*tag).into()).collect(),
                    });
                }
                definition.err(cmd, error, Some(at))
            }
            Outcome::Ok { value } => match D::parse_output(value) {
                Ok(value) => definition.ok(cmd, value, Some(at)),
                Err(SchemaError::Issues(issues)) => Settled {
                    kind: definition.err_type(),
                    cmd,
                    at: Some(at.into()),
                    outcome: Settlement::Err(Failure::Malformed(malformed_result(issues))),
                    engine_stamp: None,
                },
                Err(SchemaError::Async) => {
                    return Err(CommandContractError::AsyncSchema {
                        location: format!("the \"{}\" Cmd's ok schema", definition.cmd_type()),
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
        self.settle_in_over(cmd, completion, edge, |error| {
            plain_data(error).map_err(CommandContractError::serialization)
        })
    }
    fn settle_in_over(
        &self,
        cmd: Cmd<D>,
        completion: Completion<D>,
        edge: &CommandEdge,
        classify_error: impl FnOnce(&D::Error) -> Result<PlainData, CommandContractError>,
    ) -> Result<Option<Settled<D>>, CommandContractError> {
        if completion.is_none() {
            return Ok(None);
        }
        let at = (edge.clock)();
        let mut settled = self.settle_over(cmd, completion, at, classify_error)?;
        if let Some(settled) = &mut settled {
            settled.engine_stamp = Some(EngineStamp {
                edge: Arc::clone(&edge.identity),
                at,
            });
        }
        Ok(settled)
    }
}

/// A defined command with an explicit error-family contract view.
///
/// This execution adapter retains the original `Cmd` and produces its usual
/// `Settled<D>`. Classification does not make the opaque error serializable:
/// the view is used only for tag validation and refusal diagnostics. A refused
/// error's diagnostic detail is limited to that supplied view. Restored commands
/// must be adapted explicitly; serde cannot recover a classifier function.
pub struct ClassifiedCmd<D: CommandSpec> {
    cmd: Cmd<D>,
    classify_error: fn(&D::Error) -> Result<PlainData, CommandContractError>,
}
impl<D: CommandSpec> ClassifiedCmd<D> {
    pub fn cmd(&self) -> &Cmd<D> {
        &self.cmd
    }
    pub fn into_cmd(self) -> Cmd<D> {
        self.cmd
    }
}
impl<D: CommandSpec> Tagged for ClassifiedCmd<D> {
    fn tag(&self) -> &str {
        self.cmd.tag()
    }
}
impl<D: CommandSpec> Serialize for ClassifiedCmd<D>
where
    D::Input: Serialize,
{
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.cmd.serialize(serializer)
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

impl<D: CommandSpec> CommandFamily for ClassifiedCmd<D> {
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
        Ok(self
            .cmd
            .definition()
            .settle_over(self.cmd, completion, at, self.classify_error)?
            .into_iter()
            .collect())
    }
    fn settle_in(
        self,
        completion: Self::Completion,
        edge: &CommandEdge,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(self
            .cmd
            .definition()
            .settle_in_over(self.cmd, completion, edge, self.classify_error)?
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
        failure: PlainData,
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
    pub fn message_text(&self) -> crate::data::JsText {
        let Self::UndeclaredFailure {
            cmd_type,
            failure,
            declared,
        } = self
        else {
            return self.to_string().into();
        };
        let mut units = format!("@demlik/tea: the \"{cmd_type}\" handler failed with ")
            .encode_utf16()
            .collect::<Vec<_>>();
        if let Some(tag) = failure_tag(failure) {
            units.extend("_tag \"".encode_utf16());
            units.extend_from_slice(tag.as_units());
            units.push(34);
        } else {
            units.extend("a value with no _tag".encode_utf16());
        }
        let declared = if declared.is_empty() {
            "none".into()
        } else {
            declared
                .iter()
                .map(|tag| format!("\"{tag}\""))
                .collect::<Vec<_>>()
                .join(", ")
        };
        units.extend(format!(", which its Cmd.define does not declare (declared: {declared}). An undeclared failure goes to the error sink, never to \"{cmd_type}_err\".").encode_utf16());
        crate::data::JsText::from_units(units)
    }
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
            Self::UndeclaredFailure { .. } => {
                f.write_str(&String::from_utf16_lossy(self.message_text().as_units()))
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
        let mut value = indexmap::IndexMap::from([
            ("name".into(), PlainData::String(self.name().into())),
            ("_tag".into(), PlainData::String(self.name().into())),
            ("message".into(), PlainData::String(self.message_text())),
        ]);
        if matches!(self, Self::NullDispatch) {
            value.shift_remove("_tag");
        }
        match self {
            Self::Input { cmd_type, issues } => {
                value.insert("cmdType".into(), PlainData::String(cmd_type.into()));
                value.insert(
                    "issues".into(),
                    plain_data(issues).map_err(serde::ser::Error::custom)?,
                );
            }
            Self::AsyncSchema { location } => {
                value.insert("where".into(), PlainData::String(location.into()));
            }
            Self::UndeclaredFailure {
                cmd_type,
                failure,
                declared,
            } => {
                value.insert("cmdType".into(), PlainData::String(cmd_type.into()));
                value.insert("failure".into(), failure.clone());
                value.insert(
                    "declared".into(),
                    plain_data(declared).map_err(serde::ser::Error::custom)?,
                );
            }
            Self::Outcome { cmd_type, .. } => {
                value.insert("cmdType".into(), PlainData::String(cmd_type.into()));
            }
            Self::CompletionMismatch {
                cmd_type,
                completion_type,
            } => {
                value.insert("cmdType".into(), PlainData::String(cmd_type.into()));
                value.insert(
                    "completionType".into(),
                    PlainData::String(completion_type.into()),
                );
            }
            Self::Serialization { .. } => {}
            Self::NullDispatch => {}
        }
        PlainData::Object(value).serialize(serializer)
    }
}

fn failure_tag(value: &PlainData) -> Option<&crate::data::JsText> {
    let PlainData::Object(record) = value else {
        return None;
    };
    match record.get("_tag") {
        Some(PlainData::String(value)) => Some(value),
        _ => None,
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
        WireDefinition::new(self.cmd_type(), D::ERROR_TAGS, |value| {
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
                    failure: PlainData::from(failure),
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
