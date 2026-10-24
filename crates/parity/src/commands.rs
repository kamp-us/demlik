use std::cell::Cell;

use demlik_tea::Tagged;
use demlik_tea::command::{
    Cmd, CommandContractError, CommandSpec, ContractValue, Issue, Outcome, SchemaError,
    WireDefinition,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Schema {
    Identity,
    Body,
    Trim,
    Nested,
    Async,
}

fn parse_output(schema: Schema, value: Value) -> Result<Value, SchemaError> {
    match schema {
        Schema::Identity => Ok(value),
        Schema::Body => value
            .get("body")
            .and_then(Value::as_str)
            .map(|body| json!({ "body": body }))
            .ok_or_else(|| SchemaError::Issues(vec![Issue::new("body", "Expected body string")])),
        Schema::Trim => value
            .as_str()
            .map(|value| json!(value.trim()))
            .ok_or_else(|| SchemaError::Issues(vec![Issue::new("", "Expected a string")])),
        Schema::Nested => Err(SchemaError::Issues(vec![
            Issue::new("payload.0.body", "Expected nested body string"),
            Issue::new("", "Expected complete result"),
        ])),
        Schema::Async => Err(SchemaError::Async),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    name: String,
    schema: Schema,
    error_tags: Vec<String>,
}
impl Definition {
    fn wire(&self) -> WireDefinition<'static> {
        let schema = self.schema;
        WireDefinition::new(
            self.name.clone(),
            &self
                .error_tags
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            move |value| parse_output(schema, value),
        )
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    Minted,
    Copy,
    Foreign,
    Message,
}
#[derive(Deserialize)]
struct Dispatch {
    source: Source,
    #[serde(default, deserialize_with = "present_message")]
    message: Option<Value>,
}
fn present_message<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
struct ContractInput {
    definitions: Vec<Definition>,
    cmd: Value,
    returned: Option<Value>,
    at: f64,
    #[serde(default)]
    dispatch: Vec<Dispatch>,
}

pub fn contract(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: ContractInput = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let contract = observe!(
        calls,
        demlik_tea::command::CmdContract::new,
        input.definitions.iter().map(Definition::wire)
    );
    let clock_calls = Cell::new(0);
    let mut clock = || {
        clock_calls.set(clock_calls.get() + 1);
        input.at
    };
    let settled = match observe!(
        calls,
        demlik_tea::command::CmdContract::settle,
        &contract,
        &input.cmd,
        input.returned.clone(),
        &mut clock
    ) {
        Ok(settled) => settled,
        Err(error) => return Ok(json!({ "error": error, "clockCalls": clock_calls.get() })),
    };
    let mut dispatch_results = Vec::new();
    for dispatch in input.dispatch {
        let candidate = match dispatch.source {
            Source::Minted => settled
                .clone()
                .ok_or("minted dispatch requires a settled value")?,
            Source::Copy => ContractValue::new(
                settled
                    .as_ref()
                    .ok_or("copy dispatch requires a settled value")?
                    .as_value()
                    .clone(),
            ),
            Source::Foreign => {
                let foreign = observe!(
                    calls,
                    demlik_tea::command::CmdContract::new,
                    input.definitions.iter().map(Definition::wire)
                );
                observe!(
                    calls,
                    demlik_tea::command::CmdContract::settle,
                    &foreign,
                    &input.cmd,
                    input.returned.clone(),
                    &mut clock
                )
                .map_err(|error| error.to_string())?
                .ok_or("foreign dispatch requires a settled value")?
            }
            Source::Message => ContractValue::new(
                dispatch
                    .message
                    .ok_or("message dispatch requires a value")?,
            ),
        };
        dispatch_results.push(
            match observe!(
                calls,
                demlik_tea::command::CmdContract::check_dispatch,
                &contract,
                &input.cmd,
                &candidate
            ) {
                Ok(()) => json!({ "accepted": true }),
                Err(error) => json!({ "accepted": false, "error": error }),
            },
        );
    }
    let value = settled.as_ref().map(|value| value.as_value().clone());
    let follow_ups = observe!(calls, demlik_tea::command::follow_ups, value.clone());
    Ok(
        json!({ "settled": value, "followUps": follow_ups, "clockCalls": clock_calls.get(), "dispatchResults": dispatch_results }),
    )
}

#[derive(Serialize, Deserialize)]
#[serde(transparent)]
struct WireFailure(Value);
impl Tagged for WireFailure {
    fn tag(&self) -> &str {
        self.0.get("_tag").and_then(Value::as_str).unwrap_or("")
    }
}
struct Fetch;
impl CommandSpec for Fetch {
    type Input = Value;
    type RawOutput = Value;
    type Output = Value;
    type Error = WireFailure;
    const NAME: &'static str = "fetch";
    const ERROR_TAGS: &'static [&'static str] = &["timeout", "not_found"];
    fn parse_input(value: Value) -> Result<Value, SchemaError> {
        value
            .get("url")
            .and_then(Value::as_str)
            .map(|url| json!({ "url": url.trim() }))
            .ok_or_else(|| SchemaError::Issues(vec![Issue::new("url", "Expected url string")]))
    }
    fn parse_output(value: Value) -> Result<Value, SchemaError> {
        parse_output(Schema::Body, value)
    }
}
#[derive(Deserialize)]
struct BuilderInput {
    input: Value,
    value: Value,
    error: Value,
    at: Option<f64>,
}
pub fn builders(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: BuilderInput = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let def = observe!(calls, demlik_tea::command::CmdDef::<Fetch>::new);
    let cmd = observe!(
        calls,
        demlik_tea::command::CmdDef::<Fetch>::build,
        &def,
        input.input.clone()
    )
    .map_err(|error| error.to_string())?;
    let cmd_value = serde_json::to_value(&cmd).map_err(|error| error.to_string())?;
    let round_trip: Cmd<Fetch> =
        serde_json::from_value(cmd_value.clone()).map_err(|error| error.to_string())?;
    let ok = observe!(
        calls,
        demlik_tea::command::CmdDef::<Fetch>::ok,
        &def,
        cmd,
        input.value,
        input.at
    );
    let err = observe!(
        calls,
        demlik_tea::command::CmdDef::<Fetch>::err,
        &def,
        round_trip,
        WireFailure(input.error),
        input.at
    );
    Ok(
        json!({ "cmd": cmd_value, "roundTrip": err.cmd(), "ok": ok, "err": err, "declaration": { "cmdType": def.cmd_type(), "okType": def.ok_type(), "errType": def.err_type(), "errorTags": def.error_tags() } }),
    )
}

pub fn parse_input(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let def = observe!(calls, demlik_tea::command::CmdDef::<Fetch>::new);
    match observe!(
        calls,
        demlik_tea::command::CmdDef::<Fetch>::parse_input,
        &def,
        input["value"].clone()
    ) {
        Ok(cmd) => Ok(json!({ "cmd": cmd })),
        Err(CommandContractError::Input { issues, .. }) => Ok(json!({ "issues": issues })),
        Err(error) => Err(error.to_string()),
    }
}

pub fn helpers(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let groups: Vec<Vec<Value>> =
        serde_json::from_value(input["groups"].clone()).map_err(|error| error.to_string())?;
    let condition = input["condition"]
        .as_bool()
        .ok_or("condition must be boolean")?;
    let mut build_calls = 0;
    let none: Vec<Value> = observe!(calls, demlik_tea::command::none);
    let batch = observe!(calls, demlik_tea::command::batch, groups);
    let when = observe!(
        calls,
        demlik_tea::command::when,
        condition,
        json!({ "type": "conditional" })
    );
    let when_defined = observe!(
        calls,
        demlik_tea::command::when_defined,
        input.get("value").cloned(),
        |value| {
            build_calls += 1;
            json!({ "type": "picked", "value": value })
        }
    );
    let ok: Outcome<Value, Value> =
        observe!(calls, demlik_tea::command::Outcome::ok, input["ok"].clone());
    let err: Outcome<Value, Value> = observe!(
        calls,
        demlik_tea::command::Outcome::err,
        input["error"].clone()
    );
    Ok(
        json!({ "none": none, "batch": batch, "when": when, "whenDefined": when_defined, "buildCalls": build_calls, "ok": ok, "err": err }),
    )
}
