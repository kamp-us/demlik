use demlik_tea::{
    PlainData,
    agent::{
        AgentMessage, AgentPrompt, PlainCalls, PromptMessages, StructuredOutputError,
        content::{ContentPart, Parts, TextPart},
        model::{BrainPorts, MessageLoader, Messages, brain_handler, plain_model},
        render_prompt, render_prompt_with,
        types::{
            AGENT_TURN_SCHEMA, AgentField, AgentTurn, Awaiting, Conversation, ToolCall,
            ToolOutcome, ToolRecord,
        },
    },
    command::Outcome,
    data::{JsText, decode_json},
    llm_call::{CauseField, Config, LlmCall, Request, Schema},
    resilience::resilient_call::CallValue,
};
use std::{
    cell::{Cell, RefCell},
    future::Future,
    rc::Rc,
};

struct Opaque<'a> {
    text: &'a str,
    local: Rc<Cell<usize>>,
    read: Box<dyn Fn() -> usize + 'a>,
}
struct RawArgs<'a>(&'a str);
struct ParsedArgs<'a>(&'a str);
type Turn<'a> = AgentTurn<RawArgs<'a>, Opaque<'a>>;
type History<'a> = Conversation<Opaque<'a>, Turn<'a>, Opaque<'a>, RawArgs<'a>>;
type Message<'a> = AgentMessage<Opaque<'a>, Turn<'a>, Opaque<'a>, RawArgs<'a>>;
type Batch<'a> = PromptMessages<Opaque<'a>, Turn<'a>, Opaque<'a>, RawArgs<'a>>;
type PromptRequest<'a> = Request<&'static str, Rc<History<'a>>>;
struct Parser<'a>(Rc<Turn<'a>>);
impl<'a> Schema for Parser<'a> {
    type Raw = Rc<Turn<'a>>;
    type Output = Rc<Turn<'a>>;
    type Error = Opaque<'a>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        assert!(Rc::ptr_eq(&raw, &self.0));
        Ok(raw)
    }
}
struct Loader<'a> {
    head: JsText,
    shared: Parts,
    cause: Rc<Opaque<'a>>,
    fail: Cell<bool>,
    starts: Cell<usize>,
    batch: RefCell<Option<Batch<'a>>>,
    calls: RefCell<Vec<Rc<PromptRequest<'a>>>>,
}
impl<'cfg> MessageLoader<&'static str, Rc<History<'cfg>>, Message<'cfg>, Opaque<'cfg>>
    for Loader<'cfg>
{
    fn load<'a>(
        &'a self,
        call: &'a Rc<Request<&'static str, Rc<History<'cfg>>>>,
    ) -> impl Future<Output = Result<Messages<'a, Message<'cfg>>, CallValue<Opaque<'cfg>>>>
    where
        Message<'cfg>: 'a,
    {
        self.starts.set(self.starts.get() + 1);
        self.calls.borrow_mut().push(Rc::clone(call));
        let mut visited = 0;
        let rendered = render_prompt_with(
            &AgentPrompt {
                instructions: Some(&self.head),
                input: None,
                conversation: &call.payload,
            },
            |_, _| {
                visited += 1;
                if self.fail.get() {
                    return Err(Rc::clone(&self.cause));
                }
                if visited == 2 {
                    self.shared
                        .borrow_mut()
                        .push(ContentPart::Text(Rc::new(TextPart {
                            text: "during callback".into(),
                        })));
                }
                Ok(Some(Rc::clone(&self.shared)))
            },
        );
        if let Ok(batch) = &rendered {
            self.batch.replace(Some(Rc::clone(batch)));
        }
        async move { rendered.map(Messages::Shared).map_err(CallValue::Shared) }
    }
}
type RawHistory = Conversation<PlainData, PlainData, PlainData, PlainData, PlainCalls>;
type RawMessage = AgentMessage<PlainData, PlainData, PlainData, PlainData, PlainCalls>;
struct RawLoader;
impl MessageLoader<&'static str, Rc<RawHistory>, RawMessage, StructuredOutputError> for RawLoader {
    fn load<'a>(
        &'a self,
        call: &'a Rc<Request<&'static str, Rc<RawHistory>>>,
    ) -> impl Future<Output = Result<Messages<'a, RawMessage>, CallValue<StructuredOutputError>>>
    where
        RawMessage: 'a,
    {
        let batch = render_prompt(&AgentPrompt {
            instructions: None,
            input: None,
            conversation: &call.payload,
        });
        async move { Ok(Messages::Shared(batch)) }
    }
}
fn main() {
    let text = String::from("borrowed nonserializable invoice");
    let tick = Cell::new(17);
    let make = || {
        Rc::new(Opaque {
            text: &text,
            local: Rc::new(Cell::new(0)),
            read: Box::new(|| tick.get()),
        })
    };
    let provider = make();
    let result = make();
    let cause = make();
    let raw = Rc::new(RawArgs(&text));
    let parsed = ParsedArgs(&text);
    assert_eq!(parsed.0, raw.0);
    let call = Rc::new(ToolCall {
        call_id: "read".into(),
        name: "invoice".into(),
        args: Rc::clone(&raw),
    });
    let mut t = AgentTurn::new("plan".into(), vec![Rc::clone(&call)]);
    t.provider = AgentField::Value(Rc::clone(&provider));
    let t = Rc::new(t);
    let outcome = Rc::new(ToolOutcome::Ok(Rc::clone(&result)));
    let record = Rc::new(ToolRecord {
        call: Rc::clone(&call),
        outcome: Rc::clone(&outcome),
        turn: 0.0.into(),
    });
    let failed = Rc::new(ToolRecord {
        call: Rc::clone(&call),
        outcome: Rc::new(ToolOutcome::Error(Rc::clone(&cause))),
        turn: (-0.0).into(),
    });
    let history = Rc::new(Conversation {
        turns: Rc::new(vec![Rc::clone(&t)]),
        tool_records: Rc::new(vec![Rc::clone(&record), Rc::clone(&failed)]),
        turn_count: 1.0.into(),
        awaiting: Awaiting::Llm,
        context_tokens: AgentField::Absent,
        legacy_usage: AgentField::Absent,
    });
    let empty_parts: Parts = Rc::new(RefCell::new(vec![]));
    let batch = {
        let p = AgentPrompt {
            instructions: None,
            input: None,
            conversation: history.as_ref(),
        };
        render_prompt_with(&p, |_, _| {
            Ok::<_, Rc<Opaque<'_>>>(Some(Rc::clone(&empty_parts)))
        })
    };
    let batch = match batch {
        Ok(v) => v,
        Err(_) => panic!("parts should succeed"),
    };
    let AgentMessage::Assistant(turn) = &batch[0] else {
        panic!("assistant")
    };
    assert!(Rc::ptr_eq(turn, &t));
    assert!(std::ptr::eq(&turn.tool_calls, &t.tool_calls));
    let AgentMessage::Tool {
        record: held,
        parts: Some(parts),
    } = &batch[1]
    else {
        panic!("original tool")
    };
    assert!(
        Rc::ptr_eq(held, &record)
            && Rc::ptr_eq(&held.outcome, &outcome)
            && Rc::ptr_eq(parts, &empty_parts)
    );
    assert!(parts.borrow().is_empty());
    drop(history);
    assert!(Rc::ptr_eq(held, &record));
    assert_eq!(turn.content.as_utf8(), Some("plan"));
    let history = Rc::new(Conversation {
        turns: Rc::new(vec![Rc::clone(&t)]),
        tool_records: Rc::new(vec![record, failed]),
        turn_count: 1.0.into(),
        awaiting: Awaiting::Llm,
        context_tokens: AgentField::Absent,
        legacy_usage: AgentField::Absent,
    });
    let loader = Loader {
        head: "".into(),
        shared: Rc::clone(&empty_parts),
        cause: Rc::clone(&cause),
        fail: Cell::new(false),
        starts: Cell::new(0),
        batch: RefCell::new(None),
        calls: RefCell::new(vec![]),
    };
    let request = Rc::new(Request::new("invoice", None, Rc::clone(&history)));
    let before = loader.load(&request);
    assert_eq!(loader.starts.get(), 1);
    let loaded = match futures::executor::block_on(before) {
        Ok(v) => v,
        Err(_) => panic!("messages"),
    };
    assert!(Rc::ptr_eq(&loader.calls.borrow()[0], &request));
    assert!(std::ptr::eq(
        loaded.as_ref(),
        loader.batch.borrow().as_ref().unwrap().as_slice()
    ));
    assert_eq!(empty_parts.borrow().len(), 1);
    drop(loaded);
    let parser = Rc::new(Parser(Rc::clone(&t)));
    let schema = Rc::clone(&parser);
    let llm = LlmCall::new(
        Config::new(move |_: &&str| Rc::clone(&schema)),
        |_: &Opaque<'_>| Ok("original opaque".into()),
    );
    let model_calls = Cell::new(0);
    let model = plain_model(async |messages: Messages<'_, Message<'_>>| {
        model_calls.set(model_calls.get() + 1);
        assert!(matches!(messages.as_ref()[0], AgentMessage::System(_)));
        Ok::<_, CallValue<Opaque<'_>>>(Rc::clone(&t))
    });
    let started = llm.attempt(&llm.init(), Rc::clone(&request), 0.0).unwrap();
    let handler = brain_handler(&llm, BrainPorts::new(&model).with_loader(&loader));
    match futures::executor::block_on(handler.handle(&started.commands[0])).unwrap() {
        Outcome::Ok {
            value: CallValue::Shared(value),
        } => assert!(Rc::ptr_eq(&value.output, &t)),
        _ => panic!("original output"),
    };
    loader.fail.set(true);
    match futures::executor::block_on(handler.handle(&started.commands[0])).unwrap() {
        Outcome::Err { error } => match error.details.cause() {
            CauseField::Own(CallValue::Shared(original)) => assert!(Rc::ptr_eq(original, &cause)),
            _ => panic!("original cause"),
        },
        _ => panic!("parts refusal"),
    };
    assert_eq!(model_calls.get(), 1);
    assert_eq!(cause.text, text);
    assert_eq!((cause.read)(), 17);
    assert_eq!(cause.local.get(), 0);

    let raw=Rc::new(decode_json(r#"{"content":"raw","toolCalls":[{"callId":"read","name":"invoice","args":{"invoice":"inv-17"}}],"provider":null,"usage":{"inputTokens":1,"outputTokens":2}}"#).unwrap());
    let guarded = match AGENT_TURN_SCHEMA.parse(Rc::clone(&raw)) {
        Ok(v) => v,
        Err(_) => panic!("actual builtin guard"),
    };
    assert!(Rc::ptr_eq(&guarded, &raw));
    let original_calls = if let PlainData::Object(fields) = raw.as_ref() {
        &fields["toolCalls"] as *const PlainData
    } else {
        panic!("raw object")
    };
    let history: Rc<RawHistory> = Rc::new(Conversation {
        turns: Rc::new(vec![Rc::clone(&guarded)]),
        tool_records: Rc::new(vec![]),
        turn_count: 1.0.into(),
        awaiting: Awaiting::Llm,
        context_tokens: AgentField::Absent,
        legacy_usage: AgentField::Absent,
    });
    let schema = Rc::new(AGENT_TURN_SCHEMA);
    let raw_llm = LlmCall::new(
        Config::new(move |_: &&str| Rc::clone(&schema)),
        StructuredOutputError::describe,
    );
    let raw_model = plain_model(async |messages: Messages<'_, RawMessage>| {
        let AgentMessage::Assistant(turn) = &messages.as_ref()[0] else {
            panic!("raw assistant")
        };
        assert!(Rc::ptr_eq(turn, &raw));
        let PlainData::Object(fields) = turn.as_ref() else {
            panic!("raw fields")
        };
        assert!(std::ptr::eq(&fields["toolCalls"], original_calls));
        assert!(matches!(fields.get("provider"), Some(PlainData::Null)));
        Ok::<_, CallValue<StructuredOutputError>>(Rc::clone(&raw))
    });
    let input = Rc::new(Request::new("invoice", None, history));
    let started = raw_llm.attempt(&raw_llm.init(), input, 0.0).unwrap();
    match futures::executor::block_on(
        brain_handler(
            &raw_llm,
            BrainPorts::new(&raw_model).with_loader(&RawLoader),
        )
        .handle(&started.commands[0]),
    )
    .unwrap()
    {
        Outcome::Ok {
            value: CallValue::Shared(value),
        } => assert!(Rc::ptr_eq(&value.output, &raw)),
        _ => panic!("raw guard output"),
    };
    println!(
        "native/raw fixed-M ports; borrowed opaque owners, original parts/outcome/cause/schema, fresh retained message batch: passed"
    );
}
