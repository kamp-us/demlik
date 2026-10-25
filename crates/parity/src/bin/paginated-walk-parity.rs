use demlik_tea::{
    PlainData, Step, Tagged,
    command::CmdDef,
    data::{JsText, decode_json, plain_data},
    js_record::{JsRecord, RecordValue},
    paginate::{
        paginated_walk::{self, Config, PaginatedWalk, State, WalkError},
        paginator::{PaginatorCursor, PaginatorPhase},
    },
    resilience::{
        deadline::{Deadline, DeadlineExceeded, deadline_exceeded},
        resilient_call::{
            self as call, CallFailure, CallPhase, CallValue, ResilientError, RetryProgress,
            RunCommand,
        },
    },
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead},
    rc::Rc,
};

macro_rules! observe {($calls:expr,$call:path $(,$arg:expr)* $(,)?)=>{{let result=$call($($arg),*);$calls.push(stringify!($call));result}};}
type Model = State<PlainData, PlainData, PlainData>;
type Knob<'a> = PaginatedWalk<'a, PlainData, PlainData, PlainData, PlainData, Command>;
#[derive(Deserialize)]
struct Request {
    id: String,
    input: Box<RawValue>,
}
enum Command {
    Fetch(RunCommand<PlainData, PlainData, PlainData>),
    Process {
        page: CallValue<PlainData>,
        ordinal: usize,
    },
}
impl From<RunCommand<PlainData, PlainData, PlainData>> for Command {
    fn from(command: RunCommand<PlainData, PlainData, PlainData>) -> Self {
        Self::Fetch(command)
    }
}
impl Tagged for Command {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(command) => command.tag(),
            Self::Process { .. } => "process_page",
        }
    }
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
fn required<'a>(value: &'a PlainData, key: &str) -> Result<&'a PlainData, String> {
    field(value, key).ok_or_else(|| format!("missing field {key}"))
}
fn text(value: &PlainData) -> Result<JsText, String> {
    match value {
        PlainData::String(value) => Ok(value.clone()),
        _ => Err("expected text".into()),
    }
}
fn numeric(value: &PlainData) -> Result<f64, String> {
    match value {
        PlainData::Number(value) => Ok(*value),
        _ => Err("expected numeric data".into()),
    }
}
fn num(value: &PlainData, key: &str, default: f64) -> Result<f64, String> {
    field(value, key)
        .map(numeric)
        .transpose()
        .map(|value| value.unwrap_or(default))
}
fn word(value: &PlainData, key: &str, default: &str) -> Result<String, String> {
    field(value, key).map(text).transpose()?.map_or_else(
        || Ok(default.into()),
        |text| {
            text.as_utf8()
                .map(str::to_owned)
                .ok_or("protocol keywords need UTF-8".into())
        },
    )
}
fn val(value: Option<&PlainData>) -> CallValue<PlainData> {
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
fn data(value: &impl Serialize) -> PlainData {
    plain_data(value).expect("observable typed data")
}
fn value_data(value: &CallValue<PlainData>) -> PlainData {
    match value {
        CallValue::Shared(value) => value.as_ref().clone(),
        _ => PlainData::Undefined,
    }
}
fn failure_data(error: &CallFailure<PlainData>) -> PlainData {
    match error {
        CallFailure::External(value) => value.as_ref().clone(),
        _ => data(error),
    }
}
fn revive(value: PlainData) -> Result<PlainData, String> {
    Ok(match value {
        PlainData::Object(mut fields) if fields.len() == 1 && fields.contains_key("$number") => {
            let value = text(&fields.swap_remove("$number").unwrap())?;
            PlainData::Number(match value.as_utf8() {
                Some("NaN") => f64::NAN,
                Some("Infinity") => f64::INFINITY,
                Some("-Infinity") => f64::NEG_INFINITY,
                Some("-0") => -0.0,
                _ => return Err("unknown numeric marker".into()),
            })
        }
        PlainData::Object(fields)
            if fields.len() == 1
                && matches!(fields.get("$undefined"), Some(PlainData::Bool(true))) =>
        {
            PlainData::Undefined
        }
        PlainData::Object(mut fields) if fields.len() == 1 && fields.contains_key("$utf16") => {
            let PlainData::Array(units) = fields.swap_remove("$utf16").unwrap() else {
                return Err("UTF-16 units need an array".into());
            };
            PlainData::String(JsText::from_units(
                units
                    .iter()
                    .map(|unit| {
                        let unit = numeric(unit)?;
                        if unit.fract() != 0.0 || !(0.0..=65535.0).contains(&unit) {
                            return Err("invalid UTF-16 unit".into());
                        }
                        Ok(unit as u16)
                    })
                    .collect::<Result<Vec<_>, String>>()?,
            ))
        }
        PlainData::Object(mut fields) if fields.len() == 1 && fields.contains_key("$object") => {
            let PlainData::Array(entries) = fields.swap_remove("$object").unwrap() else {
                return Err("object entries need an array".into());
            };
            PlainData::Object(
                entries
                    .into_iter()
                    .map(|entry| {
                        let PlainData::Array(pair) = entry else {
                            return Err("object entry needs a pair".into());
                        };
                        if pair.len() != 2 {
                            return Err("object entry needs a pair".into());
                        }
                        Ok((text(&revive(pair[0].clone())?)?, revive(pair[1].clone())?))
                    })
                    .collect::<Result<_, String>>()?,
            )
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
fn normalized(value: &PlainData) -> Value {
    match value {
        PlainData::Null => Value::Null,
        PlainData::Undefined => json!({"$undefined":true}),
        PlainData::Bool(value) => json!(value),
        PlainData::Number(value) if value.is_nan() => json!({"$number":"NaN"}),
        PlainData::Number(value) if *value == f64::INFINITY => json!({"$number":"Infinity"}),
        PlainData::Number(value) if *value == f64::NEG_INFINITY => json!({"$number":"-Infinity"}),
        PlainData::Number(value) if *value == 0.0 && value.is_sign_negative() => {
            json!({"$number":"-0"})
        }
        PlainData::Number(value) => json!(value),
        PlainData::String(value) => value
            .as_utf8()
            .map_or_else(|| json!({"$utf16":value.as_units()}), |value| json!(value)),
        PlainData::Array(values) => json!(values.iter().map(normalized).collect::<Vec<_>>()),
        PlainData::Object(fields) if fields.keys().all(|key| key.as_utf8().is_some()) => {
            Value::Object(
                fields
                    .iter()
                    .map(|(key, value)| (key.as_utf8().unwrap().to_owned(), normalized(value)))
                    .collect(),
            )
        }
        PlainData::Object(fields) => {
            json!({"$object":fields.iter().map(|(key, value)|json!([normalized(&PlainData::String(key.clone())),normalized(value)])).collect::<Vec<_>>()})
        }
    }
}
fn record<E>(value: &JsRecord<E>, entry: impl Fn(&E) -> PlainData) -> PlainData {
    PlainData::Object(
        value
            .own_entries()
            .filter_map(|(key, value)| {
                let value = match value {
                    RecordValue::Entry(value) => entry(value),
                    RecordValue::Data(value) => value.clone(),
                    RecordValue::ObjectPrototype => obj([]),
                    RecordValue::Builtin(_) => return None,
                };
                Some((key.clone(), value))
            })
            .collect(),
    )
}
fn call_data(value: &CallPhase<PlainData, PlainData, PlainData>) -> PlainData {
    let mut fields = match value {
        CallPhase::Idle => obj([("phase", data(&"idle"))]),
        CallPhase::CircuitOpen => obj([("phase", data(&"circuit_open"))]),
        CallPhase::Running { input, budget } => {
            let mut result = obj([("phase", data(&"running")), ("budget", data(budget))]);
            if !matches!(input, CallValue::Missing) {
                if let PlainData::Object(fields) = &mut result {
                    fields.insert("input".into(), value_data(input));
                }
            }
            result
        }
        CallPhase::WaitingRetry {
            input,
            retry_at_ms,
            budget,
        } => {
            let mut result = obj([
                ("phase", data(&"waiting_retry")),
                ("retryAtMs", data(retry_at_ms)),
                ("budget", data(budget)),
            ]);
            if !matches!(input, CallValue::Missing) {
                if let PlainData::Object(fields) = &mut result {
                    fields.insert("input".into(), value_data(input));
                }
            }
            result
        }
        CallPhase::Succeeded { result } => {
            if matches!(result, CallValue::Missing) {
                obj([("phase", data(&"succeeded"))])
            } else {
                obj([
                    ("phase", data(&"succeeded")),
                    ("result", value_data(result)),
                ])
            }
        }
        CallPhase::Failed { error } => {
            if matches!(error.as_ref(), CallFailure::Missing) {
                obj([("phase", data(&"failed"))])
            } else {
                obj([("phase", data(&"failed")), ("error", failure_data(error))])
            }
        }
    };
    // Observation order is irrelevant; JSON reload uses the public serializer.
    if let PlainData::Object(fields) = &mut fields {
        fields.sort_keys();
    }
    fields
}
fn retry_data(value: &RetryProgress<PlainData>) -> PlainData {
    let mut result = obj([("attempt", data(&value.attempt))]);
    let PlainData::Object(fields) = &mut result else {
        unreachable!()
    };
    if let Some(value) = &value.last_error {
        fields.insert("lastError".into(), failure_data(value));
    }
    if let Some(value) = &value.first_failure_at_ms {
        fields.insert("firstFailureAtMs".into(), data(value));
    }
    result
}
fn state_data(state: &Model) -> PlainData {
    let walk = state.walk().snapshot();
    let mut page = obj([
        ("phase", data(&state.walk().phase_name())),
        ("seen", data(&walk.seen)),
        ("pages", data(&walk.pages)),
    ]);
    if let PaginatorPhase::Fetching { cursor } | PaginatorPhase::Paused { cursor } = &walk.phase {
        let value = match cursor {
            PaginatorCursor::Shared(value) => Some(value_data(value)),
            PaginatorCursor::Undefined => Some(PlainData::Undefined),
            PaginatorCursor::Missing => None,
        };
        if let (PlainData::Object(fields), Some(value)) = (&mut page, value) {
            fields.insert("cursor".into(), value);
        }
    }
    let slice = state.resilience().snapshot();
    obj([
        ("walk", page),
        (
            "resilience",
            obj([
                ("circuit", data(&slice.circuit)),
                ("bucket", data(&slice.bucket)),
                ("retry", record(&slice.retry, retry_data)),
                (
                    "cache",
                    obj([("entries", record(&slice.cache.entries, data))]),
                ),
                ("calls", record(&slice.calls, |value| call_data(value))),
                ("clockMs", data(&slice.clock_ms)),
            ]),
        ),
    ])
}
fn deadlines_data(deadlines: &[Deadline]) -> PlainData {
    PlainData::Array(
        deadlines
            .iter()
            .map(|deadline| {
                obj([
                    ("type", data(&"deadline")),
                    ("id", data(&deadline.id)),
                    ("atMs", data(&deadline.at_ms)),
                    (
                        "name",
                        deadline.name.as_ref().map_or(PlainData::Undefined, data),
                    ),
                ])
            })
            .collect(),
    )
}
fn command_data(command: &Command) -> PlainData {
    match command {
        Command::Fetch(command) => obj([
            ("type", data(&command.tag())),
            ("key", data(&command.input().key)),
            ("input", value_data(&command.input().input)),
        ]),
        Command::Process { page, ordinal } => obj([
            ("type", data(&"process_page")),
            ("page", value_data(page)),
            ("ordinal", data(ordinal)),
        ]),
    }
}
fn error_data(error: WalkError<PlainData>) -> PlainData {
    match error {
        WalkError::Callback { phase: _, cause } => cause,
        WalkError::Resilience(ResilientError::Record(error)) => obj([
            ("name", data(&error.name)),
            ("message", data(&error.message)),
        ]),
        WalkError::Resilience(ResilientError::Projection(error)) => obj([
            ("name", data(&error.cause.name)),
            ("message", data(&error.cause.message)),
            ("value", error.value),
        ]),
        WalkError::Resilience(ResilientError::MissingStamp { command }) => {
            obj([("name", data(&"MissingStamp")), ("message", data(&command))])
        }
    }
}
fn callback_error(phase: &str, cause: &PlainData) -> PlainData {
    obj([
        ("kind", data(&"callback_failed")),
        ("phase", data(&phase)),
        ("cause", cause.clone()),
    ])
}
fn page_field<'a>(
    page: &'a CallValue<PlainData>,
    key: &str,
) -> Result<Option<&'a PlainData>, PlainData> {
    match page {
        CallValue::Shared(page) if matches!(page.as_ref(), PlainData::Object(_)) => {
            Ok(field(page, key))
        }
        _ => Err(obj([
            ("kind", data(&"invalid_page")),
            ("field", data(&key)),
        ])),
    }
}
fn config<'a>(
    input: &PlainData,
    callbacks: &PlainData,
    trace: &'a RefCell<Vec<String>>,
) -> Result<Config<'a, PlainData, PlainData, Command, PlainData>, String> {
    if !matches!(input, PlainData::Object(_)) || !matches!(callbacks, PlainData::Object(_)) {
        return Err("config and callbacks need records".into());
    }
    let next = word(callbacks, "next", "field")?;
    if !["field", "end", "undefined"].contains(&next.as_str()) {
        return Err("unknown next callback".into());
    }
    let size = word(callbacks, "pageSize", "default")?;
    if !["default", "field", "literal"].contains(&size.as_str()) {
        return Err("unknown size callback".into());
    }
    let size_value = num(callbacks, "size", 1.0)?;
    let emit = word(callbacks, "onPage", "emit")?;
    if !["emit", "none"].contains(&emit.as_str()) {
        return Err("unknown onPage callback".into());
    }
    let emits = num(callbacks, "emits", 1.0)?;
    if emits.fract() != 0.0 || !(0.0..=4.0).contains(&emits) {
        return Err("emits needs an integer from 0 to 4".into());
    }
    let throw = word(callbacks, "throw", "")?;
    if !["", "size", "next", "onPage"].contains(&throw.as_str()) {
        return Err("unknown callback failure".into());
    }
    let cause = field(callbacks, "cause")
        .cloned()
        .unwrap_or_else(|| obj([("code", data(&"sentinel"))]));
    let next_throw = throw == "next";
    let next_cause = cause.clone();
    let mut config = Config::new(
        val(field(input, "firstPage")),
        Rc::new(move |page| {
            trace.borrow_mut().push("next".into());
            if next_throw {
                return Err(callback_error("next", &next_cause));
            }
            match next.as_str() {
                "end" | "undefined" => Ok(None),
                _ => match page_field(page, "next")? {
                    None | Some(PlainData::Null | PlainData::Undefined) => Ok(None),
                    Some(value) => Ok(Some(Rc::new(value.clone()))),
                },
            }
        }),
        Rc::new(move |page| {
            trace.borrow_mut().push("onPage".into());
            if throw == "onPage" {
                return Err(callback_error("onPage", &cause));
            }
            Ok(if emit == "none" {
                vec![]
            } else {
                (0..emits as usize)
                    .map(|ordinal| Command::Process {
                        page: page.clone(),
                        ordinal,
                    })
                    .collect()
            })
        }),
    );
    if size != "default" {
        let size_throw = word(callbacks, "throw", "")? == "size";
        let size_cause = field(callbacks, "cause")
            .cloned()
            .unwrap_or_else(|| obj([("code", data(&"sentinel"))]));
        config.page_size = Some(Rc::new(move |page| {
            trace.borrow_mut().push("size".into());
            if size_throw {
                return Err(callback_error("size", &size_cause));
            }
            if size == "literal" {
                return Ok(size_value);
            }
            match page_field(page, "size")? {
                None => Ok(1.0),
                Some(PlainData::Number(value)) => Ok(*value),
                _ => Err(obj([
                    ("kind", data(&"invalid_page")),
                    ("field", data(&"size")),
                ])),
            }
        }));
    }
    config.high_water_mark = num(input, "highWaterMark", 0.0)?;
    if let Some(retry) = field(input, "retry") {
        config.retry = Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: numeric(required(retry, "baseMs")?)?,
                factor: numeric(required(retry, "factor")?)?,
                cap_ms: numeric(required(retry, "capMs")?)?,
                jitter: match word(retry, "jitter", "")?.as_str() {
                    "none" => Jitter::None,
                    "full" => Jitter::Full,
                    "equal" => Jitter::Equal,
                    _ => return Err("unknown jitter".into()),
                },
            },
            budget: CountBound {
                max_attempts: numeric(required(retry, "maxAttempts")?)?,
            },
        });
    }
    if let Some(circuit) = field(input, "circuit") {
        config.circuit = Some(call::CircuitConfig {
            threshold: numeric(required(circuit, "threshold")?)?,
            cooldown_ms: numeric(required(circuit, "cooldownMs")?)?,
            half_open_max_probes: num(circuit, "halfOpenMaxProbes", 1.0)?,
        });
    }
    if let Some(rate) = field(input, "rateLimit") {
        config.rate_limit = Some(call::RateLimitConfig {
            capacity: numeric(required(rate, "capacity")?)?,
            refill_per_sec: numeric(required(rate, "refillPerSec")?)?,
        });
    }
    if let Some(deadline) = field(input, "deadline") {
        config.deadline = Some(call::DeadlineConfig {
            ms: numeric(required(deadline, "ms")?)?,
        });
    }
    Ok(config)
}
fn execute(input: PlainData, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input = revive(input)?;
    if !matches!(input, PlainData::Object(_)) {
        return Err("input needs a record".into());
    }
    let trace = RefCell::new(vec![]);
    let empty = obj([]);
    let config = config(
        field(&input, "config").unwrap_or(&empty),
        field(&input, "callbacks").unwrap_or(&empty),
        &trace,
    )?;
    let rng = match field(&input, "rng") {
        None => vec![0.5],
        Some(PlainData::Array(values)) => {
            values.iter().map(numeric).collect::<Result<Vec<_>, _>>()?
        }
        _ => return Err("rng needs an array".into()),
    };
    let rng_calls = Cell::new(0usize);
    let knob: Knob<'_> = observe!(
        calls,
        demlik_tea::paginate::paginated_walk::PaginatedWalk::new,
        config
    );
    let knob = observe!(
        calls,
        demlik_tea::paginate::paginated_walk::PaginatedWalk::with_rng,
        knob,
        || {
            let index = rng_calls.get();
            rng_calls.set(index + 1);
            rng.get(index)
                .or_else(|| rng.last())
                .copied()
                .unwrap_or(0.5)
        }
    );
    let definition: &CmdDef<_> = observe!(
        calls,
        demlik_tea::paginate::paginated_walk::PaginatedWalk::fetch,
        &knob
    );
    let fetch = json!({"cmdType":definition.cmd_type(),"okType":definition.ok_type(),"errType":definition.err_type(),"errorTags":definition.error_tags()});
    let mut state = observe!(
        calls,
        demlik_tea::paginate::paginated_walk::PaginatedWalk::init,
        &knob
    );
    if let Some(seed) = field(&input, "seedRaw") {
        state = serde_json::from_str(
            text(seed)?
                .as_utf8()
                .ok_or("seedRaw needs UTF-8 JSON text")?,
        )
        .map_err(|error| format!("native seed decode: {error}"))?;
    }
    let initial = normalized(&state_data(&state));
    let Some(PlainData::Array(actions)) = field(&input, "actions") else {
        return Err("actions need an array".into());
    };
    let mut history = vec![];
    for action in actions {
        let before = state.clone();
        let before_data = normalized(&state_data(&before));
        let op = word(action, "op", "")?;
        let at = num(action, "at", 0.0)?;
        let key = field(action, "key")
            .map(text)
            .transpose()?
            .unwrap_or_else(|| paginated_walk::PAGE_KEY.into());
        trace.borrow_mut().clear();
        let mut commands = vec![];
        let mut error = None;
        let mut message = None;
        let mut encoded = None;
        let result = match op.as_str() {
            "start" => Some(observe!(
                calls,
                demlik_tea::paginate::paginated_walk::PaginatedWalk::start,
                &knob,
                &state,
                at
            )),
            "resume" => Some(observe!(
                calls,
                demlik_tea::paginate::paginated_walk::PaginatedWalk::resume,
                &knob,
                &state,
                at
            )),
            "ok" => Some(observe!(
                calls,
                demlik_tea::paginate::paginated_walk::PaginatedWalk::page_ok,
                &knob,
                &state,
                observe!(
                    calls,
                    demlik_tea::paginate::paginated_walk::PageOk::new,
                    key,
                    val(field(action, "value")),
                    at
                )
            )),
            "err" => Some(observe!(
                calls,
                demlik_tea::paginate::paginated_walk::PaginatedWalk::page_err,
                &knob,
                &state,
                observe!(
                    calls,
                    demlik_tea::paginate::paginated_walk::PageErr::new,
                    key,
                    failure(field(action, "error")),
                    at
                )
            )),
            "timer" | "fireNext" => {
                let timer: Option<DeadlineExceeded> = if op == "fireNext" {
                    observe!(
                        calls,
                        demlik_tea::paginate::paginated_walk::PaginatedWalk::timer,
                        &knob,
                        &state
                    )
                    .map(|value| value.msg)
                } else {
                    Some(deadline_exceeded(text(required(action, "id")?)?, at, None))
                };
                timer.map(|timer| {
                    observe!(
                        calls,
                        demlik_tea::paginate::paginated_walk::PaginatedWalk::on_timer,
                        &knob,
                        &state,
                        &timer
                    )
                })
            }
            "drain" => Some(Ok(observe!(
                calls,
                demlik_tea::paginate::paginated_walk::PaginatedWalk::drain,
                &knob,
                &state,
                numeric(required(action, "n")?)?
            ))),
            "roundtrip" => {
                let json = serde_json::to_string(&state).map_err(|error| error.to_string())?;
                state = serde_json::from_str(&json)
                    .map_err(|error| format!("native restore: {error}"))?;
                encoded = Some(json);
                None
            }
            "fetchCtor" => {
                let command = observe!(
                    calls,
                    demlik_tea::command::CmdDef::from_record,
                    definition,
                    call::RunInput {
                        key,
                        input: val(field(action, "input"))
                    }
                );
                message = Some(command_data(&Command::Fetch(command)));
                None
            }
            "lift" => {
                struct Host {
                    marker: &'static str,
                    walk: Model,
                }
                let lifted = observe!(
                    calls,
                    demlik_tea::paginate::paginated_walk::lift_walk,
                    Host {
                        marker: "kept",
                        walk: state.clone()
                    },
                    Step::<_, Command>::new(state.clone(), vec![]),
                    |host: Host, walk| Host { walk, ..host }
                );
                message = Some(obj([
                    ("marker", data(&lifted.state.marker)),
                    ("walk", state_data(&lifted.state.walk)),
                ]));
                state = lifted.state.walk;
                commands = lifted.commands;
                None
            }
            "inspect" => None,
            _ => return Err(format!("unsupported operation {op}")),
        };
        if let Some(result) = result {
            match result {
                Ok(step) => {
                    state = step.state;
                    commands = step.commands;
                }
                Err(cause) => error = Some(error_data(cause)),
            }
        }
        let complete = observe!(
            calls,
            demlik_tea::paginate::paginated_walk::PaginatedWalk::is_complete,
            &knob,
            &state
        );
        let stuck = observe!(
            calls,
            demlik_tea::paginate::paginated_walk::PaginatedWalk::is_stuck,
            &knob,
            &state
        );
        let failure = observe!(
            calls,
            demlik_tea::paginate::paginated_walk::PaginatedWalk::failure,
            &knob,
            &state
        )
        .map_or(PlainData::Undefined, |value| failure_data(value));
        let deadlines = observe!(
            calls,
            demlik_tea::paginate::paginated_walk::PaginatedWalk::deadlines,
            &knob,
            &state
        );
        let timer = observe!(
            calls,
            demlik_tea::paginate::paginated_walk::PaginatedWalk::timer,
            &knob,
            &state
        );
        let mut row = json!({"op":op,"state":normalized(&state_data(&state)),"cmds":commands.iter().map(|command|normalized(&command_data(command))).collect::<Vec<_>>(),"same":state.ptr_eq(&before),"walkSame":state.walk().ptr_eq(before.walk()),"resilienceSame":state.resilience().same(before.resilience()),"beforeUnchanged":before_data==normalized(&state_data(&before)),"callbacks":*trace.borrow(),"complete":complete,"stuck":stuck,"failure":normalized(&failure),"deadlines":normalized(&deadlines_data(&deadlines)),"timer":normalized(&data(&timer))});
        let fields = row.as_object_mut().unwrap();
        if let Some(error) = error {
            fields.insert("error".into(), normalized(&error));
        }
        if let Some(message) = message {
            fields.insert("message".into(), normalized(&message));
        }
        if let Some(encoded) = encoded {
            fields.insert("json".into(), json!(encoded));
        }
        history.push(row);
    }
    Ok(json!({"fetch":fetch,"initial":initial,"history":history,"rngCalls":rng_calls.get()}))
}
fn main() {
    for line in io::stdin().lock().lines() {
        let mut calls = vec![];
        let response = match line {
            Ok(line) => match serde_json::from_str::<Request>(&line) {
                Ok(request) => match decode_json(request.input.get())
                    .map_err(|error| error.to_string())
                    .and_then(|input| execute(input, &mut calls))
                {
                    Ok(output) => {
                        json!({"id":request.id,"ok":true,"output":output,"observedCalls":calls})
                    }
                    Err(error) => {
                        json!({"id":request.id,"ok":false,"error":{"kind":"driver_error","message":error}})
                    }
                },
                Err(error) => {
                    json!({"ok":false,"error":{"kind":"driver_error","message":error.to_string()}})
                }
            },
            Err(error) => {
                json!({"ok":false,"error":{"kind":"driver_error","message":error.to_string()}})
            }
        };
        println!("{response}");
    }
}
