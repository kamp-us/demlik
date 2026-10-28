//! Local borrowed binding proof; this does not launch an Agent actor.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, AgentWorkError, create_agent,
        tool::{self, AgentToolRoutes, ErrorFamily, Raised, ToolContext, ToolSpec},
        types::{AgentTurn, Conversation, ToolCall, ToolOutcome},
    },
    command::{CommandEdge, CommandFamily, Failure, Outcome, SchemaError},
    llm_call::{self, LlmCall, Schema},
    resilience::resilient_call::CallValue,
    runtime::Interpreter,
};
use std::{cell::Cell, marker::PhantomData, rc::Rc};
demlik_tea::tool_router! {mod invoice { Read(read), Check(check) }}
demlik_tea::tool_router! {mod empty {}}
struct Raw<'a>(&'a str);
struct ReadOk<'a>(&'a str, Rc<Cell<usize>>);
struct CheckOk;
struct Cause<'a>(&'a str, Rc<Cell<usize>>);
struct Denied<'a>(Rc<Cause<'a>>);
impl Tagged for Denied<'_> {
    fn tag(&self) -> &str {
        "denied"
    }
}
struct Host<'a> {
    label: &'a str,
    result: Rc<ReadOk<'a>>,
    denied: Rc<Denied<'a>>,
}
struct Identity<T>(PhantomData<fn() -> T>);
impl<T> Schema for Identity<T> {
    type Raw = Rc<T>;
    type Output = Rc<T>;
    type Error = SchemaError;
    fn parse(&self, value: Rc<T>) -> Result<Rc<T>, CallValue<SchemaError>> {
        Ok(value)
    }
}
struct ReadSchema<'a> {
    allowed: bool,
    calls: Rc<Cell<usize>>,
    marker: PhantomData<fn() -> ReadOk<'a>>,
}
impl<'a> Schema for ReadSchema<'a> {
    type Raw = Rc<ReadOk<'a>>;
    type Output = Rc<ReadOk<'a>>;
    type Error = SchemaError;
    fn parse(&self, value: Self::Raw) -> Result<Self::Output, CallValue<SchemaError>> {
        self.calls.set(self.calls.get() + 1);
        if self.allowed {
            Ok(value)
        } else {
            Err(CallValue::value(SchemaError::Issues(vec![])))
        }
    }
}
fn outer<C: CommandFamily, M, I: Interpreter<C, M, Error = AgentWorkError<tool::ToolError>>>(
    _: &I,
) {
}
struct Outer<'a>(&'a Cell<usize>);
fn agent_receipts<'a, A, R, TE, C>(
    mapper: impl Fn(&Rc<ToolCall<A>>) -> Result<C, Rc<tool::ToolError>> + 'a,
    read: Rc<ToolCall<A>>,
    check: Rc<ToolCall<A>>,
    result: Rc<R>,
    failure: Rc<TE>,
) where
    A: 'a,
    R: 'a,
    TE: 'a,
    C: Tagged + 'a,
{
    let schema = Rc::new(Identity::<AgentTurn<A>>(PhantomData));
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schema)),
        |_: &SchemaError| Ok("schema".into()),
    ));
    let agent = Rc::new(create_agent(AgentConfig::try_new(
        llm,
        vec![Rc::new(())],
        |_| "collect",
        mapper,
        |_, _: &Rc<Conversation<R, AgentTurn<A>, TE, A>>, _| (),
        |turn: &AgentTurn<A>| turn,
    )));
    let start = agent.start(&agent.init(), "r", 10.).unwrap();
    let running = agent
        .turn(
            &start.state,
            Rc::new(AgentTurn::new("read".into(), vec![read])),
            11.,
        )
        .unwrap();
    let done = agent
        .tool_ok(&running.state, "read", Rc::clone(&result), 13.25)
        .unwrap();
    let conversation = done.state.conversation.as_ref().unwrap();
    let ToolOutcome::Ok(retained) = conversation.tool_records[0].outcome.as_ref() else {
        panic!("typed success lost")
    };
    assert!(
        Rc::ptr_eq(retained, &result),
        "canonical-agent-success-owner"
    );
    let running = agent
        .turn(
            &start.state,
            Rc::new(AgentTurn::new("check".into(), vec![check])),
            11.,
        )
        .unwrap();
    let done = agent
        .tool_err(&running.state, "check", Rc::clone(&failure), 17.25)
        .unwrap();
    let conversation = done.state.conversation.as_ref().unwrap();
    let ToolOutcome::Error(retained) = conversation.tool_records[0].outcome.as_ref() else {
        panic!("typed failure lost")
    };
    assert!(
        Rc::ptr_eq(retained, &failure),
        "canonical-agent-business-owner"
    );
}
fn borrowed<'a>(label: &'a str, marker: &'a Cell<usize>) {
    let result = Rc::new(ReadOk(label, Rc::new(Cell::new(7))));
    let cause = Rc::new(Cause(label, Rc::clone(&result.1)));
    let denied = Rc::new(Denied(Rc::clone(&cause)));
    let host = Rc::new(Host {
        label,
        result: Rc::clone(&result),
        denied: Rc::clone(&denied),
    });
    let original_calls = Rc::new(Cell::new(0));
    let chosen_calls = Rc::new(Cell::new(0));
    let make_read = |allowed, calls| {
        tool::tool(
            "read_invoice",
            ToolSpec::new(
                Rc::new(Identity::<Raw<'a>>(PhantomData)),
                Rc::new(ReadSchema {
                    allowed,
                    calls,
                    marker: PhantomData,
                }),
                ErrorFamily::new(["denied"], |_: &Denied<'a>| {
                    Ok(PlainData::Object(
                        [("_tag".into(), PlainData::String("denied".into()))]
                            .into_iter()
                            .collect(),
                    ))
                }),
            ),
            |args: &Rc<Raw<'a>>, ctx: ToolContext<'_, Host<'a>>| {
                Box::pin(async move {
                    assert_eq!(args.0, ctx.host.label, "original-handler-input");
                    Ok(Outcome::ok(Rc::clone(&ctx.host.result)))
                })
            },
        )
        .unwrap()
    };
    let make_check = || {
        tool::tool(
            "check_invoice",
            ToolSpec::new(
                Rc::new(Identity::<Raw<'a>>(PhantomData)),
                Rc::new(Identity::<CheckOk>(PhantomData)),
                ErrorFamily::new(["denied"], |_: &Denied<'a>| {
                    Ok(PlainData::Object(
                        [("_tag".into(), PlainData::String("denied".into()))]
                            .into_iter()
                            .collect(),
                    ))
                }),
            ),
            |_: &Rc<Raw<'a>>, ctx: ToolContext<'_, Host<'a>>| {
                Box::pin(async move { Err(Raised::Declared(Rc::clone(&ctx.host.denied))) })
            },
        )
        .unwrap()
    };
    let a = Rc::new(
        invoice::Router::new(make_read(false, Rc::clone(&original_calls)), make_check()).unwrap(),
    );
    let b = Rc::new(
        invoice::Router::new(make_read(true, Rc::clone(&chosen_calls)), make_check()).unwrap(),
    );
    let binding = Rc::clone(&b).for_agent(Rc::clone(&host));
    outer::<_, Outer<'_>, _>(&binding);
    let outer_value = Outer(marker);
    assert!(std::ptr::eq(outer_value.0, marker));
    assert_eq!(
        binding.settlement_types(),
        b.settlement_types(),
        "router-owned-names"
    );
    let raw = Rc::new(Raw(label));
    let read = Rc::new(ToolCall {
        call_id: "read".into(),
        name: "read_invoice".into(),
        args: Rc::clone(&raw),
    });
    let check = Rc::new(ToolCall {
        call_id: "check".into(),
        name: "check_invoice".into(),
        args: Rc::clone(&raw),
    });
    let command = a.tool_of(&read).unwrap();
    let invoice::Commands::Read(ref typed) = command else {
        panic!("read route")
    };
    assert!(
        Rc::ptr_eq(&typed.cmd().input().args, &raw),
        "original-input-owner"
    );
    let completion =
        futures::executor::block_on(b.interpret(&command, ToolContext::bare(host.as_ref())))
            .unwrap();
    let clocks = Rc::new(Cell::new(0));
    let clock = Rc::clone(&clocks);
    let edge = CommandEdge::new(move || {
        clock.set(clock.get() + 1);
        13.25
    });
    let guard = command.dispatch_guard(&edge);
    let messages = command.settle_in(completion, &edge).unwrap();
    guard.check(&messages[0]).unwrap();
    assert!(
        binding.at(&messages[0]).and_then(|at| at.number()) == Some(13.25) && clocks.get() == 1,
        "original-settled-time"
    );
    let settled = binding.outcome_of(&messages[0]).unwrap().unwrap();
    let ToolOutcome::Ok(ok) = settled.outcome else {
        panic!("read outcome")
    };
    let invoice::Results::Read(retained) = ok.as_ref() else {
        panic!("read family")
    };
    assert!(
        Rc::ptr_eq(retained, &result) && original_calls.get() == 0 && chosen_calls.get() == 1,
        "chosen-schema-original-result"
    );
    assert_eq!(retained.0, label);
    assert!(Rc::ptr_eq(&retained.1, &cause.1));
    let command = b.tool_of(&check).unwrap();
    let completion =
        futures::executor::block_on(b.interpret(&command, ToolContext::bare(host.as_ref())))
            .unwrap();
    let messages = command
        .settle_in(completion, &CommandEdge::new(|| 17.25))
        .unwrap();
    let settled = binding.outcome_of(&messages[0]).unwrap().unwrap();
    let ToolOutcome::Error(error) = settled.outcome else {
        panic!("business outcome")
    };
    let invoice::Errors::Check(view) = error.as_ref() else {
        panic!("business family")
    };
    let Failure::Declared(tool::ToolFailure::Declared(original)) = &view.error else {
        panic!("declared cause")
    };
    assert!(
        Rc::ptr_eq(original, &denied) && Rc::ptr_eq(&original.0, &cause) && original.0.0 == label,
        "original-rich-business-cause"
    );
    agent_receipts(
        move |call| b.tool_of(call).map_err(Rc::new),
        Rc::clone(&read),
        Rc::clone(&check),
        ok,
        error,
    );
    let empty = Rc::new(empty::Router::new().unwrap());
    let no_tools = Rc::clone(&empty).for_agent(Rc::clone(&host));
    outer::<_, Outer<'_>, _>(&no_tools);
    let command = empty.tool_of(&read).unwrap();
    let completion = futures::executor::block_on(empty.interpret(&command)).unwrap();
    let messages = command
        .settle_in(completion, &CommandEdge::new(|| 19.5))
        .unwrap();
    let settlement = no_tools.outcome_of(&messages[0]).unwrap().unwrap();
    assert!(
        matches!(settlement.outcome, ToolOutcome::Error(_))
            && no_tools.at(&messages[0]).and_then(|v| v.number()) == Some(19.5)
            && no_tools.settlement_types() == empty.settlement_types(),
        "empty-router-original-settlement"
    );
}
fn main() {
    let label = String::from("borrowed invoice");
    let marker = Cell::new(1);
    borrowed(&label, &marker);
    println!(
        "tool-agent-binding: 7 ownership/time/reader laws; generic outer-M type proof; no Agent wire/actor execution"
    );
}
