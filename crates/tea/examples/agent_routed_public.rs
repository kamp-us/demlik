//! Owned opaque actor and locally borrowed construction over the routed Agent wire.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, AgentMachineMsg, create_agent,
        model::{Messages, NoMessages, plain_model},
        tool::{self, ErrorFamily, Raised, ToolContext, ToolSpec},
        types::{AgentTurn, Conversation, ToolCall, ToolOutcome},
    },
    command::{Failure, Outcome, SchemaError},
    llm_call::{self, LlmCall, Schema},
    ports::{Port, define_port},
    resilience::resilient_call::CallValue,
    runtime::{self, Options, Profile},
    timing::TokioTimer,
};
use std::{cell::Cell, collections::VecDeque, marker::PhantomData, rc::Rc};
demlik_tea::tool_router! { mod invoice { Read(read) } }
struct Args(Rc<Cell<u32>>);
struct Value(Rc<Cell<u32>>);
struct Cause(Rc<Cell<u32>>);
struct Denied(Rc<Cause>);
impl Tagged for Denied {
    fn tag(&self) -> &str {
        "denied"
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
type Turn = AgentTurn<Args, ()>;
struct Host {
    args: Rc<Args>,
    result: Rc<Value>,
    denied: Rc<Denied>,
    fail: bool,
    port: Port<Rc<Cell<u32>>>,
}
fn definition() -> Rc<
    impl tool::ToolDefinition<
        RawArgs = Args,
        Args = Args,
        RawResult = Rc<Value>,
        Ok = Value,
        Error = Denied,
        Thrown = Cause,
        Host = Host,
    >,
> {
    definition_with_guard(Rc::new(Cell::new(false)))
}
fn definition_with_guard(
    refuse: Rc<Cell<bool>>,
) -> Rc<
    impl tool::ToolDefinition<
        RawArgs = Args,
        Args = Args,
        RawResult = Rc<Value>,
        Ok = Value,
        Error = Denied,
        Thrown = Cause,
        Host = Host,
    >,
> {
    tool::tool(
        "read_invoice",
        ToolSpec::new(
            Rc::new(Identity::<Args>(PhantomData)),
            Rc::new(Identity::<Value>(PhantomData)),
            ErrorFamily::new(["denied"], move |_: &Denied| {
                if refuse.get() {
                    return Err(demlik_tea::command::CommandContractError::mismatched(
                        "actual-family",
                        "refused-family",
                    ));
                }
                Ok(PlainData::Object(
                    [("_tag".into(), PlainData::String("denied".into()))]
                        .into_iter()
                        .collect(),
                ))
            }),
        )
        .raised::<Cause>(),
        |args: &Rc<Args>, ctx: ToolContext<'_, Host>| {
            Box::pin(async move {
                assert!(Rc::ptr_eq(args, &ctx.host.args), "opaque-original-args");
                ctx.emit(&ctx.host.port, &args.0).unwrap();
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
async fn consume(profile: Profile, fail: bool) {
    let marker = Rc::new(Cell::new(7));
    let args = Rc::new(Args(Rc::clone(&marker)));
    let result = Rc::new(Value(Rc::clone(&marker)));
    let cause = Rc::new(Cause(Rc::clone(&marker)));
    let denied = Rc::new(Denied(Rc::clone(&cause)));
    let port = define_port(format!("agent-routed-opaque-{profile:?}-{fail}")).unwrap();
    let host = Rc::new(Host {
        args: Rc::clone(&args),
        result: Rc::clone(&result),
        denied: Rc::clone(&denied),
        fail,
        port: port.clone(),
    });
    let router = Rc::new(invoice::Router::new(definition()).unwrap());
    let route = Rc::clone(&router);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &&str| Rc::new(Identity::<Turn>(PhantomData))),
        |_: &SchemaError| Ok("schema".into()),
    ));
    let agent = Rc::new(create_agent(AgentConfig::try_new(
        llm,
        vec![Rc::new(())],
        |_| "invoice",
        move |call| route.tool_of(call).map_err(Rc::new),
        |_, _: &Rc<Conversation<_, Turn, _, Args>>, _| (),
        |turn| turn,
    )));
    let call = Rc::new(ToolCall {
        call_id: "read".into(),
        name: "read_invoice".into(),
        args: Rc::clone(&args),
    });
    let replies = std::cell::RefCell::new(VecDeque::from([
        Rc::new(Turn::new("read".into(), vec![Rc::clone(&call)])),
        Rc::new(Turn::new("done".into(), vec![])),
    ]));
    let model = plain_model(
        async move |_: Messages<'_, ()>| -> Result<Rc<Turn>, CallValue<SchemaError>> {
            Ok(replies
                .borrow_mut()
                .pop_front()
                .expect("two authored turns"))
        },
    );
    // PUBLIC_ROUTED_CALL: inference preserves opaque args/result/business error/host.
    let wired = Rc::clone(&agent).to_machine_with_tools(
        model,
        NoMessages,
        Rc::clone(&router).for_agent(host),
        Rc::new(TokioTimer::with_clock(|| 17.25, |_| {})),
    );
    assert!(wired.machine.update.accepted_types(None).is_empty());
    let initial = agent.init();
    let names = wired.machine.update.accepted_types(Some(&initial));
    assert_eq!(
        &names[names.len() - 4..],
        [
            "read_invoice_ok",
            "read_invoice_err",
            "tool_rejected_ok",
            "tool_rejected_err"
        ],
        "actual-router-metadata"
    );
    let mut options = Options::<_, _, std::convert::Infallible, _, _, _>::new(profile);
    options.clock = Rc::new(|| 17.25);
    options.terminal = Some(Rc::new(move |s: &Rc<_>| agent.is_settled(s)));
    let run = runtime::try_launch(wired.machine, (), wired.interpret, wired.subscribe, options);
    run.ready().await.unwrap();
    let retained = Rc::new(std::cell::RefCell::new(None));
    let captured = Rc::clone(&retained);
    let stamps = Rc::new(Cell::new(0));
    let counted = Rc::clone(&stamps);
    let _observe = run.observe(
        move |message: &AgentMachineMsg<_, _, _, _, invoice::Messages<_>>, state: &Rc<_>| {
            if let AgentMachineMsg::Tool(invoice::Messages::Read(message)) = message {
                assert_eq!(
                    message.at().and_then(|at| at.number()),
                    Some(17.25),
                    "opaque-original-stamp"
                );
                counted.set(counted.get() + 1);
                captured.replace(
                    state
                        .conversation
                        .as_ref()
                        .and_then(|c| c.tool_records.last())
                        .map(Rc::clone),
                );
            }
        },
    );

    let seen = Rc::new(Cell::new(0));
    let token = Rc::clone(&marker);
    let observed = Rc::clone(&seen);
    let _ports = run.subscribe_port(
        &port,
        Rc::new(move |value| {
            assert!(Rc::ptr_eq(value, &token), "opaque-original-context-port");
            observed.set(observed.get() + 1);
        }),
    );
    run.dispatch(AgentMachineMsg::Start {
        run_id: "opaque-routed".into(),
        at: 3.5,
    })
    .await
    .unwrap();
    let state = run.done().await.unwrap();
    assert!(state.is_settled());
    let record = Rc::clone(
        retained
            .borrow()
            .as_ref()
            .expect("actual tool transition record"),
    );
    assert!(Rc::ptr_eq(&record.call, &call), "opaque-original-call");
    if fail {
        let ToolOutcome::Error(error) = record.outcome.as_ref() else {
            panic!("business error expected")
        };
        let invoice::Errors::Read(view) = error.as_ref() else {
            panic!("read error family")
        };
        let Failure::Declared(tool::ToolFailure::Declared(original)) = &view.error else {
            panic!("original declared error")
        };
        assert!(
            Rc::ptr_eq(original, &denied)
                && Rc::ptr_eq(&original.0, &cause)
                && Rc::ptr_eq(&original.0.0, &marker),
            "opaque-original-rich-error"
        );
    } else {
        let ToolOutcome::Ok(output) = record.outcome.as_ref() else {
            panic!("success expected")
        };
        let invoice::Results::Read(original) = output.as_ref() else {
            panic!("read result family")
        };
        assert!(
            Rc::ptr_eq(original, &result) && Rc::ptr_eq(&original.0, &marker),
            "opaque-original-result"
        );
    }

    assert_eq!(seen.get(), 1);
    assert_eq!(stamps.get(), 1);
    run.stop().await;
}
fn borrowed_constructor(marker: &Cell<u32>) {
    let router = Rc::new(invoice::Router::new(definition()).unwrap());
    let route = Rc::clone(&router);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &&str| Rc::new(Identity::<Turn>(PhantomData))),
        |_: &SchemaError| Ok("schema".into()),
    ));
    let agent = Rc::new(create_agent(AgentConfig::try_new(
        llm,
        vec![Rc::new(marker)],
        |_| "invoice",
        move |call| route.tool_of(call).map_err(Rc::new),
        |_, _: &Rc<Conversation<_, Turn, _, Args>>, _| (),
        |turn| turn,
    )));
    let args = Rc::new(Args(Rc::new(Cell::new(1))));
    let result = Rc::new(Value(Rc::new(Cell::new(2))));
    let cause = Rc::new(Denied(Rc::new(Cause(Rc::new(Cell::new(3))))));
    let host = Rc::new(Host {
        args,
        result,
        denied: cause,
        fail: false,
        port: define_port("agent-routed-local").unwrap(),
    });
    let model = plain_model(
        async move |_: Messages<'_, ()>| -> Result<Rc<Turn>, CallValue<SchemaError>> {
            marker.set(marker.get() + 1);
            Ok(Rc::new(Turn::new("borrowed".into(), vec![])))
        },
    );
    let wired = Rc::clone(&agent).to_machine_with_tools(
        model,
        NoMessages,
        router.for_agent(host),
        Rc::new(TokioTimer::new(|_| {})),
    );
    let state = (wired.machine.init)(None, &()).state;
    let step = wired
        .machine
        .update
        .try_apply(
            &state,
            &AgentMachineMsg::Start {
                run_id: "local".into(),
                at: 0.,
            },
        )
        .unwrap();
    assert!(
        std::ptr::eq(*step.state.current_stage().unwrap(), marker),
        "routed-borrowed-local-stage"
    );
    // BORROWED_ACTOR_REFUSAL: launch owns actor services and cannot retain this borrow.
}
async fn reader_refusal() {
    use demlik_tea::{
        ApplyError,
        agent::AgentMachineError,
        command::{CommandEdge, CommandFamily},
    };
    let refuse = Rc::new(Cell::new(false));
    let router = Rc::new(invoice::Router::new(definition_with_guard(Rc::clone(&refuse))).unwrap());
    let route = Rc::clone(&router);
    let args = Rc::new(Args(Rc::new(Cell::new(1))));
    let host = Rc::new(Host {
        args: Rc::clone(&args),
        result: Rc::new(Value(Rc::new(Cell::new(2)))),
        denied: Rc::new(Denied(Rc::new(Cause(Rc::new(Cell::new(3)))))),
        fail: true,
        port: define_port("agent-routed-reader-refusal").unwrap(),
    });
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &&str| Rc::new(Identity::<Turn>(PhantomData))),
        |_: &SchemaError| Ok("schema".into()),
    ));
    let agent = Rc::new(create_agent(AgentConfig::try_new(
        llm,
        vec![Rc::new(())],
        |_| "invoice",
        move |call| route.tool_of(call).map_err(Rc::new),
        |_, _: &Rc<Conversation<_, Turn, _, Args>>, _| (),
        |turn| turn,
    )));
    let call = Rc::new(ToolCall {
        call_id: "read".into(),
        name: "read_invoice".into(),
        args,
    });
    let started = agent.start(&agent.init(), "refusal", 0.).unwrap();
    let running = agent
        .turn(
            &started.state,
            Rc::new(Turn::new("read".into(), vec![Rc::clone(&call)])),
            1.,
        )
        .unwrap();
    let command = router.tool_of(&call).unwrap();
    // Native manual completion; this late classifier-refusal law earns no Source case credit.
    let invoice::Commands::Read(typed) = &command else {
        panic!("typed command")
    };
    let completion = invoice::Completions::Read(tool::ToolCompletion::new(
        Rc::clone(typed.tool()),
        Some(Outcome::err(tool::ToolFailure::Declared(Rc::clone(
            &host.denied,
        )))),
    ));
    let mut messages = command
        .settle_in(completion, &CommandEdge::new(|| 17.25))
        .unwrap();
    refuse.set(true);
    let model = plain_model(
        async |_: Messages<'_, ()>| -> Result<Rc<Turn>, CallValue<SchemaError>> {
            panic!("pure reader must not invoke model")
        },
    );
    let wired = Rc::clone(&agent).to_machine_with_tools(
        model,
        NoMessages,
        router.for_agent(host),
        Rc::new(TokioTimer::new(|_| {})),
    );
    let result = wired
        .machine
        .update
        .try_apply(&running.state, &AgentMachineMsg::Tool(messages.remove(0)));
    match result {
        Err(ApplyError::Reduce(AgentMachineError::ToolContract(error))) => assert!(
            matches!(error, demlik_tea::command::CommandContractError::CompletionMismatch {cmd_type,completion_type} if cmd_type=="actual-family"&&completion_type=="refused-family"),
            "routed-original-reader-error"
        ),
        _ => panic!("routed-reader-refusal-must-not-be-swallowed"),
    }
    assert_eq!(
        running
            .state
            .conversation
            .as_ref()
            .unwrap()
            .tool_records
            .len(),
        0
    );
}
fn main() {
    let marker = Cell::new(0);
    borrowed_constructor(&marker);
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&host, async {
        reader_refusal().await;
        for profile in [Profile::Promise, Profile::Effect] {
            consume(profile, false).await;
            consume(profile, true).await;
        }
    });
    println!("routed Agent: borrowed construction + four opaque actor workflows passed");
}
