use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentCommand, AgentConfig, AgentStatus, AgentTerminalFailure, create_agent, status,
        transcript::Transcript,
        types::{
            AgentEndedStatus, AgentEvent, AgentEventHead, AgentField, AgentNumber, AgentState,
            AgentTurn, Conversation, ToolCall, TurnUsage,
        },
    },
    flow::monitored_run::{MonitoredRunState, RunFailure, RunPhase},
    llm_call::{self, LlmCall, LlmCause, Rejected, Schema},
    resilience::resilient_call::{CallValue, RunError},
    work_queue::QueueField,
};
use std::{cell::Cell, rc::Rc};
struct Opaque<'a>(&'a Cell<u8>);
struct Turn<'a> {
    fields: AgentTurn<Opaque<'a>, Opaque<'a>>,
    original: &'a Cell<u8>,
}
struct Parser;
impl<'a> Schema for &'a Parser {
    type Raw = Rc<Turn<'a>>;
    type Output = Rc<Turn<'a>>;
    type Error = Opaque<'a>;
    fn parse(&self, value: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(value)
    }
}
struct Tool<'a>(Rc<ToolCall<Opaque<'a>>>);
impl Tagged for Tool<'_> {
    fn tag(&self) -> &str {
        let _ = &self.0;
        "tool"
    }
}
fn view<'t, 'a>(turn: &'t Turn<'a>) -> &'t AgentTurn<Opaque<'a>, Opaque<'a>> {
    &turn.fields
}

#[test]
fn inferred_opaque_projection_retains_live_collection_and_owned_terminal_facts() {
    let local = Cell::new(7);
    let parser = Parser;
    let p = &parser;
    let schema = Rc::new(p);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schema)),
        |_: &Opaque<'_>| Ok("opaque rejection".into()),
    ));
    let stage = Rc::new(Opaque(&local));
    let agent = create_agent(AgentConfig::new(
        Rc::clone(&llm),
        vec![Rc::clone(&stage)],
        |_| "audit",
        |call| Tool(Rc::clone(call)),
        |_, _: &Rc<Conversation<Opaque<'_>, Turn<'_>, Opaque<'_>, Opaque<'_>>>, _| Opaque(&local),
        view,
    ));
    let initial = agent.init();
    assert!(matches!(status(&initial), AgentStatus::Idle));
    let zero = Rc::clone(initial.usage.value().unwrap().as_ref().unwrap());
    let started = agent.start(&initial, "audit", 0.0).unwrap();
    assert!(matches!(status(&started.state), AgentStatus::Running));
    let AgentCommand::Brain(command) = started.commands.into_iter().next().unwrap() else {
        panic!("brain")
    };
    let call = Rc::new(ToolCall {
        call_id: "a".into(),
        name: "read".into(),
        args: Rc::new(Opaque(&local)),
    });
    let tool_turn = Rc::new(Turn {
        fields: AgentTurn::new("work".into(), vec![Rc::clone(&call)]),
        original: &local,
    });
    let tools = agent.turn(&started.state, tool_turn, 1.0).unwrap();
    let AgentStatus::Suspended { pending } = status(&tools.state) else {
        panic!("suspended")
    };
    assert!(std::ptr::eq(pending, &tools.state.tools.running));
    assert!(Rc::ptr_eq(&pending[0], &call));
    let progressed = agent
        .tool_ok(&tools.state, "a", Rc::new(Opaque(&local)), 2.0)
        .unwrap();
    assert!(matches!(status(&progressed.state), AgentStatus::Running));
    assert!(Rc::ptr_eq(&pending[0], &call));
    let mut empty = tools.state.as_ref().clone();
    let mut empty_tools = empty.tools.as_ref().clone();
    empty_tools.running.clear();
    empty.tools = Rc::new(empty_tools);
    let AgentStatus::Suspended {
        pending: empty_pending,
    } = status(&empty)
    else {
        panic!("empty is suspended")
    };
    assert!(empty_pending.is_empty());
    assert!(std::ptr::eq(empty_pending, &empty.tools.running));
    assert!(!std::ptr::eq(empty_pending, &empty.tools.pending));
    let output = Rc::new(Turn {
        fields: AgentTurn::new("report".into(), vec![]),
        original: &local,
    });
    let done = agent
        .turn(&progressed.state, Rc::clone(&output), 3.0)
        .unwrap();
    let AgentStatus::Ended(ended) = status(&done.state) else {
        panic!("ended")
    };
    drop(done);
    let AgentEndedStatus::Done {
        output: AgentField::Value(Some(retained)),
        usage,
    } = &ended
    else {
        panic!("done")
    };
    assert!(Rc::ptr_eq(retained, &output));
    assert!(Rc::ptr_eq(usage, &zero));
    assert!(std::ptr::eq(retained.original, &local));
    let failure = Rc::new(Opaque(&local));
    let msg = agent.brain().err(
        command,
        RunError::port_rejected(Rejected::new(CallValue::shared(Rc::clone(&failure)))),
        Some(5.0),
    );
    let cancelled = agent.cancel(&started.state, 4.0).unwrap();
    let late = agent.fail(&cancelled.state, &msg, 5.0).unwrap();
    assert!(matches!(late.state.run.phase, RunPhase::Cancelled { .. }));
    let annotation = Rc::clone(late.state.failure.value().unwrap().as_ref().unwrap());
    let AgentStatus::Ended(ended) = status(&late.state) else {
        panic!("late failure")
    };
    drop(late);
    drop(agent);
    let ended = Rc::new(ended);
    let transcript = Transcript::<Opaque<'_>, Turn<'_>, _>::new();
    transcript.on_event(&AgentEvent::<_, _, _, PlainData>::RunDone {
        head: AgentEventHead {
            run_id: "audit".into(),
            at: 5.0,
        },
        status: Rc::clone(&ended),
    });
    assert!(Rc::ptr_eq(
        transcript.read().outcome.ended().unwrap(),
        &ended
    ));
    let AgentEndedStatus::Failed {
        failure: AgentField::Value(carrier),
    } = ended.as_ref()
    else {
        panic!("failed")
    };
    let AgentTerminalFailure::Agent(original) = carrier.as_ref() else {
        panic!("agent")
    };
    assert!(Rc::ptr_eq(original, &annotation));
    let demlik_tea::agent::types::AgentFailure::Llm {
        error: AgentField::Value(error),
        ..
    } = original.as_ref()
    else {
        panic!("llm")
    };
    let LlmCause::Value(retained) = &error.error else {
        panic!("cause")
    };
    assert!(Rc::ptr_eq(retained, &failure));
    assert!(std::ptr::eq(retained.0, &local));

    let run_failure = Rc::new(RunFailure::Stage {
        stage: QueueField::Value(Rc::clone(&stage)),
        error: QueueField::Value(Rc::clone(&failure)),
    });
    // One changed composed channel is inferred from the actual retained failure.
    let run_failed = AgentState {
        run: Rc::new(MonitoredRunState {
            phase: RunPhase::Failed {
                run_id: "stage".into(),
                failure: Rc::clone(&run_failure),
            },
            core: initial.run.core.clone(),
        }),
        resilience: initial.resilience.clone(),
        tools: Rc::clone(&initial.tools),
        conversation: initial.conversation.clone(),
        usage: initial.usage.clone(),
        compaction: initial.compaction.clone(),
        tool_resilience: initial.tool_resilience.clone(),
        refused_calls: initial.refused_calls.clone(),
        lifecycle: initial.lifecycle.clone(),
        failure: initial.failure.clone(),
        output: initial.output.clone(),
        instructions: initial.instructions.clone(),
    };
    let AgentStatus::Ended(ended) = status(&run_failed) else {
        panic!("run failed")
    };
    drop(run_failed);
    let AgentEndedStatus::Failed {
        failure: AgentField::Value(carrier),
    } = ended
    else {
        panic!("failed")
    };
    let AgentTerminalFailure::Run(retained) = carrier.as_ref() else {
        panic!("run")
    };
    assert!(Rc::ptr_eq(retained, &run_failure));
    let RunFailure::Stage {
        stage: QueueField::Value(s),
        error: QueueField::Value(e),
    } = retained.as_ref()
    else {
        panic!("stage")
    };
    assert!(Rc::ptr_eq(s, &stage));
    assert!(Rc::ptr_eq(e, &failure));
}

#[test]
fn ended_presence_and_nullable_time_serialize_without_fabricated_nulls() {
    let undefined = AgentEndedStatus::<PlainData, PlainData>::Failed {
        failure: AgentField::Undefined,
    };
    assert_eq!(
        serde_json::to_string(&undefined).unwrap(),
        r#"{"kind":"failed"}"#
    );
    let done = AgentEndedStatus::<PlainData, PlainData>::Done {
        output: AgentField::Undefined,
        usage: Rc::new(TurnUsage::new(0.0, 0.0)),
    };
    assert_eq!(
        serde_json::to_string(&done).unwrap(),
        r#"{"kind":"done","usage":{"inputTokens":0,"outputTokens":0}}"#
    );
    let null = AgentEndedStatus::<PlainData, PlainData>::Cancelled {
        at: AgentNumber(None),
    };
    assert_eq!(
        serde_json::to_string(&null).unwrap(),
        r#"{"kind":"cancelled","at":null}"#
    );
    let zero = AgentEndedStatus::<PlainData, PlainData>::Cancelled { at: (-0.0).into() };
    assert_eq!(
        serde_json::to_string(&zero).unwrap(),
        r#"{"kind":"cancelled","at":0}"#
    );
}
