use demlik_tea::{
    PlainData,
    command::{CommandEdge, Outcome},
    data::{JsText, JsonData, decode_json, plain_data, stringify_json},
    js_record::{JsAccessError, RecordCodec},
    resilience::{
        deadline::{DeadlineExceeded, deadline_exceeded},
        resilient_call::{
            self, CallFailure, CallValue, Config, ResilientCall, RunError, SettleInput, State,
        },
    },
    retry_backoff::{
        BackoffCurve, Budget, CountBound, DurationBound, Jitter, RetryPolicy, Unbounded,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    cell::Cell,
    io::{self, BufRead},
    rc::Rc,
};

macro_rules! observe {($calls:expr,$call:path $(,$arg:expr)* $(,)?)=>{{let result=$call($($arg),*);$calls.push(stringify!($call));result}};}
enum Bounds {
    Count(CountBound),
    Duration(DurationBound),
    Unbounded(Unbounded),
}
impl Budget for Bounds {
    fn max_attempts(&self) -> Option<f64> {
        match self {
            Self::Count(value) => value.max_attempts(),
            Self::Duration(value) => value.max_attempts(),
            Self::Unbounded(value) => value.max_attempts(),
        }
    }
    fn max_elapsed_ms(&self) -> Option<f64> {
        match self {
            Self::Count(value) => value.max_elapsed_ms(),
            Self::Duration(value) => value.max_elapsed_ms(),
            Self::Unbounded(value) => value.max_elapsed_ms(),
        }
    }
}
type Knob<'a> = ResilientCall<'a, PlainData, PlainData, PlainData, Bounds>;
type Model = State<PlainData, PlainData, PlainData>;
#[derive(Deserialize)]
struct Request {
    id: String,
    input: Box<RawValue>,
}
fn obj<const N: usize>(fields: [(&str, PlainData); N]) -> PlainData {
    PlainData::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
fn field<'a>(value: &'a PlainData, key: &str) -> Option<&'a PlainData> {
    match value {
        PlainData::Object(fields) => fields
            .get(key)
            .filter(|value| !matches!(value, PlainData::Undefined)),
        _ => None,
    }
}
fn text(value: &PlainData) -> Result<JsText, String> {
    match value {
        PlainData::String(value) => Ok(value.clone()),
        _ => Err("expected text".into()),
    }
}
fn number(value: &PlainData) -> Result<f64, String> {
    match value {
        PlainData::Number(value) => Ok(*value),
        _ => Err("expected numeric data".into()),
    }
}
fn num(value: &PlainData, key: &str, default: f64) -> Result<f64, String> {
    field(value, key)
        .map(number)
        .transpose()
        .map(|value| value.unwrap_or(default))
}
fn required_num(value: &PlainData, key: &str) -> Result<f64, String> {
    number(field(value, key).ok_or_else(|| format!("missing numeric field {key}"))?)
}
fn word(value: &PlainData, key: &str, default: &str) -> Result<String, String> {
    field(value, key).map(text).transpose()?.map_or_else(
        || Ok(default.into()),
        |value| {
            value
                .as_utf8()
                .map(str::to_owned)
                .ok_or("the native tag interface requires UTF-8".into())
        },
    )
}
fn value(value: Option<&PlainData>) -> CallValue<PlainData> {
    match value {
        None | Some(PlainData::Undefined) => CallValue::Undefined,
        Some(value) => CallValue::value(value.clone()),
    }
}
fn failure(value: Option<&PlainData>) -> CallFailure<PlainData> {
    match value {
        None | Some(PlainData::Undefined) => CallFailure::Undefined,
        Some(value) => CallFailure::external(value.clone()),
    }
}
fn data(value: &impl Serialize) -> Result<PlainData, String> {
    plain_data(value).map_err(|error| error.to_string())
}
fn revive(value: PlainData) -> Result<PlainData, String> {
    Ok(match value {
        PlainData::Object(fields) if fields.len() == 1 && fields.contains_key("$number") => {
            PlainData::Number(
                match field(&PlainData::Object(fields), "$number").and_then(|value| {
                    if let PlainData::String(value) = value {
                        value.as_utf8()
                    } else {
                        None
                    }
                }) {
                    Some("NaN") => f64::NAN,
                    Some("Infinity") => f64::INFINITY,
                    Some("-Infinity") => f64::NEG_INFINITY,
                    _ => return Err("unknown numeric marker".into()),
                },
            )
        }
        PlainData::Object(fields)
            if fields.len() == 1
                && matches!(fields.get("$undefined"), Some(PlainData::Bool(true))) =>
        {
            PlainData::Undefined
        }
        PlainData::Object(fields) => PlainData::Object(
            fields
                .into_iter()
                .map(|(key, value)| Ok((key, revive(value)?)))
                .collect::<Result<_, String>>()?,
        ),
        PlainData::Array(values) => {
            PlainData::Array(values.into_iter().map(revive).collect::<Result<_, _>>()?)
        }
        value => value,
    })
}
fn config(value: &PlainData) -> Result<Config<Bounds>, String> {
    if !matches!(value, PlainData::Object(_)) {
        return Err("config needs a record".into());
    }
    let mut config = Config {
        name: word(value, "name", "resilient")?,
        ..Config::default()
    };
    if let Some(retry) = field(value, "retry") {
        let budget = if let Some(max_elapsed_ms) = field(retry, "maxElapsedMs") {
            Bounds::Duration(DurationBound {
                max_elapsed_ms: number(max_elapsed_ms)?,
                max_attempts: field(retry, "maxAttempts").map(number).transpose()?,
            })
        } else if let Some(max_attempts) = field(retry, "maxAttempts") {
            Bounds::Count(CountBound {
                max_attempts: number(max_attempts)?,
            })
        } else if matches!(field(retry, "unbounded"), Some(PlainData::Bool(true))) {
            Bounds::Unbounded(Unbounded)
        } else {
            return Err("retry needs a declared bound".into());
        };
        config.retry = Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: required_num(retry, "baseMs")?,
                factor: required_num(retry, "factor")?,
                cap_ms: required_num(retry, "capMs")?,
                jitter: match word(retry, "jitter", "")?.as_str() {
                    "none" => Jitter::None,
                    "full" => Jitter::Full,
                    "equal" => Jitter::Equal,
                    _ => return Err("unknown jitter".into()),
                },
            },
            budget,
        });
    }
    if let Some(value) = field(value, "circuit") {
        config.circuit = Some(resilient_call::CircuitConfig {
            threshold: required_num(value, "threshold")?,
            cooldown_ms: required_num(value, "cooldownMs")?,
            half_open_max_probes: num(value, "halfOpenMaxProbes", 1.0)?,
        });
    }
    if let Some(value) = field(value, "rateLimit") {
        config.rate_limit = Some(resilient_call::RateLimitConfig {
            capacity: required_num(value, "capacity")?,
            refill_per_sec: required_num(value, "refillPerSec")?,
        });
    }
    if let Some(value) = field(value, "cache") {
        config.cache = Some(resilient_call::CacheConfig {
            ttl_ms: required_num(value, "ttlMs")?,
        });
    }
    if let Some(value) = field(value, "deadline") {
        config.deadline = Some(resilient_call::DeadlineConfig {
            ms: required_num(value, "ms")?,
        });
    }
    Ok(config)
}
fn error(error: resilient_call::ResilientError) -> Result<PlainData, String> {
    Ok(match error {
        resilient_call::ResilientError::Record(error) => data(&error)?,
        resilient_call::ResilientError::Projection(error) => obj([
            ("name", PlainData::String(error.cause.name.into())),
            ("message", PlainData::String(error.cause.message.into())),
            ("value", error.value),
        ]),
        resilient_call::ResilientError::MissingStamp { command } => obj([
            ("name", PlainData::String("MissingStamp".into())),
            ("message", PlainData::String(command.into())),
        ]),
    })
}
fn execute(input: PlainData, calls: &mut Vec<&'static str>) -> Result<PlainData, String> {
    let input = revive(input)?;
    if !matches!(input, PlainData::Object(_)) {
        return Err("input needs a record".into());
    }
    let config = config(field(&input, "config").unwrap_or(&obj([])))?;
    let samples = match field(&input, "rng") {
        Some(PlainData::Array(values)) => {
            values.iter().map(number).collect::<Result<Vec<_>, _>>()?
        }
        None => vec![0.5],
        _ => return Err("RNG needs numeric samples".into()),
    };
    let samples = Rc::new(samples);
    let rng_calls = Rc::new(Cell::new(0usize));
    let rng_count = rng_calls.clone();
    let rng_samples = samples.clone();
    let knob: Knob<'_> = observe!(
        calls,
        demlik_tea::resilience::resilient_call::ResilientCall::new,
        config
    );
    let knob = observe!(
        calls,
        demlik_tea::resilience::resilient_call::ResilientCall::with_rng,
        knob,
        move || {
            let index = rng_count.get();
            rng_count.set(index + 1);
            rng_samples
                .get(index)
                .or_else(|| rng_samples.last())
                .copied()
                .unwrap_or(0.5)
        }
    )
    .with_cache_codec(RecordCodec::new(
        |value: &CallValue<PlainData>| {
            data(value).map_err(|message| JsAccessError {
                name: "TypeError",
                message,
            })
        },
        |raw| Ok(value(Some(raw))),
    ));
    let clock = Rc::new(Cell::new(0.0));
    let edge_clock = clock.clone();
    let edge = CommandEdge::new(move || edge_clock.get());
    let mut state = observe!(
        calls,
        demlik_tea::resilience::resilient_call::ResilientCall::init,
        &knob
    );
    let Some(PlainData::Array(actions)) = field(&input, "actions") else {
        return Err("actions need an array".into());
    };
    let mut history = Vec::new();
    for action in actions {
        let before = state.clone();
        let op = word(action, "op", "")?;
        let key = field(action, "key")
            .map(text)
            .transpose()?
            .unwrap_or_else(|| "key".into());
        let at = num(action, "at", 0.0)?;
        clock.set(at);
        let mut commands = Vec::new();
        let mut outcome = None;
        let mut observed_error = None;
        let mut message = None;
        match op.as_str() {
            "attempt" => match observe!(
                calls,
                demlik_tea::resilience::resilient_call::ResilientCall::attempt,
                &knob,
                &state,
                key,
                value(field(action, "input")),
                at
            ) {
                Ok(step) => {
                    state = step.state;
                    commands = step.commands;
                }
                Err(cause) => observed_error = Some(error(cause)?),
            },
            "ok" | "err" => {
                let msg = if op == "ok" {
                    SettleInput::ok(key, value(field(action, "value")), at)
                } else {
                    SettleInput::err(key, failure(field(action, "error")), at)
                };
                match observe!(
                    calls,
                    demlik_tea::resilience::resilient_call::ResilientCall::settle,
                    &knob,
                    &state,
                    msg
                ) {
                    Ok(result) => {
                        outcome = Some(data(&result.outcome)?);
                        state = result.call;
                        commands = result.commands;
                    }
                    Err(cause) => observed_error = Some(error(cause)?),
                }
            }
            "settleFailed" => {
                let step = observe!(
                    calls,
                    demlik_tea::resilience::resilient_call::ResilientCall::settle_failed,
                    &knob,
                    &state,
                    key,
                    failure(field(action, "error")),
                    at
                );
                state = step.state;
                commands = step.commands;
            }
            "resume" => {
                state = observe!(
                    calls,
                    demlik_tea::resilience::resilient_call::ResilientCall::resume,
                    &knob,
                    &state,
                    at
                )
            }
            "timer" | "fireNext" => {
                let timer: Option<DeadlineExceeded> = if op == "fireNext" {
                    observe!(
                        calls,
                        demlik_tea::resilience::resilient_call::ResilientCall::timer,
                        &knob,
                        &state
                    )
                    .map(|timer| timer.msg)
                } else {
                    Some(deadline_exceeded(
                        field(action, "id")
                            .map(text)
                            .transpose()?
                            .ok_or("timer requires id")?,
                        at,
                        None,
                    ))
                };
                if let Some(timer) = timer {
                    match observe!(
                        calls,
                        demlik_tea::resilience::resilient_call::ResilientCall::on_timer,
                        &knob,
                        &state,
                        &timer
                    ) {
                        Ok(step) => {
                            state = step.state;
                            commands = step.commands;
                        }
                        Err(cause) => observed_error = Some(error(cause)?),
                    }
                }
            }
            "engineOk" | "engineErr" => {
                let command = observe!(
                    calls,
                    demlik_tea::command::CmdDef::from_record,
                    &knob.run,
                    resilient_call::RunInput {
                        key,
                        input: value(field(action, "input"))
                    }
                );
                let completion = if op == "engineOk" {
                    Outcome::ok(value(field(action, "value")))
                } else {
                    let details = field(action, "error")
                        .ok_or("engine error requires a declared record")?
                        .clone();
                    let tag = word(&details, "_tag", "")?;
                    let error = match tag.as_str() {
                        "port_rejected" => RunError::port_rejected(details),
                        "deadline_exceeded" => RunError::deadline_exceeded(details),
                        _ => return Err("engine error must use a declared failure tag".into()),
                    };
                    Outcome::err(error)
                };
                match observe!(
                    calls,
                    demlik_tea::command::CommandFamily::settle_in,
                    command,
                    Some(completion),
                    &edge
                ) {
                    Ok(mut messages) => {
                        let settled = messages.pop().ok_or("engine outcome missing")?;
                        message = Some(data(&settled)?);
                        match observe!(
                            calls,
                            demlik_tea::resilience::resilient_call::ResilientCall::settle_message,
                            &knob,
                            &state,
                            settled
                        ) {
                            Ok(result) => {
                                outcome = Some(data(&result.outcome)?);
                                state = result.call;
                                commands = result.commands;
                            }
                            Err(cause) => observed_error = Some(error(cause)?),
                        }
                    }
                    Err(cause) => observed_error = Some(data(&cause)?),
                }
            }
            "runCtor" => {
                message = Some(data(&observe!(
                    calls,
                    demlik_tea::command::CmdDef::from_record,
                    &knob.run,
                    resilient_call::RunInput {
                        key,
                        input: value(field(action, "input"))
                    }
                ))?)
            }
            "runDef" => {
                let definition = observe!(
                    calls,
                    demlik_tea::resilience::resilient_call::run_cmd_def::<
                        PlainData,
                        PlainData,
                        PlainData,
                    >,
                    knob.name()
                );
                message = Some(data(&definition.from_record(resilient_call::RunInput {
                    key,
                    input: value(field(action, "input")),
                }))?);
            }
            "lift" => {
                #[derive(Serialize)]
                struct Host {
                    marker: &'static str,
                    resilience: Model,
                }
                let lifted = observe!(
                    calls,
                    demlik_tea::resilience::resilient_call::lift_resilience,
                    Host {
                        marker: "kept",
                        resilience: state.clone()
                    },
                    demlik_tea::Step::<
                        _,
                        resilient_call::RunCommand<PlainData, PlainData, PlainData>,
                    >::new(state.clone(), vec![]),
                    |host: Host, resilience| Host { resilience, ..host }
                );
                message = Some(data(&lifted.state)?);
                state = lifted.state.resilience;
                commands = lifted.commands;
            }
            "roundtrip" => {
                let text = stringify_json(&data(&state)?).ok_or("model JSON missing")?;
                match serde_json::from_str::<Model>(&text) {
                    Ok(restored) => state = restored,
                    Err(cause) => {
                        observed_error = Some(obj([
                            ("name", PlainData::String("NativeDecodeError".into())),
                            ("message", PlainData::String(cause.to_string().into())),
                        ]))
                    }
                }
            }
            "inspect" => {}
            _ => return Err(format!("unsupported operation {op}")),
        }
        let deadlines = observe!(
            calls,
            demlik_tea::resilience::resilient_call::ResilientCall::deadlines,
            &knob,
            &state
        );
        let timer = observe!(
            calls,
            demlik_tea::resilience::resilient_call::ResilientCall::timer,
            &knob,
            &state
        );
        let mut row = obj([
            ("state", data(&state)?),
            ("cmds", data(&commands)?),
            ("same", PlainData::Bool(state.same(&before))),
            ("deadlines", data(&deadlines)?),
            ("timer", data(&timer)?),
        ]);
        let PlainData::Object(fields) = &mut row else {
            unreachable!()
        };
        if let Some(value) = outcome {
            fields.insert("outcome".into(), value);
        }
        if let Some(value) = observed_error {
            fields.insert("error".into(), value);
        }
        if let Some(value) = message {
            fields.insert("message".into(), value);
        }
        history.push(row);
    }
    Ok(obj([
        ("name", PlainData::String(knob.name().into())),
        (
            "run",
            obj([
                ("cmdType", PlainData::String(knob.run.cmd_type().into())),
                ("okType", PlainData::String(knob.run.ok_type().into())),
                ("errType", PlainData::String(knob.run.err_type().into())),
                ("errorTags", data(&knob.run.error_tags())?),
            ]),
        ),
        ("history", PlainData::Array(history)),
        ("rngCalls", PlainData::Number(rng_calls.get() as f64)),
    ]))
}
fn main() {
    for line in io::stdin().lock().lines() {
        let mut calls = Vec::new();
        let response = match line {
            Ok(line) => match serde_json::from_str::<Request>(&line) {
                Ok(request) => match decode_json(request.input.get())
                    .map_err(|error| error.to_string())
                    .and_then(|input| execute(input, &mut calls))
                {
                    Ok(output) => obj([
                        ("id", PlainData::String(request.id.into())),
                        ("ok", PlainData::Bool(true)),
                        ("output", output),
                        ("observedCalls", data(&calls).unwrap()),
                    ]),
                    Err(error) => obj([
                        ("id", PlainData::String(request.id.into())),
                        ("ok", PlainData::Bool(false)),
                        ("error", PlainData::String(error.into())),
                    ]),
                },
                Err(error) => obj([
                    ("ok", PlainData::Bool(false)),
                    ("error", PlainData::String(error.to_string().into())),
                ]),
            },
            Err(error) => obj([
                ("ok", PlainData::Bool(false)),
                ("error", PlainData::String(error.to_string().into())),
            ]),
        };
        println!("{}", serde_json::to_string(&JsonData(&response)).unwrap());
    }
}
