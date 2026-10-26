use demlik_tea::agent::{AgentConfig, create_agent};
use demlik_tea::{
    Tagged,
    agent::types::{AgentField, AgentTurn, Conversation, ToolCall, ToolOutcome, ToolRecord},
    command::Outcome,
    data::JsText,
    flow::monitored_run::RunPhase,
    llm_call::{self, CauseField, LlmCall, LlmCallError, Schema},
    resilience::resilient_call::{CallValue, RunInput},
    work_queue::{Queue, QueueItem, QueueItemStatus},
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
struct Context {
    marker: Cell<u8>,
    rejects: Cell<bool>,
    parses: Cell<usize>,
    calls: RefCell<Vec<&'static str>>,
}
struct Stage<'a>(&'a Context);
struct Args<'a>(&'a Context);
struct Provider<'a>(&'a Context);
struct AuditResult<'a>(&'a Context);
struct ToolFailure<'a>(&'a Context);
struct ModelFailure<'a>(&'a Context);
struct AuditTurn<'a> {
    fields: AgentTurn<Args<'a>, Provider<'a>>,
    extra: &'a Cell<u8>,
}
struct Payload<'a> {
    context: &'a Context,
    stage: Option<Rc<Stage<'a>>>,
    conversation: Rc<Conversation<AuditResult<'a>, AuditTurn<'a>, ToolFailure<'a>, Args<'a>>>,
    instructions: Option<JsText>,
}
struct Parser<'a> {
    context: &'a Context,
    cause: Rc<ModelFailure<'a>>,
}
impl<'a> Schema for Parser<'a> {
    type Raw = Rc<AuditTurn<'a>>;
    type Output = Rc<AuditTurn<'a>>;
    type Error = ModelFailure<'a>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        self.context.parses.set(self.context.parses.get() + 1);
        if self.context.rejects.get() {
            Err(CallValue::shared(Rc::clone(&self.cause)))
        } else {
            Ok(raw)
        }
    }
}
struct ToolCommand<'a>(Rc<ToolCall<Args<'a>>>);
impl Tagged for ToolCommand<'_> {
    fn tag(&self) -> &str {
        "audit_tool"
    }
}
fn turn_view<'t, 'a>(turn: &'t AuditTurn<'a>) -> &'t AgentTurn<Args<'a>, Provider<'a>> {
    &turn.fields
}

#[test]
fn borrowed_opaque_inferred_constructor_and_owners() {
    let context = Context {
        marker: Cell::new(7),
        rejects: Cell::new(false),
        parses: Cell::new(0),
        calls: RefCell::new(Vec::new()),
    };
    let cause = Rc::new(ModelFailure(&context));
    let parser = Rc::new(Parser {
        context: &context,
        cause: Rc::clone(&cause),
    });
    let schemas = Rc::clone(&parser);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schemas)),
        |error| {
            assert!(std::ptr::eq(error.0, &context));
            Ok("model rejected".into())
        },
    ));
    let stage = Rc::new(Stage(&context));
    let ctx = &context;
    // One domain Conversation annotation anchors result and tool-failure types.
    // No StateOf annotation, generic argument list, Clone/serde/Send/static bound.
    let agent = create_agent(
        AgentConfig::new(
            Rc::clone(&llm),
            vec![Rc::clone(&stage), Rc::clone(&stage), Rc::clone(&stage)],
            move |stage| {
                ctx.calls.borrow_mut().push("turnOf");
                assert!(stage.is_some_and(|s| std::ptr::eq(s.0, ctx)));
                "audit"
            },
            move |call| {
                ctx.calls.borrow_mut().push("toolOf");
                ToolCommand(Rc::clone(call))
            },
            move |stage,
                  conv: &Rc<
                Conversation<AuditResult<'_>, AuditTurn<'_>, ToolFailure<'_>, Args<'_>>,
            >,
                  prompt| {
                ctx.calls.borrow_mut().push("payloadOf");
                Payload {
                    context: ctx,
                    stage: stage.cloned(),
                    conversation: Rc::clone(conv),
                    instructions: prompt.cloned(),
                }
            },
            turn_view,
        )
        .instructions("configured")
        .model_id("borrowed-model")
        .deadline_ms(30.0),
    );
    let state = agent.init();
    let other = agent.init();
    assert!(!Rc::ptr_eq(&state, &other));
    assert!(Rc::ptr_eq(
        state.usage.value().unwrap().as_ref().unwrap(),
        other.usage.value().unwrap().as_ref().unwrap()
    ));
    assert!(context.calls.borrow().is_empty());
    assert_eq!(context.parses.get(), 0);
    assert!(std::ptr::eq(agent.brain(), llm.run()));
    assert!(Rc::ptr_eq(&llm.schema_of(&"audit"), &parser));

    let args = Rc::new(Args(&context));
    let provider = Rc::new(Provider(&context));
    let call = Rc::new(ToolCall {
        call_id: "c1".into(),
        name: "scan".into(),
        args: Rc::clone(&args),
    });
    let answer = Rc::new(AuditTurn {
        fields: AgentTurn {
            content: "real retained turn".into(),
            tool_calls: vec![Rc::clone(&call)],
            provider: AgentField::Value(Rc::clone(&provider)),
            usage: AgentField::Absent,
        },
        extra: &context.marker,
    });
    let result = Rc::new(AuditResult(&context));
    let tool_failure = Rc::new(ToolFailure(&context));
    let mut conversation = Conversation::fresh();
    conversation.turns = Rc::new(vec![Rc::clone(&answer)]);
    conversation.tool_records = Rc::new(vec![
        Rc::new(ToolRecord {
            call: Rc::clone(&call),
            outcome: Rc::new(ToolOutcome::Ok(Rc::clone(&result))),
            turn: 0.0.into(),
        }),
        Rc::new(ToolRecord {
            call: Rc::clone(&call),
            outcome: Rc::new(ToolOutcome::Error(Rc::clone(&tool_failure))),
            turn: 0.0.into(),
        }),
    ]);
    let conversation = Rc::new(conversation);
    // A caller-owned restored/seeded model uses the same canonical facts.
    let mut active = state.as_ref().clone();
    let mut run = active.run.as_ref().clone();
    run.phase = RunPhase::Running { run_id: "r".into() };
    run.core.step_states = Queue::from_items(vec![Rc::new(
        QueueItem::new(Rc::clone(&stage), 0.0, "stage:0").with_status(QueueItemStatus::Running),
    )]);
    active.run = Rc::new(run);
    active.conversation = Some(Rc::clone(&conversation));
    active.instructions = AgentField::Undefined;
    let active = Rc::new(active);
    let request = agent.brain_call(&active);
    assert!(Rc::ptr_eq(&request.payload.conversation, &conversation));
    assert!(Rc::ptr_eq(request.payload.stage.as_ref().unwrap(), &stage));
    assert!(std::ptr::eq(request.payload.context, &context));
    assert!(request.payload.instructions.is_none()); // state, not closed-over config
    assert_eq!(*context.calls.borrow(), ["turnOf", "payloadOf"]);
    let command: demlik_tea::agent::BrainCommandOf<_, _, Parser<'_>> =
        agent.brain().from_record(RunInput {
            key: "audit".into(),
            input: CallValue::shared(Rc::clone(&request)),
        });
    let success = llm.decode(&command, Rc::clone(&answer)).unwrap();
    let Outcome::Ok {
        value: CallValue::Shared(value),
    } = success
    else {
        panic!("success")
    };
    assert!(Rc::ptr_eq(&value.output, &answer));
    let replay: demlik_tea::agent::BrainMessageOf<_, _, Parser<'_>> =
        agent
            .brain()
            .ok(command, CallValue::shared(value), Some(17.25));
    assert_eq!(replay.at().unwrap().number(), Some(17.25));
    let command = agent.brain().from_record(RunInput {
        key: "audit".into(),
        input: CallValue::shared(Rc::clone(&request)),
    });
    context.rejects.set(true);
    let failed = llm.decode(&command, Rc::clone(&answer)).unwrap();
    let Outcome::Err { error } = failed else {
        panic!("typed failure")
    };
    let CauseField::Own(CallValue::Shared(original)) = error.details.cause() else {
        panic!("original cause")
    };
    assert!(Rc::ptr_eq(original, &cause));
    let absent = agent.brain().from_record(RunInput {
        key: "audit".into(),
        input: CallValue::Undefined,
    });
    assert!(matches!(
        llm.decode(&absent, Rc::clone(&answer)),
        Err(LlmCallError::MissingInput { .. })
    ));
    assert_eq!(context.parses.get(), 2);
    let fields = turn_view(&answer);
    assert!(std::ptr::eq(fields, &answer.fields));
    assert!(Rc::ptr_eq(&fields.tool_calls[0], &call));
    assert!(std::ptr::eq(fields.tool_calls[0].args.0, &context));
    assert!(std::ptr::eq(fields.provider.value().unwrap().0, &context));
    assert!(std::ptr::eq(result.0, &context));
    assert!(std::ptr::eq(tool_failure.0, &context));
    let tool = ToolCommand(Rc::clone(&call));
    assert!(Rc::ptr_eq(&tool.0, &call));
    let types = [
        std::any::type_name_of_val(&agent),
        std::any::type_name_of_val(&state),
        std::any::type_name_of_val(&request),
        std::any::type_name_of_val(&replay),
    ];
    for (i, name) in types.iter().enumerate() {
        println!("inferred-{i}: {name}");
    }
    drop(agent); // projection borrows the original answer, not the knob
    context.marker.set(19);
    assert_eq!(answer.extra.get(), 19);
    assert_eq!(fields.tool_calls[0].args.0.marker.get(), 19);
    println!(
        "PASS: borrowed opaque constructor/init/request/projection; exact typed success/cause; canonical aliases; no loop"
    );
}

#[test]
fn stop_predicate_can_retain_the_original_opaque_note_before_end_append() {
    use demlik_tea::agent::{AgentCommand, types::AgentLifecycleNote};
    let context = Context {
        marker: Cell::new(1),
        rejects: Cell::new(false),
        parses: Cell::new(0),
        calls: RefCell::new(vec![]),
    };
    let parser = Rc::new(Parser {
        context: &context,
        cause: Rc::new(ModelFailure(&context)),
    });
    let model_cause = Rc::clone(&parser.cause);
    let schema = Rc::clone(&parser);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schema)),
        |_| Ok("opaque".into()),
    ));
    type Note<'a> = AgentLifecycleNote<Args<'a>, ToolFailure<'a>>;
    let kept: Rc<RefCell<Option<Rc<Note<'_>>>>> = Rc::new(RefCell::new(None));
    let capture = Rc::clone(&kept);
    let ctx = &context;
    let stages = vec![
        Rc::new(Stage(ctx)),
        Rc::new(Stage(ctx)),
        Rc::new(Stage(ctx)),
    ];
    let agent = create_agent(
        AgentConfig::new(
            llm,
            stages.clone(),
            |_| "audit",
            |call| ToolCommand(Rc::clone(call)),
            move |stage,
                  conv: &Rc<
                Conversation<AuditResult<'_>, AuditTurn<'_>, ToolFailure<'_>, Args<'_>>,
            >,
                  prompt| Payload {
                context: ctx,
                stage: stage.cloned(),
                conversation: Rc::clone(conv),
                instructions: prompt.cloned(),
            },
            turn_view,
        )
        .stop_when(move |s| {
            if let Some(note) = s.lifecycle.value().and_then(|n| n.first()) {
                *capture.borrow_mut() = Some(Rc::clone(note));
            }
            true
        }),
    );
    let mut start = agent.start(&agent.init(), "r", 0.0).unwrap();
    let AgentCommand::Brain(command) = start.commands.remove(0) else {
        panic!("brain")
    };
    let call = Rc::new(ToolCall {
        call_id: "a".into(),
        name: "scan".into(),
        args: Rc::new(Args(ctx)),
    });
    let turn = Rc::new(AuditTurn {
        fields: AgentTurn::new("ask".into(), vec![Rc::clone(&call)]),
        extra: &context.marker,
    });
    let message = agent.brain().ok(
        command,
        CallValue::value(llm_call::LlmOk {
            key: "audit".into(),
            purpose: "audit",
            output: turn,
        }),
        Some(1.0),
    );
    let tools = agent.succeed(&start.state, &message, 1.0).unwrap();
    let failure = Rc::new(ToolFailure(ctx));
    let ended = agent
        .tool_err(&tools.state, "a", Rc::clone(&failure), 2.0)
        .unwrap();
    assert!(matches!(ended.state.run.phase, RunPhase::Cancelled { .. }));
    let note = kept.borrow().as_ref().map(Rc::clone).unwrap();
    assert!(Rc::ptr_eq(
        &note,
        &ended.state.lifecycle.value().unwrap()[0]
    ));
    let AgentLifecycleNote::ToolFailed {
        call: original,
        failure: original_failure,
        ..
    } = note.as_ref()
    else {
        panic!("tool note")
    };
    assert!(Rc::ptr_eq(original, &call));
    assert!(Rc::ptr_eq(original_failure, &failure));
    context.marker.set(9);
    let mut step = agent.start(&ended.state, "restart", 10.0).unwrap();
    let mut output = None;
    for (i, stage) in stages.iter().enumerate() {
        assert!(Rc::ptr_eq(
            &agent.current_stage(&step.state).unwrap(),
            stage
        ));
        let AgentCommand::Brain(cmd) = step.commands.remove(0) else {
            panic!("brain stage")
        };
        let final_turn = Rc::new(AuditTurn {
            fields: AgentTurn::new(format!("stage {i}").into(), vec![]),
            extra: &context.marker,
        });
        output = Some(Rc::clone(&final_turn));
        let msg = agent.brain().ok(
            cmd,
            CallValue::value(llm_call::LlmOk {
                key: "audit".into(),
                purpose: "audit",
                output: final_turn,
            }),
            Some(11.0 + i as f64),
        );
        step = agent.succeed(&step.state, &msg, 11.0 + i as f64).unwrap();
    }
    assert!(matches!(step.state.run.phase, RunPhase::Done { .. }));
    assert!(Rc::ptr_eq(
        step.state.output.value().unwrap().as_ref().unwrap(),
        output.as_ref().unwrap()
    ));
    assert!(step.state.conversation.is_none());
    let mut restart = agent.start(&step.state, "failed", 20.0).unwrap();
    let AgentCommand::Brain(cmd) = restart.commands.remove(0) else {
        panic!("failed brain")
    };
    let msg = agent.brain().err(
        cmd,
        demlik_tea::resilience::resilient_call::RunError::port_rejected(
            demlik_tea::llm_call::Rejected::new(CallValue::shared(Rc::clone(&model_cause))),
        ),
        Some(21.0),
    );
    let failed = agent.fail(&restart.state, &msg, 21.0).unwrap();
    let AgentField::Value(Some(failure)) = &failed.state.failure else {
        panic!("agent failure")
    };
    let demlik_tea::agent::types::AgentFailure::Llm {
        error: AgentField::Value(full),
        ..
    } = failure.as_ref()
    else {
        panic!("full error")
    };
    assert_eq!(full.key.as_utf8(), Some("audit"));
    let demlik_tea::llm_call::LlmCause::Value(original) = &full.error else {
        panic!("model cause")
    };
    assert!(Rc::ptr_eq(original, &model_cause));
    drop(agent);
    context.marker.set(9);
    assert_eq!(original_failure.0.marker.get(), 9);
}
