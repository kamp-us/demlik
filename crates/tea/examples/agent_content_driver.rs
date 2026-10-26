use demlik_tea::{
    PlainData,
    agent::{
        content::{
            ContentPart, FilePart, ImagePart, MediaBytes, MediaSource, MessageContent, Parts,
            TextPart,
        },
        transcript::{Transcript, TranscriptSeed, TranscriptSnapshot},
        types::{
            AgentEndedStatus, AgentEvent, AgentEventHead, AgentTurn, Awaiting, Conversation,
            ToolCall, ToolOutcome, ToolRecord, TurnUsage,
        },
    },
    data::{JsText, JsonData, plain_data},
    work_queue::QueueField,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    cell::RefCell,
    io::{self, BufRead, Write},
    rc::Rc,
};
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let result=$function($($arg),*);$calls.push(stringify!($function));result}};}
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
    #[serde(skip_serializing_if = "Option::is_none")]
    native_error: Option<Box<RawValue>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteByte {
    index: usize,
    value: u8,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MediaInput {
    bytes: Vec<u8>,
    range: [usize; 2],
    backing_write: Option<WriteByte>,
    view_write: Option<WriteByte>,
    copy_write: Option<WriteByte>,
}
struct Media {
    backing: MediaBytes,
    view: MediaBytes,
    copy: MediaBytes,
}
impl Media {
    fn new(input: &MediaInput) -> Result<Self, String> {
        let backing = MediaBytes::new(input.bytes.clone());
        let view = backing
            .view(input.range[0]..input.range[1])
            .map_err(|e| e.to_string())?;
        let copy = view.copied();
        Ok(Self {
            backing,
            view,
            copy,
        })
    }
    fn mutate(&self, input: &MediaInput) -> Result<(), String> {
        for (bytes, write) in [
            (&self.backing, &input.backing_write),
            (&self.view, &input.view_write),
            (&self.copy, &input.copy_write),
        ] {
            if let Some(write) = write {
                bytes
                    .set(write.index, write.value)
                    .map_err(|e| e.to_string())?
            }
        }
        Ok(())
    }
    fn data(&self) -> MediaData {
        MediaData {
            backing: self.backing.to_vec(),
            view: self.view.to_vec(),
            copy: self.copy.to_vec(),
            offset: self.view.offset(),
            len: self.view.len(),
            same_view: self.view.same_view(&self.backing),
            same_buffer: self.view.shares_buffer(&self.backing),
            copy_same_view: self.copy.same_view(&self.view),
            copy_same_buffer: self.copy.shares_buffer(&self.view),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaData {
    backing: Vec<u8>,
    view: Vec<u8>,
    copy: Vec<u8>,
    offset: usize,
    len: usize,
    same_view: bool,
    same_buffer: bool,
    copy_same_view: bool,
    copy_same_buffer: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum SourceWire {
    Base64 { data: JsText },
    Bytes,
    Url { url: JsText },
}
impl SourceWire {
    fn make(self, media: &Media) -> Rc<MediaSource> {
        Rc::new(match self {
            Self::Base64 { data } => MediaSource::Base64 { data },
            Self::Bytes => MediaSource::Bytes {
                data: media.view.clone(),
            },
            Self::Url { url } => MediaSource::Url { url },
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum PartWire {
    Text {
        text: JsText,
    },
    Image {
        #[serde(rename = "mediaType")]
        media_type: JsText,
        source: SourceWire,
    },
    File {
        #[serde(rename = "mediaType")]
        media_type: JsText,
        source: SourceWire,
    },
    Reuse {
        index: usize,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContentInput {
    text: JsText,
    parts: Vec<PartWire>,
    media: MediaInput,
    append_text: JsText,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentOutput {
    string_parts: Parts,
    string_fresh_array: bool,
    string_fresh_part: bool,
    passed_same_array: bool,
    repeated_same_array: bool,
    initial: Box<RawValue>,
    omitted: Parts,
    omit_fresh_array: bool,
    omit_repeat_fresh_array: bool,
    omitted_retained: Vec<bool>,
    omitted_repeat_same: Vec<bool>,
    omitted_same: Vec<Vec<bool>>,
    after_mutation: Parts,
    media_before: MediaData,
    media_after: MediaData,
    byte_source_views: Vec<bool>,
}
fn content(input: ContentInput, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    let media = Media::new(&input.media)?;
    let mut source = Vec::new();
    for wire in input.parts {
        let part = match wire {
            PartWire::Text { text } => ContentPart::Text(Rc::new(TextPart { text })),
            PartWire::Image { media_type, source } => ContentPart::Image(Rc::new(ImagePart {
                media_type,
                source: source.make(&media),
            })),
            PartWire::File { media_type, source } => ContentPart::File(Rc::new(FilePart {
                media_type,
                source: source.make(&media),
            })),
            PartWire::Reuse { index } => source.get(index).cloned().ok_or("unknown reused part")?,
        };
        source.push(part)
    }
    let parts: Parts = Rc::new(RefCell::new(source));
    let text = MessageContent::Text(input.text);
    let first = observe!(calls, demlik_tea::agent::content::content_parts, &text);
    let second = observe!(calls, demlik_tea::agent::content::content_parts, &text);
    let message = MessageContent::Parts(Rc::clone(&parts));
    let passed = observe!(calls, demlik_tea::agent::content::content_parts, &message);
    let repeated = observe!(calls, demlik_tea::agent::content::content_parts, &message);
    let omitted = observe!(calls, demlik_tea::agent::content::omit_media, &parts);
    let another = observe!(calls, demlik_tea::agent::content::omit_media, &parts);
    let initial = to_raw_value(&*parts.borrow()).map_err(|e| e.to_string())?;
    let omitted_retained = omitted
        .borrow()
        .iter()
        .zip(parts.borrow().iter())
        .map(|(a, b)| a.same_identity(b))
        .collect();
    let omitted_repeat_same = omitted
        .borrow()
        .iter()
        .zip(another.borrow().iter())
        .map(|(a, b)| a.same_identity(b))
        .collect();
    let omitted_same = omitted
        .borrow()
        .iter()
        .map(|a| {
            omitted
                .borrow()
                .iter()
                .map(|b| a.same_identity(b))
                .collect()
        })
        .collect();
    let before = media.data();
    parts.borrow_mut().push(ContentPart::Text(Rc::new(TextPart {
        text: input.append_text,
    })));
    media.mutate(&input.media)?;
    let byte_source_views = parts
        .borrow()
        .iter()
        .filter_map(|part| {
            let source = match part {
                ContentPart::Text(_) => return None,
                ContentPart::Image(p) => &p.source,
                ContentPart::File(p) => &p.source,
            };
            if let MediaSource::Bytes { data } = source.as_ref() {
                Some(data.same_view(&media.view))
            } else {
                None
            }
        })
        .collect();
    let output = ContentOutput {
        string_parts: Rc::clone(&first),
        string_fresh_array: !Rc::ptr_eq(&first, &second),
        string_fresh_part: first
            .borrow()
            .first()
            .zip(second.borrow().first())
            .is_some_and(|(a, b)| !a.same_identity(b)),
        passed_same_array: Rc::ptr_eq(&passed, &parts),
        repeated_same_array: Rc::ptr_eq(&repeated, &parts),
        initial,
        omitted: Rc::clone(&omitted),
        omit_fresh_array: !Rc::ptr_eq(&omitted, &parts),
        omit_repeat_fresh_array: !Rc::ptr_eq(&omitted, &another),
        omitted_retained,
        omitted_repeat_same,
        omitted_same,
        after_mutation: passed,
        media_before: before,
        media_after: media.data(),
        byte_source_views,
    };
    to_raw_value(&output).map_err(|e| e.to_string())
}
fn present_data<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<PlainData>, D::Error> {
    PlainData::deserialize(d).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Encoded {
    kind: String,
    #[serde(default, deserialize_with = "present_data")]
    value: Option<PlainData>,
}
impl Encoded {
    fn decode(self) -> Result<PlainData, String> {
        match self.kind.as_str() {
            "json" => self.value.ok_or("json value missing".into()),
            "undefined" => Ok(PlainData::Undefined),
            "nan" => Ok(PlainData::Number(f64::NAN)),
            "infinity" => Ok(PlainData::Number(f64::INFINITY)),
            "negative-infinity" => Ok(PlainData::Number(f64::NEG_INFINITY)),
            "negative-zero" => Ok(PlainData::Number(-0.0)),
            _ => Err("unknown encoded value".into()),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValueDef {
    value: Encoded,
    #[serde(default)]
    media: bool,
}
struct Value {
    data: RefCell<PlainData>,
    media: RefCell<Option<MediaBytes>>,
}
impl Serialize for Value {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut value = self.data.borrow().clone();
        if let Some(media) = &*self.media.borrow() {
            let PlainData::Object(fields) = &mut value else {
                return Err(serde::ser::Error::custom("media value must be an object"));
            };
            fields.insert(
                "media".into(),
                plain_data(media).map_err(serde::ser::Error::custom)?,
            );
        }
        JsonData(&value).serialize(s)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum SeedTool {
    Ok {
        #[serde(rename = "callId")]
        call_id: JsText,
        result: usize,
    },
    Error {
        #[serde(rename = "callId")]
        call_id: JsText,
    },
    Reuse {
        index: usize,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Seed {
    turns: Vec<usize>,
    tools: Vec<SeedTool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Usage {
    input_tokens: f64,
    output_tokens: f64,
    reasoning_tokens: Option<f64>,
    cached_input_tokens: Option<f64>,
}
impl Usage {
    fn make(self) -> Rc<TurnUsage> {
        Rc::new(TurnUsage {
            input_tokens: self.input_tokens.into(),
            output_tokens: self.output_tokens.into(),
            reasoning_tokens: self
                .reasoning_tokens
                .map_or(QueueField::Absent, |v| QueueField::Value(v.into())),
            cached_input_tokens: self
                .cached_input_tokens
                .map_or(QueueField::Absent, |v| QueueField::Value(v.into())),
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum Status {
    Done { output: Option<usize>, usage: Usage },
    Failed { failure: usize },
    Cancelled { at: f64 },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
enum Event {
    BrainStarted {
        payload: usize,
    },
    TurnSettled {
        turn: usize,
    },
    ToolStarted {
        args: usize,
        #[serde(rename = "callId")]
        call_id: JsText,
    },
    ToolSettled {
        result: usize,
        #[serde(rename = "callId")]
        call_id: JsText,
    },
    ToolFailed {
        failure: usize,
        #[serde(rename = "callId")]
        call_id: JsText,
    },
    RunDone {
        status: usize,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    index: usize,
    key: JsText,
    value: Encoded,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TranscriptInput {
    values: Vec<ValueDef>,
    seed: Option<Seed>,
    statuses: Vec<Status>,
    events: Vec<Event>,
    changes: Vec<Change>,
    #[serde(default)]
    clear_first: bool,
    media: MediaInput,
}
type Snapshot = TranscriptSnapshot<Value, Value, Value>;
type Ended = AgentEndedStatus<Value, Value>;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptOutput {
    snapshots: Vec<Snapshot>,
    current: Snapshot,
    turn_same: Vec<Vec<bool>>,
    tool_same: Vec<Vec<bool>>,
    result_same: Vec<Vec<Option<bool>>>,
    outcome_same: Vec<Vec<bool>>,
    outcome_input: Vec<Vec<bool>>,
    result_media_views: Vec<Option<bool>>,
    media_before: MediaData,
    media_after: MediaData,
    event_types: Vec<&'static str>,
    emitted_types: Vec<String>,
}
fn at<T>(values: &[Rc<T>], index: usize) -> Result<Rc<T>, String> {
    values
        .get(index)
        .map(Rc::clone)
        .ok_or("unknown value index".into())
}
fn head() -> AgentEventHead {
    AgentEventHead {
        run_id: "r".into(),
        at: 1.0,
    }
}
fn transcript(
    input: TranscriptInput,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, String> {
    let media = Media::new(&input.media)?;
    let before = media.data();
    let values = input
        .values
        .into_iter()
        .map(|def| {
            let value = def.value.decode()?;
            if def.media && !matches!(value, PlainData::Object(_)) {
                return Err("media value must be an object".into());
            }
            Ok(Rc::new(Value {
                data: RefCell::new(value),
                media: RefCell::new(def.media.then(|| media.view.clone())),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let statuses = input
        .statuses
        .into_iter()
        .map(|s| {
            Ok(Rc::new(match s {
                Status::Done { output, usage } => Ended::Done {
                    output: QueueField::Value(output.map(|i| at(&values, i)).transpose()?),
                    usage: usage.make(),
                },
                Status::Failed { failure } => Ended::Failed {
                    failure: QueueField::Value(at(&values, failure)?),
                },
                Status::Cancelled { at } => Ended::Cancelled { at: at.into() },
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut conversation: Option<Conversation<Value, Value>> = if let Some(seed) = input.seed {
        let mut records = Vec::new();
        for wire in seed.tools {
            let record = match wire {
                SeedTool::Reuse { index } => records
                    .get(index)
                    .map(Rc::clone)
                    .ok_or("unknown reused record")?,
                SeedTool::Ok { call_id, result } => Rc::new(ToolRecord {
                    call: Rc::new(ToolCall {
                        call_id,
                        name: "tool".into(),
                        args: Rc::new(PlainData::Object(Default::default())),
                    }),
                    outcome: Rc::new(ToolOutcome::Ok(at(&values, result)?)),
                    turn: 1.0.into(),
                }),
                SeedTool::Error { call_id } => Rc::new(ToolRecord {
                    call: Rc::new(ToolCall {
                        call_id,
                        name: "tool".into(),
                        args: Rc::new(PlainData::Object(Default::default())),
                    }),
                    outcome: Rc::new(ToolOutcome::Error(Rc::new(PlainData::Null))),
                    turn: 1.0.into(),
                }),
            };
            records.push(record)
        }
        Some(Conversation {
            turns: Rc::new(
                seed.turns
                    .into_iter()
                    .map(|i| at(&values, i))
                    .collect::<Result<_, _>>()?,
            ),
            tool_records: Rc::new(records),
            turn_count: 1.0.into(),
            awaiting: Awaiting::Llm,
            context_tokens: QueueField::Value(demlik_tea::data::NumberOrNull(None)),
            legacy_usage: QueueField::Absent,
        })
    } else {
        None
    };
    let collector: Transcript<Value, Value, Value> = if let Some(conversation) = &conversation {
        observe!(
            calls,
            demlik_tea::agent::transcript::Transcript::from_seed,
            TranscriptSeed {
                conversation: Some(conversation)
            }
        )
    } else {
        observe!(calls, demlik_tea::agent::transcript::Transcript::new)
    };
    let mut snapshots = vec![observe!(
        calls,
        demlik_tea::agent::transcript::Transcript::read,
        &collector
    )];
    if let Some(c) = &mut conversation {
        Rc::make_mut(&mut c.turns).clear();
        Rc::make_mut(&mut c.tool_records).clear();
    }
    let mut emitted_types = Vec::new();
    for event in input.events {
        let event: AgentEvent<Value, Value, Value, Value, Value, Value> = match event {
            Event::BrainStarted { payload } => AgentEvent::BrainStarted {
                head: head(),
                turn: 2.0,
                purpose: "p".into(),
                model: None,
                payload: at(&values, payload)?,
            },
            Event::TurnSettled { turn } => AgentEvent::TurnSettled {
                head: head(),
                turn: at(&values, turn)?,
                usage: QueueField::Absent,
            },
            Event::ToolStarted { args, call_id } => AgentEvent::ToolStarted {
                head: head(),
                call_id,
                name: "tool".into(),
                args: at(&values, args)?,
            },
            Event::ToolSettled { result, call_id } => AgentEvent::ToolSettled {
                head: head(),
                call_id,
                result: at(&values, result)?,
            },
            Event::ToolFailed { failure, call_id } => AgentEvent::ToolFailed {
                head: head(),
                call_id,
                name: "tool".into(),
                failure: at(&values, failure)?,
            },
            Event::RunDone { status } => AgentEvent::RunDone {
                head: head(),
                status: at(&statuses, status)?,
            },
        };
        emitted_types.push(observe!(calls, demlik_tea::Tagged::tag, &event).to_owned());
        observe!(
            calls,
            demlik_tea::agent::transcript::Transcript::on_event,
            &collector,
            &event
        );
        snapshots.push(observe!(
            calls,
            demlik_tea::agent::transcript::Transcript::read,
            &collector
        ));
    }
    for change in input.changes {
        let value = at(&values, change.index)?;
        let mut data = value.data.borrow_mut();
        let PlainData::Object(fields) = &mut *data else {
            return Err("changed value must be an object".into());
        };
        if change.key == JsText::from("media") {
            value.media.borrow_mut().take();
        }
        fields.insert(change.key, change.value.decode()?);
    }
    media.mutate(&input.media)?;
    if input.clear_first {
        snapshots[0].turns.clear();
        snapshots[0].tools.clear();
    }
    let current = observe!(
        calls,
        demlik_tea::agent::transcript::Transcript::read,
        &collector
    );
    let all = snapshots
        .iter()
        .chain(std::iter::once(&current))
        .collect::<Vec<_>>();
    let turns = all.iter().flat_map(|s| s.turns.iter()).collect::<Vec<_>>();
    let tools = all.iter().flat_map(|s| s.tools.iter()).collect::<Vec<_>>();
    let turn_same = turns
        .iter()
        .map(|a| turns.iter().map(|b| Rc::ptr_eq(a, b)).collect())
        .collect();
    let tool_same = tools
        .iter()
        .map(|a| tools.iter().map(|b| Rc::ptr_eq(a, b)).collect())
        .collect();
    let result_same = tools
        .iter()
        .map(|a| {
            tools
                .iter()
                .map(|b| {
                    let a_object = matches!(
                        *a.result.data.borrow(),
                        PlainData::Object(_) | PlainData::Array(_)
                    );
                    let b_object = matches!(
                        *b.result.data.borrow(),
                        PlainData::Object(_) | PlainData::Array(_)
                    );
                    (a_object && b_object).then(|| Rc::ptr_eq(&a.result, &b.result))
                })
                .collect()
        })
        .collect();
    let outcome_same = all
        .iter()
        .map(|a| {
            all.iter()
                .map(|b| a.outcome.same_identity(&b.outcome))
                .collect()
        })
        .collect();
    let outcome_input = all
        .iter()
        .map(|s| {
            statuses
                .iter()
                .map(|status| {
                    s.outcome
                        .ended()
                        .is_some_and(|ended| Rc::ptr_eq(ended, status))
                })
                .collect()
        })
        .collect();
    let result_media_views = tools
        .iter()
        .map(|tool| {
            tool.result
                .media
                .borrow()
                .as_ref()
                .map(|v| v.same_view(&media.view))
        })
        .collect();
    let output = TranscriptOutput {
        snapshots,
        current,
        turn_same,
        tool_same,
        result_same,
        outcome_same,
        outcome_input,
        result_media_views,
        media_before: before,
        media_after: media.data(),
        event_types: demlik_tea::agent::types::AGENT_EVENT_TYPES.to_vec(),
        emitted_types,
    };
    to_raw_value(&output).map_err(|e| e.to_string())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CallInput {
    call_id: JsText,
    name: JsText,
    args: PlainData,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HeadInput {
    run_id: JsText,
    at: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CanonicalInput {
    content: JsText,
    tool_calls: Vec<CallInput>,
    provider: Option<Encoded>,
    usage: Option<Usage>,
    head: HeadInput,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalOutput {
    head: AgentEventHead,
    snapshot: TranscriptSnapshot<PlainData>,
    turn_retained: bool,
    provider_present: bool,
    usage_present: bool,
}
fn canonical(
    input: CanonicalInput,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, String> {
    let tool_calls = input
        .tool_calls
        .into_iter()
        .map(|call| {
            Rc::new(ToolCall {
                call_id: call.call_id,
                name: call.name,
                args: Rc::new(call.args),
            })
        })
        .collect();
    let mut turn: AgentTurn = observe!(
        calls,
        demlik_tea::agent::types::AgentTurn::new,
        input.content,
        tool_calls
    );
    if let Some(provider) = input.provider {
        turn.provider = QueueField::Value(Rc::new(provider.decode()?));
    }
    if let Some(usage) = input.usage {
        turn.usage = QueueField::Value(usage.make());
    }
    let provider_present = !turn.provider.is_absent();
    let usage_present = !turn.usage.is_absent();
    let turn = Rc::new(turn);
    let head = AgentEventHead {
        run_id: input.head.run_id,
        at: input.head.at,
    };
    let collector: Transcript<PlainData> =
        observe!(calls, demlik_tea::agent::transcript::Transcript::new);
    let event: AgentEvent<PlainData> = AgentEvent::TurnSettled {
        head: head.clone(),
        turn: Rc::clone(&turn),
        usage: QueueField::Absent,
    };
    observe!(
        calls,
        demlik_tea::agent::transcript::Transcript::on_event,
        &collector,
        &event
    );
    let snapshot = observe!(
        calls,
        demlik_tea::agent::transcript::Transcript::read,
        &collector
    );
    let output = CanonicalOutput {
        head,
        turn_retained: Rc::ptr_eq(&snapshot.turns[0], &turn),
        snapshot,
        provider_present,
        usage_present,
    };
    to_raw_value(&output).map_err(|e| e.to_string())
}
#[derive(Serialize)]
struct ErrorView {
    name: &'static str,
    message: JsText,
}
#[derive(Serialize)]
struct RawOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<TranscriptSnapshot<PlainData, PlainData, PlainData>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorView>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedErrorData<'a> {
    name: &'static str,
    message: &'a JsText,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<JsonData<'a>>,
    value_kind: &'static str,
}
fn raw_seed(
    input: PlainData,
    calls: &mut Vec<&'static str>,
    details: &mut Option<Box<RawValue>>,
) -> Result<Box<RawValue>, String> {
    let result = observe!(
        calls,
        demlik_tea::agent::transcript::Transcript::from_plain_seed,
        &input
    );
    let output = match result {
        Ok(collector) => RawOutput {
            value: Some(observe!(
                calls,
                demlik_tea::agent::transcript::Transcript::read,
                &collector
            )),
            error: None,
        },
        Err(error) => {
            let kind = match error.value.as_ref() {
                PlainData::Null => "null",
                PlainData::Undefined => "undefined",
                PlainData::Bool(_) => "boolean",
                PlainData::Number(_) => "number",
                PlainData::String(_) => "string",
                PlainData::Array(_) => "array",
                PlainData::Object(_) => "object",
            };
            *details = Some(
                to_raw_value(&SeedErrorData {
                    name: error.name,
                    message: &error.message,
                    value: (!matches!(error.value.as_ref(), PlainData::Undefined))
                        .then_some(JsonData(&error.value)),
                    value_kind: kind,
                })
                .map_err(|e| e.to_string())?,
            );
            RawOutput {
                value: None,
                error: Some(ErrorView {
                    name: error.name,
                    message: error.message,
                }),
            }
        }
    };
    to_raw_value(&output).map_err(|e| e.to_string())
}
fn execute(
    request: &Request,
    calls: &mut Vec<&'static str>,
    details: &mut Option<Box<RawValue>>,
) -> Result<Box<RawValue>, String> {
    match request.operation.as_str() {
        "content" => content(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
        ),
        "transcript" => transcript(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
        ),
        "canonical-turn" => canonical(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
        ),
        "raw-seed" => raw_seed(
            serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?,
            calls,
            details,
        ),
        _ => Err("unknown operation".into()),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let line = line?;
        let mut calls = Vec::new();
        let mut details = None;
        let request = serde_json::from_str::<Request>(&line);
        let id = request.as_ref().ok().map(|r| r.id.clone());
        let result = request
            .map_err(|e| e.to_string())
            .and_then(|request| execute(&request, &mut calls, &mut details));
        let response = match result {
            Ok(output) => Response {
                id,
                ok: true,
                output: Some(output),
                error: None,
                observed_calls: calls,
                native_error: details,
            },
            Err(error) => Response {
                id,
                ok: false,
                output: None,
                error: Some(error),
                observed_calls: calls,
                native_error: details,
            },
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
    }
    stdout.flush()?;
    Ok(())
}
