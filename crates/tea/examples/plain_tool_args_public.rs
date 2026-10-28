//! Default guarded calls route through the original args cursor, not a copied turn.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, AgentMachineMsg, PlainToolArgs, PlainToolCall, StructuredOutputError,
        content::{ContentPart, Parts, TextPart},
        create_agent,
        model::{Messages, NoMessages, plain_model},
        tool::{self, ErrorFamily, Raised, ToolContext, ToolDefinition, ToolSpec},
        types::{AGENT_TURN_SCHEMA, ToolOutcome},
    },
    command::{CommandFamily, Failure, Issue, Outcome, SchemaError},
    data::{JsText, decode_json},
    llm_call::{self, LlmCall, Schema},
    resilience::resilient_call::CallValue,
    runtime::{self, Options, Profile},
    timing::TokioTimer,
};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    marker::PhantomData,
    rc::{Rc, Weak},
};
demlik_tea::tool_router! { mod invoice { Collect(collect), Check(check) } }
demlik_tea::tool_router! { mod empty {} }

#[derive(Default)]
struct Trace {
    expected: RefCell<Option<Weak<PlainToolCall>>>,
    calls: Cell<usize>,
    retained: RefCell<Vec<Weak<PlainToolArgs>>>,
}
impl Trace {
    fn read(&self, raw: &Rc<PlainToolArgs>) {
        let expected = self.expected.borrow().as_ref().unwrap().upgrade().unwrap();
        assert!(
            Rc::ptr_eq(raw.call(), &expected),
            "plain-original-call-owner"
        );
        assert!(
            std::ptr::eq(raw.value(), expected.args()),
            "plain-original-args-value"
        );
        self.calls.set(self.calls.get() + 1);
        self.retained.borrow_mut().push(Rc::downgrade(raw));
    }
}
struct GuardInput(Rc<Trace>);
impl Schema for GuardInput {
    type Raw = Rc<PlainToolArgs>;
    type Output = Rc<PlainToolArgs>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<SchemaError>> {
        self.0.read(&raw);
        let PlainData::Object(fields) = raw.value() else {
            return Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                "", "object",
            )])));
        };
        if !matches!(fields.get("file"), Some(PlainData::String(_))) {
            return Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                "file", "string",
            )])));
        }
        Ok(raw)
    }
}
struct CheckInput<'a> {
    file: JsText,
    expected: f64,
    label: &'a str,
}
struct ObjectInput<'a> {
    trace: Rc<Trace>,
    label: &'a str,
}
impl<'a> Schema for ObjectInput<'a> {
    type Raw = Rc<PlainToolArgs>;
    type Output = Rc<CheckInput<'a>>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<SchemaError>> {
        self.trace.read(&raw);
        let PlainData::Object(fields) = raw.value() else {
            return Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                "", "object",
            )])));
        };
        let (Some(PlainData::String(file)), Some(PlainData::Number(expected))) =
            (fields.get("file"), fields.get("expected"))
        else {
            return Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                "",
                "file and expected",
            )])));
        };
        Ok(Rc::new(CheckInput {
            file: file.clone(),
            expected: *expected,
            label: self.label,
        }))
    }
}
struct Identity<T>(PhantomData<fn() -> T>);
impl<T> Schema for Identity<T> {
    type Raw = Rc<T>;
    type Output = Rc<T>;
    type Error = SchemaError;
    fn parse(&self, raw: Rc<T>) -> Result<Rc<T>, CallValue<SchemaError>> {
        Ok(raw)
    }
}
struct Value<'a> {
    label: &'a str,
    marker: Rc<Cell<usize>>,
    parts: Parts,
}
struct Cause<'a> {
    label: &'a str,
    marker: Rc<Cell<usize>>,
}
struct Denied<'a>(Rc<Cause<'a>>);
impl Tagged for Denied<'_> {
    fn tag(&self) -> &str {
        "denied"
    }
}
struct Host<'a> {
    result: Rc<Value<'a>>,
    denied: Rc<Denied<'a>>,
    fail: bool,
    trace: Rc<Trace>,
    handlers: Cell<usize>,
}
fn family<'a>() -> ErrorFamily<'a, Denied<'a>> {
    ErrorFamily::new(["denied"], |error: &Denied<'a>| {
        Ok(PlainData::Object(
            [
                ("_tag".into(), PlainData::String("denied".into())),
                (
                    "code".into(),
                    PlainData::Number(error.0.marker.get() as f64),
                ),
            ]
            .into_iter()
            .collect(),
        ))
    })
}
fn collect_definition<'a>(
    trace: Rc<Trace>,
) -> Rc<
    impl ToolDefinition<
        RawArgs = PlainToolArgs,
        Args = PlainToolArgs,
        RawResult = Rc<Value<'a>>,
        Ok = Value<'a>,
        Error = Denied<'a>,
        Thrown = (),
        Host = Host<'a>,
        ContentError = std::convert::Infallible,
    > + 'a,
> {
    tool::tool(
        "collect_invoice",
        ToolSpec::new(
            Rc::new(GuardInput(trace)),
            Rc::new(Identity::<Value<'a>>(PhantomData)),
            family(),
        )
        .content(|value| Rc::clone(&value.parts))
        .raised::<()>(),
        |args: &Rc<PlainToolArgs>, ctx: ToolContext<'_, Host<'a>>| {
            Box::pin(async move {
                let expected = ctx
                    .host
                    .trace
                    .expected
                    .borrow()
                    .as_ref()
                    .unwrap()
                    .upgrade()
                    .unwrap();
                assert!(
                    Rc::ptr_eq(args.call(), &expected),
                    "plain-handler-original-call"
                );
                assert!(
                    std::ptr::eq(args.value(), expected.args()),
                    "plain-handler-original-args"
                );
                assert!(
                    ctx.host
                        .trace
                        .retained
                        .borrow()
                        .iter()
                        .any(|weak| weak.upgrade().is_some_and(|value| Rc::ptr_eq(&value, args))),
                    "custom-schema-retains-cursor"
                );
                ctx.host.handlers.set(ctx.host.handlers.get() + 1);
                if ctx.host.fail {
                    Err(Raised::Declared(Rc::clone(&ctx.host.denied)))
                } else {
                    Ok(Outcome::ok(Rc::clone(&ctx.host.result)))
                }
            })
        },
    )
    .unwrap()
}
fn check_definition<'a>(
    trace: Rc<Trace>,
    label: &'a str,
) -> Rc<
    impl ToolDefinition<
        RawArgs = PlainToolArgs,
        Args = CheckInput<'a>,
        RawResult = Rc<Value<'a>>,
        Ok = Value<'a>,
        Error = Denied<'a>,
        Thrown = (),
        Host = Host<'a>,
        ContentError = std::convert::Infallible,
    > + 'a,
> {
    tool::tool(
        "check_invoice",
        ToolSpec::new(
            Rc::new(ObjectInput { trace, label }),
            Rc::new(Identity::<Value<'a>>(PhantomData)),
            family(),
        )
        .content(|value| Rc::clone(&value.parts))
        .raised::<()>(),
        |args: &Rc<CheckInput<'a>>, ctx: ToolContext<'_, Host<'a>>| {
            Box::pin(async move {
                assert_eq!(args.file.as_utf8(), Some("invoice.json"));
                assert_eq!(args.expected, 17.0);
                assert_eq!(args.label, ctx.host.result.label);
                ctx.host.handlers.set(ctx.host.handlers.get() + 1);
                Ok(Outcome::ok(Rc::clone(&ctx.host.result)))
            })
        },
    )
    .unwrap()
}
fn raw(name: &str) -> Rc<PlainData> {
    Rc::new(decode_json(&format!(r#"{{"content":"invoice","toolCalls":[{{"callId":"invoice-17","name":"{name}","args":{{"file":"invoice.json","expected":17,"unknownArgs":{{"keep":true}}}},"unknownCall":[1]}}],"provider":{{"token":"original"}},"unknownTurn":[1,null]}}"#)).unwrap())
}
fn host<'a>(label: &'a str, trace: Rc<Trace>, fail: bool) -> Rc<Host<'a>> {
    let marker = Rc::new(Cell::new(17));
    Rc::new(Host {
        result: Rc::new(Value {
            label,
            marker: Rc::clone(&marker),
            parts: Rc::new(RefCell::new(vec![ContentPart::Text(Rc::new(TextPart {
                text: "invoice parts".into(),
            }))])),
        }),
        denied: Rc::new(Denied(Rc::new(Cause { label, marker }))),
        fail,
        trace,
        handlers: Cell::new(0),
    })
}
fn retained_cursor() {
    let call=Rc::new(serde_json::from_str::<PlainToolCall>(r#"{"callId":"drop","name":"collect_invoice","args":{"file":"invoice.json","extra":17}}"#).unwrap());
    let weak_root = Rc::downgrade(call.owner());
    let weak_call = Rc::downgrade(&call);
    let address = std::ptr::from_ref(call.args());
    let retained = call.args_owner();
    drop(call);
    assert!(
        weak_root.upgrade().is_some() && weak_call.upgrade().is_some(),
        "args-alone-retains-parent"
    );
    assert!(
        std::ptr::eq(retained.value(), address),
        "args-alone-original-address"
    );
    drop(retained);
    assert!(
        weak_root.upgrade().is_none() && weak_call.upgrade().is_none(),
        "args-drop-releases-parent"
    );
}
fn rejections() {
    let trace = Rc::new(Trace::default());
    let router = invoice::Router::new(
        collect_definition(Rc::clone(&trace)),
        check_definition(Rc::clone(&trace), "rejections"),
    )
    .unwrap();
    let services = host("rejections", Rc::clone(&trace), false);
    for (name, expected_tag) in [
        ("unknown_invoice", "unknown_tool"),
        ("collect_invoice", "malformed_args"),
    ] {
        let call = Rc::new(
            serde_json::from_str::<PlainToolCall>(&format!(
                r#"{{"callId":"rejected","name":"{name}","args":{{"extra":true}}}}"#
            ))
            .unwrap(),
        );
        trace.expected.replace(Some(Rc::downgrade(&call)));
        let command = router.tool_of_plain(&call).unwrap();
        let invoice::Commands::Rejected(rejected) = &command else {
            panic!("plain-schema-refusal-routes-rejection")
        };
        assert_eq!(rejected.input().error.tag(), expected_tag);
        if expected_tag == "unknown_tool" {
            assert_eq!(trace.calls.get(), 0, "unknown-before-args-parse");
            let empty = empty::Router::new().unwrap();
            assert_eq!(empty.tool_of_plain(&call).unwrap().tag(), "tool_rejected");
        }
        let completion = futures::executor::block_on(
            router.interpret(&command, ToolContext::bare(services.as_ref())),
        )
        .unwrap();
        let message = command.settle(completion, 19.5).unwrap().pop().unwrap();
        let settled = router.outcome_of(&message).unwrap().unwrap();
        assert!(matches!(settled.outcome, ToolOutcome::Error(_)));
        assert_eq!(services.handlers.get(), 0, "refusals-run-no-tool-handler");
    }
    assert_eq!(trace.calls.get(), 1);
}
fn borrowed(label: &str) {
    let trace = Rc::new(Trace::default());
    let router = Rc::new(
        invoice::Router::new(
            collect_definition(Rc::clone(&trace)),
            check_definition(Rc::clone(&trace), label),
        )
        .unwrap(),
    );
    let services = host(label, Rc::clone(&trace), true);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &&str| Rc::new(AGENT_TURN_SCHEMA)),
        StructuredOutputError::describe,
    ));
    let mapping = Rc::clone(&router);
    let mapped = Rc::clone(&trace);
    let agent = create_agent(AgentConfig::try_from_plain_turns(
        llm,
        vec![Rc::new(())],
        |_| "act",
        move |call| {
            mapped.expected.replace(Some(Rc::downgrade(call)));
            mapping.tool_of_plain(call).map_err(Rc::new)
        },
        |_, _, _| (),
    ));
    let raw = raw("collect_invoice");
    let parsed = match AGENT_TURN_SCHEMA.parse(Rc::clone(&raw)) {
        Ok(value) => value,
        Err(_) => panic!("actual default guard accepts the invoice turn"),
    };
    assert!(
        Rc::ptr_eq(&raw, &parsed),
        "actual-default-guard-retains-root"
    );
    let started = agent.start(&agent.init(), "borrowed", 0.0).unwrap();
    let step = agent.turn(&started.state, parsed, 1.0).unwrap();
    let original_call = trace.expected.borrow().as_ref().unwrap().upgrade().unwrap();
    let success = Rc::new(invoice::Results::Collect(Rc::clone(&services.result)));
    let outcome = ToolOutcome::Ok(Rc::clone(&success));
    let parts = router
        .parts_of_plain(&original_call, &outcome)
        .ok()
        .flatten()
        .unwrap();
    assert!(Rc::ptr_eq(&parts, &services.result.parts));
    let succeeded = agent
        .tool_ok(&step.state, "invoice-17", Rc::clone(&success), 17.25)
        .unwrap();
    let ToolOutcome::Ok(stored) = succeeded.state.conversation.as_ref().unwrap().tool_records[0]
        .outcome
        .as_ref()
    else {
        panic!("pure successful receipt")
    };
    assert!(
        Rc::ptr_eq(stored, &success),
        "canonical-plain-agent-success-owner"
    );
    let command = step
        .commands
        .into_iter()
        .find_map(|c| match c {
            demlik_tea::agent::AgentCommand::Tool(c) => Some(c),
            _ => None,
        })
        .unwrap();
    assert_eq!(trace.calls.get(), 2, "discarded-sweep-and-launched-parse");
    let completion = futures::executor::block_on(
        router.interpret(&command, ToolContext::bare(services.as_ref())),
    )
    .unwrap();
    let message = command.settle(completion, 17.25).unwrap().pop().unwrap();
    let settlement = router.outcome_of(&message).unwrap().unwrap();
    assert_eq!(message.tag(), "collect_invoice_err");
    let ToolOutcome::Error(error) = settlement.outcome else {
        panic!("declared error")
    };
    let receipt = agent
        .tool_err(&step.state, settlement.call_id, Rc::clone(&error), 17.25)
        .unwrap();
    let records = &receipt.state.conversation.as_ref().unwrap().tool_records;
    let ToolOutcome::Error(stored) = records[0].outcome.as_ref() else {
        panic!("stored error")
    };
    assert!(
        Rc::ptr_eq(stored, &error),
        "canonical-plain-agent-error-owner"
    );
    let invoice::Errors::Collect(view) = stored.as_ref() else {
        panic!("typed declared family")
    };
    let Failure::Declared(tool::ToolFailure::Declared(cause)) = &view.error else {
        panic!("declared cause")
    };
    assert!(
        Rc::ptr_eq(cause, &services.denied) && std::ptr::eq(cause.0.label.as_ptr(), label.as_ptr()),
        "borrowed-rich-cause-retained"
    );
    let empty = empty::Router::new().unwrap();
    let call = records[0].call.as_ref();
    assert!(
        empty
            .parts_of_plain::<(), ()>(call, &ToolOutcome::Ok(Rc::new(())))
            .unwrap()
            .is_none()
    );
}
async fn owned(profile: Profile, mode: u8) {
    let label = "owned invoice";
    let trace = Rc::new(Trace::default());
    let services = host(label, Rc::clone(&trace), mode == 1);
    let result = Rc::clone(&services.result);
    let denied = Rc::clone(&services.denied);
    let router = Rc::new(
        invoice::Router::new(
            collect_definition(Rc::clone(&trace)),
            check_definition(Rc::clone(&trace), label),
        )
        .unwrap(),
    );
    let mapping = Rc::clone(&router);
    let mapped = Rc::clone(&trace);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &&str| Rc::new(AGENT_TURN_SCHEMA)),
        StructuredOutputError::describe,
    ));
    let agent = Rc::new(create_agent(AgentConfig::try_from_plain_turns(
        llm,
        vec![Rc::new(())],
        |_| "act",
        move |call| {
            mapped.expected.replace(Some(Rc::downgrade(call)));
            mapping.tool_of_plain(call).map_err(Rc::new)
        },
        |_, _, _| (),
    )));
    let first = raw(if mode == 2 {
        "check_invoice"
    } else {
        "collect_invoice"
    });
    let first_owner = Rc::downgrade(&first);
    let last = Rc::new(decode_json(r#"{"content":"done","toolCalls":[]}"#).unwrap());
    let replies = RefCell::new(VecDeque::from([Rc::clone(&first), last]));
    let model=plain_model(async move|_:Messages<'_,()>|->Result<Rc<PlainData>,CallValue<StructuredOutputError>>{Ok(replies.borrow_mut().pop_front().unwrap())});
    // PUBLIC_PLAIN_ROUTED_CALL: the original guard/call/args enters the existing wire.
    let wired = Rc::clone(&agent).to_machine_with_tools(
        model,
        NoMessages,
        Rc::clone(&router).for_agent(Rc::clone(&services)),
        Rc::new(TokioTimer::with_clock(|| 17.25, |_| {})),
    );
    let mut options = Options::<_, _, std::convert::Infallible, _, _, _>::new(profile);
    options.clock = Rc::new(|| 17.25);
    options.terminal = Some(Rc::new(move |state: &Rc<_>| agent.is_settled(state)));
    let run = runtime::try_launch(wired.machine, (), wired.interpret, wired.subscribe, options);
    run.ready().await.unwrap();
    let retained = Rc::new(RefCell::new(None));
    let capture = Rc::clone(&retained);
    let stamp_count = Rc::new(Cell::new(0));
    let stamps = Rc::clone(&stamp_count);
    let observed = run.observe(
        move |message: &AgentMachineMsg<_, _, _, _, invoice::Messages<_, _>>, state: &Rc<_>| {
            if let AgentMachineMsg::Tool(message) = message {
                let at = match message {
                    invoice::Messages::Collect(m) => m.at(),
                    invoice::Messages::Check(m) => m.at(),
                    invoice::Messages::Rejected(m) => m.at(),
                };
                assert_eq!(
                    at.and_then(|v| v.number()),
                    Some(17.25),
                    "plain-original-settled-at"
                );
                stamps.set(stamps.get() + 1);
                capture.replace(
                    state
                        .conversation
                        .as_ref()
                        .unwrap()
                        .tool_records
                        .last()
                        .map(Rc::clone),
                );
            }
        },
    );
    drop(first);
    run.dispatch(AgentMachineMsg::Start {
        run_id: "plain-owned".into(),
        at: 3.5,
    })
    .await
    .unwrap();
    let final_state = run.done().await.unwrap();
    assert!(
        final_state.is_settled() && final_state.conversation.is_none(),
        "plain-terminal-source-contract"
    );
    let record = retained.borrow().as_ref().map(Rc::clone).unwrap();
    assert!(
        Rc::ptr_eq(record.call.owner(), &first_owner.upgrade().unwrap()),
        "canonical-plain-original-root"
    );
    assert!(
        Rc::ptr_eq(
            &record.call,
            &trace.expected.borrow().as_ref().unwrap().upgrade().unwrap()
        ),
        "canonical-plain-original-call"
    );
    match record.outcome.as_ref() {
        ToolOutcome::Ok(value) => {
            let original = match value.as_ref() {
                invoice::Results::Collect(v) | invoice::Results::Check(v) => v,
                invoice::Results::Rejected(_) => panic!("success family"),
            };
            assert!(
                Rc::ptr_eq(original, &result) && original.marker.get() == 17,
                "plain-original-result-owner"
            );
            let parts = router
                .parts_of_plain(&record.call, &record.outcome)
                .ok()
                .flatten()
                .unwrap();
            assert!(
                Rc::ptr_eq(&parts, &result.parts),
                "plain-original-parts-owner"
            );
        }
        ToolOutcome::Error(value) => {
            assert_eq!(mode, 1);
            let invoice::Errors::Collect(view) = value.as_ref() else {
                panic!("failure family")
            };
            let Failure::Declared(tool::ToolFailure::Declared(original)) = &view.error else {
                panic!("original rich declared error")
            };
            assert!(
                Rc::ptr_eq(original, &denied) && Rc::ptr_eq(&original.0, &denied.0),
                "plain-original-rich-business-error"
            );
        }
    }
    assert_eq!(stamp_count.get(), 1);
    assert_eq!(services.handlers.get(), 1);
    assert_eq!(
        trace.calls.get(),
        2,
        "actual-discarded-and-launched-parser-calls"
    );
    if mode == 2 {
        assert!(
            trace
                .retained
                .borrow()
                .iter()
                .all(|weak| weak.upgrade().is_none()),
            "object-schema-new-parsed-owner"
        );
    }
    observed();
    run.stop().await;
}
fn main() {
    retained_cursor();
    rejections();
    let label = String::from("borrowed invoice");
    borrowed(&label);
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&host, async {
        for profile in [Profile::Promise, Profile::Effect] {
            for mode in 0..3 {
                owned(profile, mode).await;
            }
        }
    });
    println!(
        "plain args: borrowed/pure owners and six typed actor paths passed; zero Source case credit"
    );
}
