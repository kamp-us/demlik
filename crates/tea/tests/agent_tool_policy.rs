use demlik_tea::{
    PlainData as D, Tagged,
    agent::{
        AgentConfig, ToolResilience, create_agent,
        types::{AgentTurn, Conversation, ToolCall, ToolOutcome},
    },
    js_record::RecordValue,
    llm_call::{self, LlmCall, Schema},
    resilience::{
        deadline::deadline_exceeded,
        resilient_call::{CallFailure, CallValue},
    },
    retry_backoff::{CountBound, DEFAULT_RETRY_POLICY, Jitter, RetryPolicy},
};
use std::{cell::Cell, rc::Rc};
struct Args<'a>(&'a str, Rc<Cell<u32>>);
struct Payload<'a>(&'a str);
struct Output<'a>(&'a str, Rc<Cell<u32>>);
struct Cause<'a>(&'a str, Rc<Cell<u32>>);
type Turn<'a> = AgentTurn<Args<'a>, ()>;
struct Parser<'a>(Rc<Cause<'a>>);
impl<'a> Schema for Parser<'a> {
    type Raw = Rc<Turn<'a>>;
    type Output = Rc<Turn<'a>>;
    type Error = Cause<'a>;
    fn parse(&self, _: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Err(CallValue::shared(Rc::clone(&self.0)))
    }
}
struct Tool<'a>(Rc<ToolCall<Args<'a>>>);
impl Tagged for Tool<'_> {
    fn tag(&self) -> &str {
        "policy_tool"
    }
}
// Contract: an enabled policy retains opaque borrowed arguments/results and the
// actual full error Rc while retrying, without extending bounds into the model.
// Regression: serialize/clone a payload, rebuild a call, or fold an absorbed error.
// The previous interface proof never launched a tool; this uses real public verbs.
#[test]
fn enabled_policy_retains_borrowed_opaque_owners_and_hides_attempt_failure() {
    let text = String::from("borrowed invoice");
    let borrowed = text.as_str();
    let token = Rc::new(Cell::new(7));
    let cause = Rc::new(Cause(borrowed, Rc::clone(&token)));
    let schema = Rc::new(Parser(Rc::clone(&cause)));
    let original_schema = Rc::clone(&schema);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schema)),
        |e: &Cause<'_>| Ok(e.0.into()),
    ));
    let args = Rc::new(Args(borrowed, Rc::clone(&token)));
    let call = Rc::new(ToolCall {
        call_id: "a".into(),
        name: "lookup".into(),
        args: Rc::clone(&args),
    });
    let turn = Rc::new(Turn::new("invoice".into(), vec![Rc::clone(&call)]));
    let Err(CallValue::Shared(actual_cause)) = original_schema.parse(Rc::clone(&turn)) else {
        panic!("actual cause")
    };
    assert!(Rc::ptr_eq(&actual_cause, &cause));
    assert!(Rc::ptr_eq(&actual_cause.1, &token));
    let emits = Cell::new(0);
    let agent = create_agent(
        AgentConfig::new(
            llm,
            vec![Rc::new(borrowed)],
            |_| "invoice",
            |call| {
                emits.set(emits.get() + 1);
                Tool(Rc::clone(call))
            },
            |_, _: &Rc<Conversation<Output<'_>, Turn<'_>, D, Args<'_>>>, _| Payload(borrowed),
            |turn| turn,
        )
        .tool_resilience_of(|call| {
            assert!(Rc::ptr_eq(&call.args, &args));
            Some(
                ToolResilience::default()
                    .timeout_ms(50.0)
                    .retry(RetryPolicy {
                        curve: demlik_tea::retry_backoff::BackoffCurve {
                            base_ms: 10.0,
                            factor: 1.0,
                            jitter: Jitter::None,
                            ..DEFAULT_RETRY_POLICY.curve
                        },
                        budget: CountBound { max_attempts: 3.0 },
                    }),
            )
        }),
    );
    let started = agent.start(&agent.init(), "r", 0.0).unwrap();
    let running = agent.turn(&started.state, turn, 1.0).unwrap();
    assert_eq!(emits.get(), 2);
    let demlik_tea::agent::AgentCommand::Tool(command) = &running.commands[0] else {
        panic!("tool command")
    };
    assert!(Rc::ptr_eq(&command.0, &call));
    assert_eq!(command.0.args.0, borrowed);
    assert!(Rc::ptr_eq(&command.0.args.1, &token));
    let full = Rc::new(D::Object(
        [
            ("_tag".into(), D::String("offline".into())),
            ("kind".into(), D::String("error".into())),
            ("reason".into(), D::String("local outage".into())),
            ("extra".into(), D::Number(71.0)),
        ]
        .into_iter()
        .collect(),
    ));
    let hidden = agent
        .tool_err(&running.state, "a", Rc::clone(&full), 2.0)
        .unwrap();
    assert!(hidden.commands.is_empty());
    assert!(
        hidden
            .state
            .conversation
            .as_ref()
            .unwrap()
            .tool_records
            .is_empty()
    );
    let maps = hidden.state.tool_resilience.value().unwrap();
    let (_, RecordValue::Entry(slice)) = maps.own_entries().next().unwrap() else {
        panic!("slice")
    };
    let (_, RecordValue::Entry(retry)) = slice.snapshot().retry.own_entries().next().unwrap()
    else {
        panic!("retry")
    };
    let CallFailure::External(actual) = retry.last_error.as_ref().unwrap().as_ref() else {
        panic!("full error")
    };
    assert!(Rc::ptr_eq(actual, &full));
    let replayed = agent
        .on_timer(
            &hidden.state,
            &deadline_exceeded("resilient:retry:$tool:lookup#a", 12.0, None),
        )
        .unwrap();
    let demlik_tea::agent::AgentCommand::Tool(command) = &replayed.commands[0] else {
        panic!("retry tool")
    };
    assert!(Rc::ptr_eq(&command.0, &call));
    let output = Rc::new(Output(borrowed, Rc::clone(&token)));
    let ended = agent
        .tool_ok(&replayed.state, "a", Rc::clone(&output), 13.0)
        .unwrap();
    let record = &ended.state.conversation.as_ref().unwrap().tool_records[0];
    assert!(Rc::ptr_eq(&record.call, &call));
    let ToolOutcome::Ok(actual) = record.outcome.as_ref() else {
        panic!("success")
    };
    assert!(Rc::ptr_eq(actual, &output));
    assert!(Rc::ptr_eq(&actual.1, &token));
    assert_eq!(actual.0, borrowed);
    let maps = ended.state.tool_resilience.value().unwrap();
    let (_, RecordValue::Entry(slice)) = maps.own_entries().next().unwrap() else {
        panic!("slice retained")
    };
    assert!(slice.snapshot().calls.own_entries().next().is_none());
    assert!(slice.snapshot().retry.own_entries().next().is_none());
    assert!(agent.subs(&ended.state).unwrap().is_empty());
    let payload = Payload(borrowed);
    assert_eq!(payload.0, borrowed);
}
