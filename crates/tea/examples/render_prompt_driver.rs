//! Source18's real prompt inputs; observation encoding is caller-selected.
use demlik_tea::{
    PlainData as D,
    agent::{
        AgentMessage, AgentPrompt, PlainCalls, PlainToolCall, PromptMessages,
        StructuredOutputError,
        content::{
            ContentPart, FilePart, ImagePart, MediaBytes, MediaSource, MessageContent, Parts,
            TextPart,
        },
        model::{BrainPorts, MessageLoader, Messages, brain_handler, plain_model},
        render_prompt, render_prompt_with,
        types::{
            AGENT_TURN_SCHEMA, AgentField, AgentTurn, Awaiting, Conversation, ToolCall,
            ToolOutcome, ToolRecord, ToolRecordOf,
        },
    },
    command::Outcome,
    data::{JsText, decode_json, stringify_json},
    llm_call::{Config, LlmCall, Request, Schema},
    resilience::resilient_call::CallValue,
};
use std::{
    cell::{Cell, RefCell},
    future::Future,
    rc::Rc,
};

fn o(fields: impl IntoIterator<Item = (impl Into<JsText>, D)>) -> D {
    D::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn a(v: impl IntoIterator<Item = D>) -> D {
    D::Array(v.into_iter().collect())
}
fn s(v: impl Into<JsText>) -> D {
    D::String(v.into())
}
fn b(v: bool) -> D {
    D::Bool(v)
}
fn n(v: usize) -> D {
    D::Number(v as f64)
}
fn g<'a>(v: &'a D, k: &str) -> &'a D {
    let D::Object(f) = v else {
        panic!("object {k}")
    };
    &f[k]
}
fn list(v: &D) -> &[D] {
    let D::Array(v) = v else { panic!("array") };
    v
}
fn text(v: &D) -> &JsText {
    let D::String(v) = v else { panic!("string") };
    v
}
fn number(v: &D) -> Option<f64> {
    match v {
        D::Null => None,
        D::Number(v) => Some(*v),
        D::Object(v) => match v.get("$number").map(text).and_then(JsText::as_utf8) {
            Some("NaN") => Some(f64::NAN),
            Some("Infinity") => Some(f64::INFINITY),
            Some("-Infinity") => Some(f64::NEG_INFINITY),
            Some("-0") => Some(-0.0),
            _ => panic!("number tag"),
        },
        _ => panic!("number"),
    }
}
fn put(v: &mut D, k: &str, x: D) {
    let D::Object(f) = v else { panic!("object") };
    f.insert(k.into(), x);
}
struct Opaque(Cell<u8>);
struct PartsFailure {
    name: JsText,
    message: JsText,
}
struct Payload {
    view: D,
    opaque: Option<Rc<Opaque>>,
}
fn payload(v: &D, opaque: &Rc<Opaque>) -> Rc<Payload> {
    let tagged = matches!(v,D::Object(f)if f.contains_key("$opaque")||f.get("original").is_some_and(|v|matches!(v,D::Object(f)if f.contains_key("$opaque"))));
    if tagged {
        assert_eq!(opaque.0.get(), 17)
    }
    Rc::new(Payload {
        view: v.clone(),
        opaque: tagged.then(|| Rc::clone(opaque)),
    })
}
type Turn = AgentTurn<Payload, Payload>;
type History = Conversation<Payload, Turn, Payload, Payload>;
type Msg = AgentMessage<Payload, Turn, Payload, Payload>;
type Batch = PromptMessages<Payload, Turn, Payload, Payload>;
struct Seed {
    instructions: Option<JsText>,
    input: Option<JsText>,
    history: Rc<History>,
    opaque: Rc<Opaque>,
}
impl Seed {
    fn prompt(&self) -> AgentPrompt<'_, Payload, Turn, Payload, Payload> {
        AgentPrompt {
            instructions: self.instructions.as_ref(),
            input: self.input.as_ref(),
            conversation: &self.history,
        }
    }
}
fn make_call(v: &D, opaque: &Rc<Opaque>) -> Rc<ToolCall<Payload>> {
    Rc::new(ToolCall {
        call_id: text(g(v, "callId")).clone(),
        name: text(g(v, "name")).clone(),
        args: payload(g(v, "args"), opaque),
    })
}
fn seed(argument: &D) -> Seed {
    let p = g(argument, "prompt");
    let c = g(p, "conversation");
    let opaque = Rc::new(Opaque(Cell::new(17)));
    let turns = list(g(c, "turns"))
        .iter()
        .map(|raw| {
            let mut t = AgentTurn::new(
                text(g(raw, "content")).clone(),
                list(g(raw, "toolCalls"))
                    .iter()
                    .map(|v| make_call(v, &opaque))
                    .collect(),
            );
            let D::Object(f) = raw else { unreachable!() };
            t.provider = match f.get("provider") {
                None => AgentField::Absent,
                Some(D::Object(v)) if v.contains_key("$value") => AgentField::Undefined,
                Some(v) => AgentField::Value(payload(v, &opaque)),
            };
            Rc::new(t)
        })
        .collect::<Vec<_>>();
    let records = list(g(c, "toolRecords"))
        .iter()
        .map(|raw| {
            let call = g(raw, "call");
            let id = text(g(call, "callId"));
            let original = turns
                .iter()
                .flat_map(|t| t.tool_calls.iter())
                .find(|v| v.call_id == *id)
                .cloned()
                .unwrap_or_else(|| make_call(call, &opaque));
            let value = g(raw, "outcome");
            let outcome = if text(g(value, "kind")).as_utf8() == Some("ok") {
                ToolOutcome::Ok(payload(g(value, "result"), &opaque))
            } else {
                ToolOutcome::Error(payload(value, &opaque))
            };
            Rc::new(ToolRecord {
                call: original,
                outcome: Rc::new(outcome),
                turn: demlik_tea::data::NumberOrNull(number(g(raw, "turn"))),
            })
        })
        .collect();
    Seed {
        instructions: match g(p, "instructions") {
            D::Null => None,
            v => Some(text(v).clone()),
        },
        input: match g(p, "input") {
            D::Null => None,
            v => Some(text(v).clone()),
        },
        history: Rc::new(Conversation {
            turns: Rc::new(turns),
            tool_records: Rc::new(records),
            turn_count: demlik_tea::data::NumberOrNull(number(g(c, "turnCount"))),
            awaiting: Awaiting::Llm,
            context_tokens: AgentField::Absent,
            legacy_usage: AgentField::Absent,
        }),
        opaque,
    }
}
fn call_view(call: &ToolCall<Payload>) -> D {
    o([
        ("callId", s(&call.call_id)),
        ("name", s(&call.name)),
        ("args", call.args.view.clone()),
    ])
}
fn outcome_view(outcome: &ToolOutcome<Payload, Payload>) -> D {
    match outcome {
        ToolOutcome::Ok(v) => o([("kind", s("ok")), ("result", v.view.clone())]),
        ToolOutcome::Error(v) => v.view.clone(),
    }
}
fn source_view(source: &MediaSource) -> D {
    match source {
        MediaSource::Base64 { data } => o([("type", s("base64")), ("data", s(data))]),
        MediaSource::Url { url } => o([("type", s("url")), ("url", s(url))]),
        MediaSource::Bytes { data } => o([
            ("type", s("bytes")),
            (
                "data",
                o([("$bytes", a(data.to_vec().into_iter().map(|x| n(x.into()))))]),
            ),
        ]),
    }
}
fn parts_view(parts: &Parts) -> D {
    a(parts.borrow().iter().map(|p| match p {
        ContentPart::Text(p) => o([("type", s("text")), ("text", s(&p.text))]),
        ContentPart::Image(p) => o([
            ("type", s("image")),
            ("mediaType", s(&p.media_type)),
            ("source", source_view(&p.source)),
        ]),
        ContentPart::File(p) => o([
            ("type", s("file")),
            ("mediaType", s(&p.media_type)),
            ("source", source_view(&p.source)),
        ]),
    }))
}
fn messages_view(batch: &Batch) -> D {
    a(batch.iter().map(|m| match m {
        AgentMessage::System(v) => o([("role", s("system")), ("content", s(v))]),
        AgentMessage::User(MessageContent::Text(v)) => o([("role", s("user")), ("content", s(v))]),
        AgentMessage::User(MessageContent::Parts(v)) => {
            o([("role", s("user")), ("content", parts_view(v))])
        }
        AgentMessage::Assistant(v) => {
            let mut fields = vec![
                ("role", s("assistant")),
                ("content", s(&v.content)),
                ("toolCalls", a(v.tool_calls.iter().map(|c| call_view(c)))),
            ];
            match &v.provider {
                AgentField::Absent => {}
                AgentField::Undefined => fields.push(("provider", o([("$value", s("undefined"))]))),
                AgentField::Value(p) => fields.push(("provider", p.view.clone())),
            };
            o(fields)
        }
        AgentMessage::Tool { record, parts } => {
            let mut fields = vec![
                ("role", s("tool")),
                ("callId", s(&record.call.call_id)),
                ("name", s(&record.call.name)),
                ("outcome", outcome_view(&record.outcome)),
            ];
            if let Some(p) = parts {
                fields.push(("parts", parts_view(p)))
            }
            o(fields)
        }
    }))
}
fn part(v: &str) -> ContentPart {
    ContentPart::Text(Rc::new(TextPart { text: v.into() }))
}
fn run_default(seed: &Seed, calls: &mut Vec<&'static str>) -> Batch {
    let out = render_prompt(&seed.prompt());
    calls.push("demlik_tea::agent::render_prompt");
    out
}
fn run_parts<X>(
    seed: &Seed,
    calls: &mut Vec<&'static str>,
    f: impl FnMut(&ToolCall<Payload>, &ToolOutcome<Payload, Payload>) -> Result<Option<Parts>, X>,
) -> Result<Batch, X> {
    let out = render_prompt_with(&seed.prompt(), f);
    calls.push("demlik_tea::agent::render_prompt_with");
    out
}

struct Parser(Rc<Turn>, Rc<Cell<usize>>);
impl Schema for Parser {
    type Raw = Rc<Turn>;
    type Output = Rc<Turn>;
    type Error = ();
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<()>> {
        self.1.set(self.1.get() + 1);
        assert!(Rc::ptr_eq(&raw, &self.0));
        Ok(raw)
    }
}
struct PortLoader<'a> {
    request: &'a Rc<Request<&'static str, Rc<History>>>,
    seed: &'a Seed,
    mode: &'a str,
    trace: &'a RefCell<Vec<String>>,
    receipts: &'a RefCell<D>,
    batch: RefCell<Option<Batch>>,
    calls: &'a RefCell<Vec<&'static str>>,
}
impl MessageLoader<&'static str, Rc<History>, Msg, ()> for PortLoader<'_> {
    fn load<'a>(
        &'a self,
        input: &'a Rc<Request<&'static str, Rc<History>>>,
    ) -> impl Future<Output = Result<Messages<'a, Msg>, CallValue<()>>>
    where
        Msg: 'a,
    {
        self.trace
            .borrow_mut()
            .push(format!("{}:loader", self.mode));
        put(
            &mut self.receipts.borrow_mut(),
            &format!("{}PayloadOriginal", self.mode),
            b(Rc::ptr_eq(&input.payload, &self.seed.history)),
        );
        put(
            &mut self.receipts.borrow_mut(),
            &format!("{}RequestOriginal", self.mode),
            b(Rc::ptr_eq(input, self.request)),
        );
        let batch = run_parts(self.seed, &mut self.calls.borrow_mut(), |call, _| {
            self.trace.borrow_mut().push(format!(
                "{}:parts:{}",
                self.mode,
                call.call_id.as_utf8().unwrap()
            ));
            Ok::<_, ()>(None)
        })
        .unwrap();
        self.batch.replace(Some(Rc::clone(&batch)));
        async move { Ok(Messages::Shared(batch)) }
    }
}

fn port_native(
    seed: &Seed,
    receipts: &RefCell<D>,
    trace: &RefCell<Vec<String>>,
    calls: &RefCell<Vec<&'static str>>,
) -> (D, usize) {
    let mode = "typed";
    let answer = Rc::new(AgentTurn::new("accepted".into(), vec![]));
    let parses = Rc::new(Cell::new(0));
    let parser = Rc::new(Parser(Rc::clone(&answer), Rc::clone(&parses)));
    let schema = Rc::clone(&parser);
    let llm = LlmCall::new(Config::new(move |_: &&str| Rc::clone(&schema)), |_: &()| {
        Ok("failure".into())
    });
    let request = Rc::new(Request::new("invoice", None, Rc::clone(&seed.history)));
    let loader = PortLoader {
        request: &request,
        seed,
        mode,
        trace,
        receipts,
        batch: RefCell::new(None),
        calls,
    };
    let seen = RefCell::new(D::Null);
    let model = plain_model(async |messages: Messages<'_, Msg>| {
        trace.borrow_mut().push("typed:model".into());
        let stored = loader.batch.borrow();
        let stored = stored.as_ref().unwrap();
        put(
            &mut receipts.borrow_mut(),
            "typedMessagesOriginal",
            b(std::ptr::eq(messages.as_ref(), stored.as_slice())),
        );
        let AgentMessage::Assistant(turn) = &messages.as_ref()[2] else {
            panic!("assistant")
        };
        let AgentMessage::Tool { record, .. } = &messages.as_ref()[3] else {
            panic!("tool")
        };
        put(
            &mut receipts.borrow_mut(),
            "typedProviderOriginal",
            b(match (&turn.provider, &seed.history.turns[0].provider) {
                (AgentField::Value(a), AgentField::Value(b)) => Rc::ptr_eq(a, b),
                _ => false,
            }),
        );
        put(
            &mut receipts.borrow_mut(),
            "typedToolCallsOriginal",
            b(std::ptr::eq(
                &turn.tool_calls,
                &seed.history.turns[0].tool_calls,
            )),
        );
        put(
            &mut receipts.borrow_mut(),
            "typedOutcomeOriginal",
            b(Rc::ptr_eq(
                &record.outcome,
                &seed.history.tool_records[0].outcome,
            )),
        );
        seen.replace(messages_view(stored));
        Ok::<_, CallValue<()>>(Rc::clone(&answer))
    });
    let begun = llm.attempt(&llm.init(), Rc::clone(&request), 0.0).unwrap();
    let result = futures::executor::block_on(
        brain_handler(&llm, BrainPorts::new(&model).with_loader(&loader))
            .handle(&begun.commands[0]),
    )
    .unwrap();
    let Outcome::Ok {
        value: CallValue::Shared(value),
    } = result
    else {
        panic!("port")
    };
    put(
        &mut receipts.borrow_mut(),
        "typedOutputOriginal",
        b(Rc::ptr_eq(&value.output, &answer)),
    );
    assert_eq!(parses.get(), 2);
    (seen.into_inner(), parses.get())
}
type RawHistory = Conversation<D, D, D, D, PlainCalls>;
type RawMsg = AgentMessage<D, D, D, D, PlainCalls>;
type RawBatch = PromptMessages<D, D, D, D, PlainCalls>;
struct RawPortLoader<'a> {
    request: &'a Rc<Request<&'static str, Rc<RawHistory>>>,
    history: Rc<RawHistory>,
    head: &'a Seed,
    trace: &'a RefCell<Vec<String>>,
    receipts: &'a RefCell<D>,
    batch: RefCell<Option<RawBatch>>,
    calls: &'a RefCell<Vec<&'static str>>,
}
impl MessageLoader<&'static str, Rc<RawHistory>, RawMsg, StructuredOutputError>
    for RawPortLoader<'_>
{
    fn load<'a>(
        &'a self,
        input: &'a Rc<Request<&'static str, Rc<RawHistory>>>,
    ) -> impl Future<Output = Result<Messages<'a, RawMsg>, CallValue<StructuredOutputError>>>
    where
        RawMsg: 'a,
    {
        self.trace.borrow_mut().push("guarded-raw:loader".into());
        put(
            &mut self.receipts.borrow_mut(),
            "guarded-rawPayloadOriginal",
            b(Rc::ptr_eq(&input.payload, &self.history)),
        );
        put(
            &mut self.receipts.borrow_mut(),
            "guarded-rawRequestOriginal",
            b(Rc::ptr_eq(input, self.request)),
        );
        let batch = render_prompt_with(
            &AgentPrompt {
                instructions: self.head.instructions.as_ref(),
                input: self.head.input.as_ref(),
                conversation: self.history.as_ref(),
            },
            |call: &PlainToolCall, _| {
                self.trace.borrow_mut().push(format!(
                    "guarded-raw:parts:{}",
                    call.call_id().as_utf8().unwrap()
                ));
                Ok::<_, ()>(None)
            },
        )
        .unwrap();
        self.calls
            .borrow_mut()
            .push("demlik_tea::agent::render_prompt_with");
        self.batch.replace(Some(Rc::clone(&batch)));
        async move { Ok(Messages::Shared(batch)) }
    }
}
struct RawParser(Rc<Cell<usize>>);
impl Schema for RawParser {
    type Raw = Rc<D>;
    type Output = Rc<D>;
    type Error = StructuredOutputError;
    fn parse(&self, raw: Rc<D>) -> Result<Rc<D>, CallValue<StructuredOutputError>> {
        self.0.set(self.0.get() + 1);
        AGENT_TURN_SCHEMA.parse(raw)
    }
}
fn port_raw(
    argument: &D,
    seed: &Seed,
    receipts: &RefCell<D>,
    trace: &RefCell<Vec<String>>,
    calls: &RefCell<Vec<&'static str>>,
) -> (D, usize) {
    let c = g(g(argument, "prompt"), "conversation");
    let mut original_history = true;
    let turns = list(g(c, "turns"))
        .iter()
        .map(|v| {
            let owner = Rc::new(v.clone());
            let parsed = match AGENT_TURN_SCHEMA.parse(Rc::clone(&owner)) {
                Ok(parsed) => parsed,
                Err(_) => panic!("actual raw turn guard"),
            };
            original_history &= Rc::ptr_eq(&parsed, &owner);
            owner
        })
        .collect();
    put(
        &mut receipts.borrow_mut(),
        "guardedRawHistoryOriginal",
        b(original_history),
    );
    let records = list(g(c, "toolRecords"))
        .iter()
        .map(|v| {
            let call: PlainToolCall =
                serde_json::from_str(&stringify_json(g(v, "call")).unwrap()).unwrap();
            let out = g(v, "outcome");
            let outcome = if text(g(out, "kind")).as_utf8() == Some("ok") {
                ToolOutcome::Ok(Rc::new(g(out, "result").clone()))
            } else {
                ToolOutcome::Error(Rc::new(out.clone()))
            };
            Rc::new(ToolRecordOf {
                call: Rc::new(call),
                outcome: Rc::new(outcome),
                turn: demlik_tea::data::NumberOrNull(number(g(v, "turn"))),
            })
        })
        .collect();
    let history = Rc::new(Conversation {
        turns: Rc::new(turns),
        tool_records: Rc::new(records),
        turn_count: 1.0.into(),
        awaiting: Awaiting::Llm,
        context_tokens: AgentField::Absent,
        legacy_usage: AgentField::Absent,
    });
    let original_calls = g(&history.turns[0], "toolCalls") as *const D;
    let original_provider = g(&history.turns[0], "provider") as *const D;
    let parses = Rc::new(Cell::new(0));
    let parser = Rc::new(RawParser(Rc::clone(&parses)));
    let schema = Rc::clone(&parser);
    let llm = LlmCall::new(
        Config::new(move |_: &&str| Rc::clone(&schema)),
        StructuredOutputError::describe,
    );
    let input = Rc::new(Request::new("invoice", None, Rc::clone(&history)));
    let loader = RawPortLoader {
        request: &input,
        history: Rc::clone(&history),
        head: seed,
        trace,
        receipts,
        batch: RefCell::new(None),
        calls,
    };
    let answer = Rc::new(o([("content", s("accepted")), ("toolCalls", a([]))]));
    let seen = RefCell::new(D::Null);
    let model = plain_model(async |messages: Messages<'_, RawMsg>| {
        trace.borrow_mut().push("guarded-raw:model".into());
        let stored = loader.batch.borrow();
        let stored = stored.as_ref().unwrap();
        put(
            &mut receipts.borrow_mut(),
            "guarded-rawMessagesOriginal",
            b(std::ptr::eq(messages.as_ref(), stored.as_slice())),
        );
        let mut view = vec![];
        for m in messages.as_ref() {
            view.push(match m {
                AgentMessage::System(v) => o([("role", s("system")), ("content", s(v))]),
                AgentMessage::User(MessageContent::Text(v)) => {
                    o([("role", s("user")), ("content", s(v))])
                }
                AgentMessage::Assistant(t) => {
                    let mut fields = vec![
                        ("role", s("assistant")),
                        ("content", g(t, "content").clone()),
                        ("toolCalls", g(t, "toolCalls").clone()),
                    ];
                    let D::Object(f) = t.as_ref() else {
                        panic!("object")
                    };
                    if let Some(p) = f.get("provider") {
                        fields.push(("provider", p.clone()))
                    }
                    o(fields)
                }
                AgentMessage::Tool { record, .. } => o([
                    ("role", s("tool")),
                    ("callId", s(record.call.call_id())),
                    ("name", s(record.call.name())),
                    (
                        "outcome",
                        match record.outcome.as_ref() {
                            ToolOutcome::Ok(v) => {
                                o([("kind", s("ok")), ("result", v.as_ref().clone())])
                            }
                            ToolOutcome::Error(v) => v.as_ref().clone(),
                        },
                    ),
                ]),
                _ => panic!("profile"),
            })
        }
        let AgentMessage::Assistant(t) = &messages.as_ref()[2] else {
            panic!("assistant")
        };
        put(
            &mut receipts.borrow_mut(),
            "guarded-rawToolCallsOriginal",
            b(std::ptr::eq(g(t, "toolCalls"), original_calls)),
        );
        put(
            &mut receipts.borrow_mut(),
            "guarded-rawProviderOriginal",
            b(std::ptr::eq(g(t, "provider"), original_provider)),
        );
        let AgentMessage::Tool { record, .. } = &messages.as_ref()[3] else {
            panic!("tool")
        };
        put(
            &mut receipts.borrow_mut(),
            "guarded-rawOutcomeOriginal",
            b(Rc::ptr_eq(
                &record.outcome,
                &history.tool_records[0].outcome,
            )),
        );
        seen.replace(a(view));
        Ok::<_, CallValue<StructuredOutputError>>(Rc::clone(&answer))
    });
    let begun = llm.attempt(&llm.init(), Rc::clone(&input), 0.0).unwrap();
    let result = futures::executor::block_on(
        brain_handler(&llm, BrainPorts::new(&model).with_loader(&loader))
            .handle(&begun.commands[0]),
    )
    .unwrap();
    let Outcome::Ok {
        value: CallValue::Shared(value),
    } = result
    else {
        panic!("raw port")
    };
    put(
        &mut receipts.borrow_mut(),
        "guarded-rawOutputOriginal",
        b(Rc::ptr_eq(&value.output, &answer)),
    );
    assert_eq!(parses.get(), 2);
    (seen.into_inner(), parses.get())
}

fn main() {
    let request = decode_json(
        &std::fs::read_to_string(std::env::args().nth(1).expect("request file")).unwrap(),
    )
    .unwrap();
    let id = text(g(&request, "id")).as_utf8().unwrap();
    let arguments = list(g(&request, "arguments"));
    let original = seed(&arguments[0]);
    let mut calls = vec![];
    let mut trace = vec![];
    let mut receipts = o([] as [(&str, D); 0]);
    let mut error = D::Null;
    let mut after = D::Null;
    let messages = match id {
        "empty.fresh-array" => {
            let first = run_default(&original, &mut calls);
            let second = run_default(&original, &mut calls);
            put(
                &mut receipts,
                "sameReturnedArray",
                b(Rc::ptr_eq(&first, &second)),
            );
            messages_view(&first)
        }
        "head.null-versus-empty" => {
            let first = run_default(&original, &mut calls);
            let second = run_default(&seed(&arguments[1]), &mut calls);
            o([
                ("absent", messages_view(&first)),
                ("empty", messages_view(&second)),
            ])
        }
        "head.instructions-only" => messages_view(&run_default(&original, &mut calls)),
        "head.input-utf16" => {
            put(
                &mut receipts,
                "contentUnits",
                a(original
                    .input
                    .as_ref()
                    .unwrap()
                    .as_units()
                    .iter()
                    .map(|x| n((*x).into()))),
            );
            messages_view(&run_default(&original, &mut calls))
        }
        "history.plan-act-order"
        | "records.duplicates-orphans"
        | "indices.exact-number"
        | "indices.raw-null" => {
            let batch = run_parts(&original, &mut calls, |c, _| {
                trace.push(c.call_id.as_utf8().unwrap().to_owned());
                Ok::<_, ()>(None)
            })
            .unwrap();
            messages_view(&batch)
        }
        "provider.presence" => {
            let batch = run_default(&original, &mut calls);
            put(&mut receipts,"providerOwn",a(batch.iter().map(|m|b(matches!(m,AgentMessage::Assistant(t)if !matches!(t.provider,AgentField::Absent))))));
            let AgentMessage::Assistant(t) = &batch[3] else {
                panic!("turn")
            };
            put(
                &mut receipts,
                "opaqueProviderOriginal",
                b(match &t.provider {
                    AgentField::Value(p) => p
                        .opaque
                        .as_ref()
                        .is_some_and(|p| Rc::ptr_eq(p, &original.opaque)),
                    _ => false,
                }),
            );
            messages_view(&batch)
        }
        "owners.original-handles" => {
            let batch = run_parts(&original, &mut calls, |c, out| {
                let key = c.call_id.as_utf8().unwrap();
                trace.push(key.to_owned());
                let index = usize::from(key == "check");
                put(
                    &mut receipts,
                    &format!("{key}CallbackCallOriginal"),
                    b(std::ptr::eq(
                        c,
                        original.history.tool_records[index].call.as_ref(),
                    )),
                );
                put(
                    &mut receipts,
                    &format!("{key}CallbackOutcomeOriginal"),
                    b(std::ptr::eq(
                        out,
                        original.history.tool_records[index].outcome.as_ref(),
                    )),
                );
                Ok::<_, ()>(None)
            })
            .unwrap();
            let AgentMessage::Assistant(t) = &batch[0] else {
                panic!("turn")
            };
            let AgentMessage::Tool { record: r, .. } = &batch[1] else {
                panic!("read")
            };
            let AgentMessage::Tool { record: e, .. } = &batch[2] else {
                panic!("check")
            };
            put(
                &mut receipts,
                "originalToolCallsArray",
                b(std::ptr::eq(
                    &t.tool_calls,
                    &original.history.turns[0].tool_calls,
                )),
            );
            put(
                &mut receipts,
                "originalArgs",
                b(t.tool_calls[0]
                    .args
                    .opaque
                    .as_ref()
                    .is_some_and(|p| Rc::ptr_eq(p, &original.opaque))),
            );
            put(
                &mut receipts,
                "originalOutcome",
                b(
                    Rc::ptr_eq(&r.outcome, &original.history.tool_records[0].outcome)
                        && Rc::ptr_eq(&e.outcome, &original.history.tool_records[1].outcome),
                ),
            );
            put(
                &mut receipts,
                "originalResult",
                b(
                    matches!(r.outcome.as_ref(),ToolOutcome::Ok(p)if p.opaque.as_ref().is_some_and(|v|Rc::ptr_eq(v,&original.opaque))),
                ),
            );
            put(
                &mut receipts,
                "originalError",
                b(
                    matches!(e.outcome.as_ref(),ToolOutcome::Error(p)if p.opaque.as_ref().is_some_and(|v|Rc::ptr_eq(v,&original.opaque))),
                ),
            );
            messages_view(&batch)
        }
        "parts.null-versus-empty" => {
            let shared: Parts = Rc::new(RefCell::new(vec![]));
            let batch = run_parts(&original, &mut calls, |c, _| {
                trace.push(c.call_id.as_utf8().unwrap().to_owned());
                Ok::<_, ()>(if c.call_id.as_utf8() == Some("none") {
                    None
                } else {
                    Some(Rc::clone(&shared))
                })
            })
            .unwrap();
            put(
                &mut receipts,
                "partsOwn",
                a(batch.iter().filter_map(|m| {
                    if let AgentMessage::Tool { parts, .. } = m {
                        Some(b(parts.is_some()))
                    } else {
                        None
                    }
                })),
            );
            put(
                &mut receipts,
                "emptyOriginal",
                b(matches!(&batch[2],AgentMessage::Tool{parts:Some(p),..}if Rc::ptr_eq(p,&shared))),
            );
            messages_view(&batch)
        }
        "parts.media-original" => {
            let bytes = MediaBytes::new(vec![1, 2, 3]);
            let view = bytes.view(1..3).unwrap();
            let source = Rc::new(MediaSource::Bytes { data: view.clone() });
            let parts = vec![
                part("invoice"),
                ContentPart::Image(Rc::new(ImagePart {
                    media_type: "image/png".into(),
                    source: Rc::clone(&source),
                })),
                ContentPart::File(Rc::new(FilePart {
                    media_type: "application/pdf".into(),
                    source: Rc::new(MediaSource::Url {
                        url: "invoice.pdf".into(),
                    }),
                })),
            ];
            let shared: Parts = Rc::new(RefCell::new(parts.clone()));
            let batch = run_parts(&original, &mut calls, |_, _| {
                Ok::<_, ()>(Some(Rc::clone(&shared)))
            })
            .unwrap();
            let AgentMessage::Tool {
                parts: Some(actual),
                ..
            } = &batch[1]
            else {
                panic!("parts")
            };
            put(
                &mut receipts,
                "partsOwnerOriginal",
                b(Rc::ptr_eq(actual, &shared)),
            );
            put(
                &mut receipts,
                "partOwnersOriginal",
                b(actual
                    .borrow()
                    .iter()
                    .zip(&parts)
                    .all(|(a, b)| a.same_identity(b))),
            );
            put(
                &mut receipts,
                "mediaSourceOriginal",
                b(
                    matches!(&actual.borrow()[1],ContentPart::Image(p)if Rc::ptr_eq(&p.source,&source)),
                ),
            );
            bytes.set(1, 9).unwrap();
            put(
                &mut receipts,
                "mediaBufferShared",
                b(view.get(0).unwrap() == 9),
            );
            after = parts_view(actual);
            messages_view(&batch)
        }
        "parts.error-callback" => {
            let shared: Parts = Rc::new(RefCell::new(vec![part("error explanation")]));
            let batch = run_parts(&original, &mut calls, |_, v| {
                trace.push(
                    match v {
                        ToolOutcome::Ok(_) => "ok",
                        ToolOutcome::Error(_) => "error",
                    }
                    .to_owned(),
                );
                Ok::<_, ()>(Some(Rc::clone(&shared)))
            })
            .unwrap();
            let AgentMessage::Tool { record, parts } = &batch[1] else {
                panic!("tool")
            };
            put(
                &mut receipts,
                "outcomeOriginal",
                b(Rc::ptr_eq(
                    &record.outcome,
                    &original.history.tool_records[0].outcome,
                )),
            );
            put(
                &mut receipts,
                "partsOriginal",
                b(parts.as_ref().is_some_and(|p| Rc::ptr_eq(p, &shared))),
            );
            messages_view(&batch)
        }
        "parts.failure-prefix" => {
            let cause = Rc::new(PartsFailure {
                name: "Error".into(),
                message: "parts-original".into(),
            });
            let result = run_parts(&original, &mut calls, |c, _| {
                let key = c.call_id.as_utf8().unwrap();
                trace.push(key.to_owned());
                if key == "second" {
                    Err(Rc::clone(&cause))
                } else {
                    Ok(None)
                }
            });
            match result {
                Err(actual) => {
                    error = o([
                        ("originalCause", b(Rc::ptr_eq(&actual, &cause))),
                        ("name", s(&actual.name)),
                        ("message", s(&actual.message)),
                    ])
                }
                Ok(_) => panic!("parts failure"),
            };
            D::Null
        }
        "history.turn-count-ignored" => {
            let first = messages_view(&run_default(&original, &mut calls));
            let second = messages_view(&run_default(&seed(&arguments[1]), &mut calls));
            put(
                &mut receipts,
                "sameMessages",
                b(stringify_json(&first) == stringify_json(&second)),
            );
            o([("first", first), ("second", second)])
        }
        "render.repeat-no-cache" => {
            let mut render = || {
                run_parts(&original, &mut calls, |c, _| {
                    trace.push(c.call_id.as_utf8().unwrap().to_owned());
                    Ok::<_, ()>(None)
                })
                .unwrap()
            };
            let first = render();
            let second = render();
            put(
                &mut receipts,
                "sameReturnedArray",
                b(Rc::ptr_eq(&first, &second)),
            );
            put(
                &mut receipts,
                "sameAssistantWrapper",
                b(std::ptr::eq(&first[0], &second[0])),
            );
            put(
                &mut receipts,
                "originalToolCallsBoth",
                b(
                    matches!((&first[0],&second[0]),(AgentMessage::Assistant(a),AgentMessage::Assistant(b))if std::ptr::eq(&a.tool_calls,&original.history.turns[0].tool_calls)&&std::ptr::eq(&b.tool_calls,&original.history.turns[0].tool_calls)),
                ),
            );
            o([
                ("first", messages_view(&first)),
                ("second", messages_view(&second)),
            ])
        }
        "parts.mutate-after-render" => {
            let first = part("first");
            let shared: Parts = Rc::new(RefCell::new(vec![first.clone()]));
            let batch = run_parts(&original, &mut calls, |c, _| {
                trace.push(c.call_id.as_utf8().unwrap().to_owned());
                if c.call_id.as_utf8() == Some("two") {
                    shared.borrow_mut().push(part("during callback"));
                }
                Ok::<_, ()>(Some(Rc::clone(&shared)))
            })
            .unwrap();
            let before = messages_view(&batch);
            let AgentMessage::Tool { parts: Some(p), .. } = &batch[1] else {
                panic!("parts")
            };
            put(&mut receipts, "partsOriginal", b(Rc::ptr_eq(p, &shared)));
            put(
                &mut receipts,
                "secondCallbackMutationVisible",
                b(p.borrow().len() == 2),
            );
            shared.borrow_mut().push(part("after render"));
            after = messages_view(&batch);
            put(
                &mut receipts,
                "afterRenderMutationVisible",
                b(p.borrow().len() == 3),
            );
            put(
                &mut receipts,
                "originalPartOwner",
                b(p.borrow()[0].same_identity(&first)),
            );
            before
        }
        "port.invoice-native-and-raw" => {
            let shared_receipts = RefCell::new(o([] as [(&str, D); 0]));
            let shared_trace = RefCell::new(vec![]);
            let shared_calls = RefCell::new(vec![]);
            let (native, native_parses) =
                port_native(&original, &shared_receipts, &shared_trace, &shared_calls);
            let (raw, raw_parses) = port_raw(
                &arguments[1],
                &original,
                &shared_receipts,
                &shared_trace,
                &shared_calls,
            );
            receipts = shared_receipts.into_inner();
            put(&mut receipts, "parses", n(native_parses + raw_parses));
            put(
                &mut receipts,
                "modelInvokes",
                n(shared_trace
                    .borrow()
                    .iter()
                    .filter(|x| x.ends_with(":model"))
                    .count()),
            );
            trace = shared_trace.into_inner();
            calls.extend(shared_calls.into_inner());
            a([native, raw])
        }
        _ => panic!("unknown id"),
    };
    let view = o([
        ("messages", messages),
        ("receipts", receipts),
        ("trace", a(trace.into_iter().map(s))),
        ("error", error),
        ("after", after),
    ]);
    let output = o([
        ("id", s(id)),
        ("ok", b(true)),
        ("view", view),
        ("observedCalls", a(calls.into_iter().map(s))),
    ]);
    println!("{}", stringify_json(&output).unwrap());
}
