use demlik_tea::{
    PlainData,
    agent::{
        GuardedSchema,
        compaction::CompactionSummary,
        types::{
            AgentField, AgentNumber, Awaiting, Conversation, ToolCall, ToolOutcome, ToolRecord,
            TurnUsage,
        },
    },
    data::{JsText, JsonData, plain_data, stringify_json},
    resilience::resilient_call::CallValue,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    cell::RefCell,
    io::{self, BufRead, Write},
    rc::Rc,
};

macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let result=$function($($arg),*);$calls.push(stringify!($function));result}};}
macro_rules! observe_value {
    ($calls:expr,$value:path) => {{
        let result = &$value;
        $calls.push(stringify!($value));
        result
    }};
}
fn object(values: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(
        values
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
fn array(values: impl IntoIterator<Item = PlainData>) -> PlainData {
    PlainData::Array(values.into_iter().collect())
}
fn string(value: impl Into<JsText>) -> PlainData {
    PlainData::String(value.into())
}
fn boolean(value: bool) -> PlainData {
    PlainData::Bool(value)
}
fn encoded(value: &impl Serialize) -> Result<PlainData, String> {
    plain_data(value).map_err(|error| error.to_string())
}
fn describe(value: &PlainData) -> PlainData {
    match value {
        PlainData::Undefined => object([("$value", string("undefined"))]),
        PlainData::Number(value)
            if !value.is_finite() || *value == 0.0 && value.is_sign_negative() =>
        {
            object([(
                "$value",
                string(if value.is_nan() {
                    "NaN"
                } else if *value == f64::INFINITY {
                    "Infinity"
                } else if *value == f64::NEG_INFINITY {
                    "-Infinity"
                } else {
                    "-0"
                }),
            )])
        }
        PlainData::Array(values) => array(values.iter().map(describe)),
        PlainData::Object(values) => PlainData::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), describe(value)))
                .collect(),
        ),
        value => value.clone(),
    }
}
// Test-value descriptors construct actual non-JSON values at the oracle seam.
fn inflate(value: PlainData) -> Result<PlainData, String> {
    Ok(match value {
        PlainData::Object(mut fields) if fields.len() == 1 && fields.contains_key("$value") => {
            let PlainData::String(name) = fields.swap_remove("$value").unwrap() else {
                return Err("invalid value descriptor".into());
            };
            match name.as_utf8() {
                Some("undefined") => PlainData::Undefined,
                Some("NaN") => PlainData::Number(f64::NAN),
                Some("Infinity") => PlainData::Number(f64::INFINITY),
                Some("-Infinity") => PlainData::Number(f64::NEG_INFINITY),
                Some("-0") => PlainData::Number(-0.0),
                _ => return Err("unknown value descriptor".into()),
            }
        }
        PlainData::Object(fields) => PlainData::Object(
            fields
                .into_iter()
                .map(|(key, value)| Ok((key, inflate(value)?)))
                .collect::<Result<_, String>>()?,
        ),
        PlainData::Array(values) => array(
            values
                .into_iter()
                .map(inflate)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        value => value,
    })
}
fn number(value: PlainData) -> Result<f64, String> {
    match inflate(value)? {
        PlainData::Number(value) => Ok(value),
        _ => Err("expected numeric fixture".into()),
    }
}
fn json(value: &PlainData) -> PlainData {
    stringify_json(value).map_or(PlainData::Null, string)
}
fn observation(value: &PlainData) -> PlainData {
    object([("value", describe(value)), ("json", json(value))])
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: JsText,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<JsText>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    observed_calls: Vec<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    native_errors: Vec<Box<RawValue>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GuardInput {
    value: PlainData,
}
fn parse(
    schema: &GuardedSchema,
    value: &Rc<PlainData>,
    calls: &mut Vec<&'static str>,
    errors: &mut Vec<PlainData>,
) -> PlainData {
    match observe!(
        calls,
        demlik_tea::llm_call::Schema::parse,
        schema,
        Rc::clone(value)
    ) {
        Ok(parsed) => object([
            ("ok", boolean(true)),
            ("sameOriginal", boolean(Rc::ptr_eq(&parsed, value))),
            ("observation", observation(&parsed)),
        ]),
        Err(CallValue::Shared(error)) => {
            errors.push(object([
                ("name", string(error.name())),
                ("message", string(error.message())),
                ("rejected", describe(error.value())),
                ("sameRejected", boolean(Rc::ptr_eq(error.value(), value))),
            ]));
            object([
                ("ok", boolean(false)),
                (
                    "error",
                    object([
                        ("name", string(error.name())),
                        ("message", string(error.message())),
                    ]),
                ),
            ])
        }
        Err(_) => unreachable!("built-in guard schemas retain an owned parse failure"),
    }
}
fn guards(
    input: GuardInput,
    calls: &mut Vec<&'static str>,
    errors: &mut Vec<PlainData>,
) -> Result<PlainData, String> {
    let value = Rc::new(inflate(input.value)?);
    let usage = observe!(calls, demlik_tea::agent::types::is_turn_usage, &value);
    let turn = observe!(calls, demlik_tea::agent::types::is_agent_turn, &value);
    let summary = observe!(
        calls,
        demlik_tea::agent::compaction::is_compaction_summary,
        &value
    );
    let turn_schema = observe_value!(calls, demlik_tea::agent::types::AGENT_TURN_SCHEMA);
    let turn_parsed = parse(turn_schema, &value, calls, errors);
    let summary_schema = observe_value!(
        calls,
        demlik_tea::agent::compaction::COMPACTION_SUMMARY_SCHEMA
    );
    let summary_parsed = parse(summary_schema, &value, calls, errors);
    Ok(object([
        ("usage", boolean(usage)),
        ("turn", boolean(turn)),
        ("summary", boolean(summary)),
        ("turnParsed", turn_parsed),
        ("summaryParsed", summary_parsed),
    ]))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddInput {
    left: PlainData,
    right: PlainData,
}
fn usage(value: PlainData) -> Result<TurnUsage, String> {
    let PlainData::Object(mut fields) = inflate(value)? else {
        return Err("expected usage fixture".into());
    };
    let required = |fields: &mut indexmap::IndexMap<JsText, PlainData>, key: &str| match fields
        .swap_remove(key)
    {
        Some(PlainData::Number(value)) => Ok(value),
        _ => Err(format!("expected numeric {key}")),
    };
    let mut result = TurnUsage::new(
        required(&mut fields, "inputTokens")?,
        required(&mut fields, "outputTokens")?,
    );
    let optional = |fields: &mut indexmap::IndexMap<JsText, PlainData>, key: &str| match fields
        .swap_remove(key)
    {
        None => Ok(AgentField::Absent),
        Some(PlainData::Undefined) => Ok(AgentField::Undefined),
        Some(PlainData::Number(value)) => Ok(AgentField::Value(value.into())),
        _ => Err(format!("expected optional numeric {key}")),
    };
    result.reasoning_tokens = optional(&mut fields, "reasoningTokens")?;
    result.cached_input_tokens = optional(&mut fields, "cachedInputTokens")?;
    if !fields.is_empty() {
        return Err("unknown usage fixture field".into());
    }
    Ok(result)
}
fn stored(value: AgentNumber) -> PlainData {
    value.number().map_or(PlainData::Null, PlainData::Number)
}
fn usage_data(value: &TurnUsage) -> PlainData {
    let mut fields = vec![
        ("inputTokens", stored(value.input_tokens)),
        ("outputTokens", stored(value.output_tokens)),
    ];
    for (key, value) in [
        ("reasoningTokens", &value.reasoning_tokens),
        ("cachedInputTokens", &value.cached_input_tokens),
    ] {
        match value {
            AgentField::Absent => {}
            AgentField::Undefined => fields.push((key, PlainData::Undefined)),
            AgentField::Value(value) => fields.push((key, stored(*value))),
        }
    }
    object(fields)
}
fn add(input: AddInput, calls: &mut Vec<&'static str>) -> Result<PlainData, String> {
    let left = usage(input.left)?;
    let right = usage(input.right)?;
    let sum = observe!(
        calls,
        demlik_tea::agent::conversation::add_usage,
        &left,
        &right
    );
    Ok(object([
        ("sum", observation(&usage_data(&sum))),
        ("left", describe(&usage_data(&left))),
        ("right", describe(&usage_data(&right))),
        (
            "fresh",
            boolean(!std::ptr::eq(&sum, &left) && !std::ptr::eq(&sum, &right)),
        ),
    ]))
}

struct Value(RefCell<PlainData>);
impl Serialize for Value {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        JsonData(&self.0.borrow()).serialize(serializer)
    }
}
fn retained(value: PlainData) -> Result<Rc<Value>, String> {
    Ok(Rc::new(Value(RefCell::new(inflate(value)?))))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CallInput {
    call_id: JsText,
    name: JsText,
    args: PlainData,
}
fn call(input: CallInput) -> Result<Rc<ToolCall<Value>>, String> {
    Ok(Rc::new(ToolCall {
        call_id: input.call_id,
        name: input.name,
        args: retained(input.args)?,
    }))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mutation {
    target: String,
    index: usize,
    key: JsText,
    value: PlainData,
}
fn mutate(value: &Value, key: JsText, value_new: PlainData) -> Result<(), String> {
    let mut value = value.0.borrow_mut();
    let PlainData::Object(fields) = &mut *value else {
        return Err("mutation fixture target must be an object".into());
    };
    fields.insert(key, inflate(value_new)?);
    Ok(())
}
fn at<T>(values: &[Rc<T>], index: usize) -> Result<Rc<T>, String> {
    values
        .get(index)
        .cloned()
        .ok_or_else(|| "fixture index out of range".into())
}
fn index<T>(values: &[Rc<T>], value: &Rc<T>) -> PlainData {
    PlainData::Number(
        values
            .iter()
            .position(|original| Rc::ptr_eq(original, value))
            .map_or(-1.0, |index| index as f64),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DedupeInput {
    calls: Vec<CallInput>,
    #[serde(default)]
    mutations: Vec<Mutation>,
}
fn dedupe(input: DedupeInput, calls: &mut Vec<&'static str>) -> Result<PlainData, String> {
    let original = input
        .calls
        .into_iter()
        .map(call)
        .collect::<Result<Vec<_>, _>>()?;
    for mutation in &input.mutations {
        if mutation.target != "args" || mutation.index >= original.len() {
            return Err("invalid dedupe mutation fixture".into());
        }
    }
    let unique = observe!(
        calls,
        demlik_tea::agent::conversation::dedupe_by_call_id,
        &original
    );
    for mutation in input.mutations {
        mutate(&original[mutation.index].args, mutation.key, mutation.value)?;
    }
    Ok(object([
        ("calls", observation(&encoded(&unique)?)),
        (
            "indices",
            array(unique.iter().map(|value| index(&original, value))),
        ),
        ("fresh", boolean(!std::ptr::eq(&original, &unique))),
    ]))
}
#[derive(Deserialize)]
enum OutcomeInput {
    Ok(PlainData),
    Error(PlainData),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordInput {
    call: usize,
    outcome: usize,
    turn: PlainData,
}
#[derive(Deserialize)]
enum AwaitingInput {
    Llm,
    Tools(PlainData),
    Compacting(PlainData),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FoldInput {
    turns: Vec<PlainData>,
    calls: Vec<CallInput>,
    outcomes: Vec<OutcomeInput>,
    records: Vec<RecordInput>,
    summary: PlainData,
    folding: PlainData,
    turn_count: PlainData,
    awaiting: AwaitingInput,
    #[serde(default)]
    context_tokens: AgentField<PlainData>,
    #[serde(default)]
    mutations: Vec<Mutation>,
}
fn fold(input: FoldInput, observed: &mut Vec<&'static str>) -> Result<PlainData, String> {
    let turns = input
        .turns
        .into_iter()
        .map(retained)
        .collect::<Result<Vec<_>, _>>()?;
    let calls = input
        .calls
        .into_iter()
        .map(call)
        .collect::<Result<Vec<_>, _>>()?;
    let outcomes = input
        .outcomes
        .into_iter()
        .map(|value| {
            Ok(Rc::new(match value {
                OutcomeInput::Ok(value) => ToolOutcome::Ok(retained(value)?),
                OutcomeInput::Error(value) => ToolOutcome::Error(retained(value)?),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let records = input
        .records
        .into_iter()
        .map(|input| {
            Ok(Rc::new(ToolRecord {
                call: at(&calls, input.call)?,
                outcome: at(&outcomes, input.outcome)?,
                turn: number(input.turn)?.into(),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let context_tokens = match input.context_tokens {
        AgentField::Absent => AgentField::Absent,
        AgentField::Undefined => AgentField::Undefined,
        AgentField::Value(value) => match inflate(value)? {
            PlainData::Undefined => AgentField::Undefined,
            PlainData::Null => AgentField::Value(AgentNumber(None)),
            PlainData::Number(value) => AgentField::Value(value.into()),
            _ => return Err("invalid context fixture".into()),
        },
    };
    let awaiting = match input.awaiting {
        AwaitingInput::Llm => Awaiting::Llm,
        AwaitingInput::Tools(value) => Awaiting::Tools {
            batch_turn: number(value)?.into(),
        },
        AwaitingInput::Compacting(value) => Awaiting::Compacting {
            folding: number(value)?.into(),
        },
    };
    let conversation = Conversation {
        turns: Rc::new(turns),
        tool_records: Rc::new(records),
        turn_count: number(input.turn_count)?.into(),
        awaiting,
        context_tokens,
        legacy_usage: AgentField::Absent,
    };
    let folding = number(input.folding)?;
    let summary = retained(input.summary)?;
    for mutation in &input.mutations {
        match mutation.target.as_str() {
            "turn" if mutation.index < conversation.turns.len() => {}
            "args" if mutation.index < calls.len() => {}
            "outcome" if mutation.index < outcomes.len() => {}
            "summary" if mutation.index == 0 => {}
            _ => return Err("invalid fold mutation fixture".into()),
        }
    }
    let folded = observe!(
        observed,
        demlik_tea::agent::conversation::fold_summary,
        &conversation,
        folding,
        Rc::clone(&summary)
    );
    for mutation in input.mutations {
        let value = match mutation.target.as_str() {
            "turn" => at(&conversation.turns, mutation.index)?,
            "args" => Rc::clone(&calls[mutation.index].args),
            "summary" => Rc::clone(&summary),
            "outcome" => match outcomes[mutation.index].as_ref() {
                ToolOutcome::Ok(value) | ToolOutcome::Error(value) => Rc::clone(value),
            },
            _ => unreachable!(),
        };
        mutate(&value, mutation.key, mutation.value)?;
    }
    let original = match encoded(&conversation)? {
        PlainData::Object(mut fields) => {
            if matches!(conversation.context_tokens, AgentField::Undefined) {
                fields.insert("contextTokens".into(), PlainData::Undefined);
            }
            PlainData::Object(fields)
        }
        _ => unreachable!(),
    };
    Ok(object([
        ("folded", observation(&encoded(&folded)?)),
        ("original", observation(&original)),
        (
            "turnIndices",
            array(
                folded
                    .turns
                    .iter()
                    .map(|turn| index(&conversation.turns, turn)),
            ),
        ),
        (
            "summarySame",
            boolean(Rc::ptr_eq(&folded.turns[0], &summary)),
        ),
        (
            "recordIndices",
            array(
                folded
                    .tool_records
                    .iter()
                    .map(|record| index(&conversation.tool_records, record)),
            ),
        ),
        (
            "callIndices",
            array(
                folded
                    .tool_records
                    .iter()
                    .map(|record| index(&calls, &record.call)),
            ),
        ),
        (
            "outcomeIndices",
            array(
                folded
                    .tool_records
                    .iter()
                    .map(|record| index(&outcomes, &record.outcome)),
            ),
        ),
        ("fresh", boolean(!std::ptr::eq(&conversation, &folded))),
        (
            "freshTurns",
            boolean(!Rc::ptr_eq(&conversation.turns, &folded.turns)),
        ),
        (
            "freshRecords",
            boolean(!Rc::ptr_eq(
                &conversation.tool_records,
                &folded.tool_records,
            )),
        ),
    ]))
}
fn fresh(calls: &mut Vec<&'static str>) -> Result<PlainData, String> {
    let first: Conversation<PlainData> =
        observe!(calls, demlik_tea::agent::conversation::fresh_conversation);
    let second: Conversation<PlainData> =
        observe!(calls, demlik_tea::agent::conversation::fresh_conversation);
    let zero = observe_value!(calls, demlik_tea::agent::conversation::NO_USAGE);
    let data = encoded(&first)?;
    let has_usage = matches!(&data,PlainData::Object(fields) if fields.contains_key("usage"));
    Ok(object([
        ("conversation", observation(&data)),
        ("noUsage", observation(&encoded(zero)?)),
        ("fresh", boolean(!std::ptr::eq(&first, &second))),
        (
            "freshTurns",
            boolean(!Rc::ptr_eq(&first.turns, &second.turns)),
        ),
        (
            "freshRecords",
            boolean(!Rc::ptr_eq(&first.tool_records, &second.tool_records)),
        ),
        ("hasUsage", boolean(has_usage)),
    ]))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VocabularyInput {
    summary: JsText,
}
fn vocabulary(input: VocabularyInput, calls: &mut Vec<&'static str>) -> Result<PlainData, String> {
    let purpose = observe_value!(calls, demlik_tea::agent::compaction::COMPACTION_PURPOSE);
    let key = observe!(calls, demlik_tea::llm_call::Purpose::key, purpose);
    let summary = CompactionSummary {
        summary: input.summary,
    };
    let data = observe!(calls, demlik_tea::data::plain_data, &summary)
        .map_err(|error| error.to_string())?;
    Ok(object([
        ("purpose", string(key)),
        ("purposeWire", encoded(purpose)?),
        ("summary", observation(&data)),
    ]))
}
fn execute(
    request: Request,
    calls: &mut Vec<&'static str>,
    errors: &mut Vec<PlainData>,
) -> Result<PlainData, String> {
    let parse = |text: &str| serde_json::from_str(text).map_err(|error| error.to_string());
    match request.operation.as_str() {
        "guards" => guards(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
            errors,
        ),
        "add" => add(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
        ),
        "dedupe" => dedupe(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
        ),
        "fold" => fold(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
        ),
        "fresh" => {
            let value: serde_json::Value = parse(request.input.get())?;
            if value.as_object().is_none_or(|value| !value.is_empty()) {
                return Err("expected empty input".into());
            }
            fresh(calls)
        }
        "vocabulary" => vocabulary(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
        ),
        _ => Err("unknown operation".into()),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = line?;
        let request = serde_json::from_str::<Request>(&line);
        let id = request.as_ref().ok().map(|request| request.id.clone());
        let mut calls = Vec::new();
        let mut errors = Vec::new();
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut calls, &mut errors));
        let (ok, output, error) = match result
            .and_then(|value| to_raw_value(&JsonData(&value)).map_err(|error| error.to_string()))
        {
            Ok(output) => (true, Some(output), None),
            Err(error) => (false, None, Some(error)),
        };
        let native_errors = errors
            .iter()
            .map(|value| to_raw_value(&JsonData(value)))
            .collect::<Result<Vec<_>, _>>()?;
        serde_json::to_writer(
            &mut stdout,
            &Response {
                id,
                ok,
                output,
                error,
                observed_calls: calls,
                native_errors,
            },
        )?;
        writeln!(&mut stdout)?;
    }
    Ok(())
}
