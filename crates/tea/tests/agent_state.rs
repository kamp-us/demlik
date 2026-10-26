use demlik_tea::{
    agent::{
        conversation::shared_no_usage,
        types::{
            AgentFailure, AgentField, AgentNumber, AgentState, AwaitingKind, Conversation,
            ToolCall, ToolOutcome, TurnUsage,
        },
    },
    data::JsText,
    flow::{
        fan_out::FanOutState,
        monitored_run::{MonitoredRun, MonitoredRunConfig, RunPhase},
    },
    js_record::JsRecord,
    resilience::resilient_call::{ResilientCall, State},
};
use std::{cell::Cell, rc::Rc};
struct Opaque<'a>(&'a Cell<u8>);
type Owned<'a> = AgentState<
    Opaque<'a>,
    JsText,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
    Opaque<'a>,
>;
fn empty<I, R, E>() -> State<I, R, E> {
    let call: ResilientCall<'_, I, R, E> = ResilientCall::new(Default::default());
    call.init()
}
fn base<'a>(ctx: &'a Cell<u8>) -> Rc<Owned<'a>> {
    let stage = Rc::new(Opaque(ctx));
    let run: MonitoredRun<Opaque<'a>, (), Opaque<'a>> = MonitoredRun::new(MonitoredRunConfig {
        stages: vec![stage],
        ..Default::default()
    });
    Rc::new(AgentState {
        run: run.start(&run.init(), "r", 0.0).state,
        resilience: empty(),
        tools: Rc::new(FanOutState::<
            ToolCall<Opaque<'a>>,
            ToolOutcome<Opaque<'a>, Opaque<'a>>,
            Opaque<'a>,
        >::default()),
        conversation: Some(Rc::new(Conversation::fresh())),
        usage: AgentField::Value(Some(Rc::new(TurnUsage::new(3.0, 4.0)))),
        compaction: AgentField::Value(empty()),
        tool_resilience: AgentField::Value(Rc::new(JsRecord::default())),
        refused_calls: AgentField::Value(Rc::new(vec![])),
        lifecycle: AgentField::Absent,
        failure: AgentField::Value(None),
        output: AgentField::Value(Some(Rc::new(Opaque(ctx)))),
        instructions: AgentField::Value(Some(JsText::from_units(vec![112, 0xd800]))),
    })
}
#[test]
fn no_op_and_migration_keep_original_composed_owners_without_opaque_bounds() {
    let context = Cell::new(7);
    let original = base(&context);
    assert!(Rc::ptr_eq(&original, &original.with_usage_defaults()));
    let total = Rc::new(TurnUsage::new(5.0, 6.0));
    let mut conversation = original.conversation.as_ref().unwrap().as_ref().clone();
    conversation.legacy_usage = AgentField::Value(Some(Rc::clone(&total)));
    conversation.context_tokens = AgentField::Undefined;
    let mut before = original.as_ref().clone();
    before.usage = AgentField::Absent;
    before.conversation = Some(Rc::new(conversation));
    let before = Rc::new(before);
    let after = before.with_usage_defaults();
    assert!(!Rc::ptr_eq(&before, &after));
    assert!(Rc::ptr_eq(&before.run, &after.run));
    assert!(before.resilience.same(&after.resilience));
    assert!(Rc::ptr_eq(&before.tools, &after.tools));
    assert!(
        before
            .compaction
            .value()
            .unwrap()
            .same(after.compaction.value().unwrap())
    );
    assert!(Rc::ptr_eq(
        before.tool_resilience.value().unwrap(),
        after.tool_resilience.value().unwrap()
    ));
    assert!(Rc::ptr_eq(
        before.refused_calls.value().unwrap(),
        after.refused_calls.value().unwrap()
    ));
    let a = before.conversation.as_ref().unwrap();
    let b = after.conversation.as_ref().unwrap();
    assert!(!Rc::ptr_eq(a, b));
    assert!(Rc::ptr_eq(&a.turns, &b.turns));
    assert!(Rc::ptr_eq(&a.tool_records, &b.tool_records));
    assert!(matches!(
        b.context_tokens,
        AgentField::Value(AgentNumber(None))
    ));
    assert!(matches!(b.legacy_usage, AgentField::Absent));
    assert!(Rc::ptr_eq(
        after.usage.value().unwrap().as_ref().unwrap(),
        &total
    ));
    assert!(Rc::ptr_eq(
        after.output.value().unwrap().as_ref().unwrap(),
        before.output.value().unwrap().as_ref().unwrap()
    ));
    context.set(9);
    assert_eq!(after.output.value().unwrap().as_ref().unwrap().0.get(), 9);
}
#[test]
fn null_legacy_usage_is_defined_then_falls_through_and_defaults_share_one_owner() {
    let context = Cell::new(1);
    let original = base(&context);
    let mut before = original.as_ref().clone();
    before.usage = AgentField::Value(None);
    let current = Rc::new(before.clone());
    assert!(Rc::ptr_eq(&current, &current.with_usage_defaults()));
    assert!(matches!(current.usage, AgentField::Value(None)));
    let mut conv = before.conversation.as_ref().unwrap().as_ref().clone();
    conv.legacy_usage = AgentField::Value(None);
    before.conversation = Some(Rc::new(conv));
    let migrated = Rc::new(before).with_usage_defaults();
    let default = shared_no_usage();
    assert!(Rc::ptr_eq(
        migrated.usage.value().unwrap().as_ref().unwrap(),
        &default
    ));
    assert!(matches!(
        migrated.conversation.as_ref().unwrap().legacy_usage,
        AgentField::Absent
    ));
    let mut missing = original.as_ref().clone();
    missing.usage = AgentField::Undefined;
    missing.conversation = None;
    let another = Rc::new(missing).with_usage_defaults();
    assert!(Rc::ptr_eq(
        another.usage.value().unwrap().as_ref().unwrap(),
        &default
    ));
}
#[test]
fn missing_failure_is_terminal_awaiting_returns_the_original_and_stage_survives_cancel() {
    let context = Cell::new(2);
    let original = base(&context);
    let stage = original.current_stage().unwrap();
    assert!(std::ptr::eq(stage.0, &context));
    assert!(!original.is_settled());
    let conv = original.require_awaiting(AwaitingKind::Llm).unwrap();
    assert!(Rc::ptr_eq(conv, original.conversation.as_ref().unwrap()));
    assert!(original.require_awaiting(AwaitingKind::Tools).is_none());
    for failure in [AgentField::Absent, AgentField::Undefined] {
        let mut state = original.as_ref().clone();
        state.failure = failure;
        assert!(state.is_settled());
        assert!(state.require_awaiting(AwaitingKind::Llm).is_none());
    }
    let cause = Rc::new(Opaque(&context));
    let mut state = original.as_ref().clone();
    state.failure = AgentField::Value(Some(Rc::new(AgentFailure::Llm {
        error: AgentField::Value(Rc::clone(&cause)),
        at: AgentNumber(None),
    })));
    assert!(state.is_settled());
    let normalized = Rc::new(state).with_usage_defaults();
    let AgentField::Value(Some(failure)) = &normalized.failure else {
        panic!("failure")
    };
    let AgentFailure::Llm {
        error: AgentField::Value(error),
        at,
    } = failure.as_ref()
    else {
        panic!("llm")
    };
    assert!(Rc::ptr_eq(error, &cause));
    assert_eq!(at.number(), None);
    let mut stopped = original.as_ref().clone();
    let mut run = stopped.run.as_ref().clone();
    run.phase = RunPhase::Cancelled {
        run_id: Some("r".into()),
        at: 1.0.into(),
    };
    stopped.run = Rc::new(run);
    assert!(stopped.is_settled());
    assert!(Rc::ptr_eq(&stopped.current_stage().unwrap(), &stage));
}

#[test]
fn full_state_wire_restores_nullable_facts_and_presence_without_a_second_state_model() {
    use demlik_tea::{
        PlainData,
        agent::types::AgentTurn,
        data::{plain_data, stringify_json},
    };
    type Stored = AgentState<PlainData, JsText, PlainData, PlainData>;
    let run: MonitoredRun<PlainData, ()> = MonitoredRun::new(Default::default());
    let state: Stored = AgentState {
        run: run.init(),
        resilience: empty(),
        tools: Rc::new(FanOutState::default()),
        conversation: None,
        usage: AgentField::Absent,
        compaction: AgentField::Value(empty()),
        tool_resilience: AgentField::Value(Rc::new(JsRecord::default())),
        refused_calls: AgentField::Value(Rc::new(vec![])),
        lifecycle: AgentField::Absent,
        failure: AgentField::Absent,
        output: AgentField::Value(None::<Rc<AgentTurn>>),
        instructions: AgentField::Value(Some(JsText::from_units(vec![0xd800]))),
    };
    let wire = stringify_json(&plain_data(&state).unwrap()).unwrap();
    let cold: Stored = serde_json::from_str(&wire).unwrap();
    assert!(matches!(cold.failure, AgentField::Absent));
    assert!(cold.is_settled());
    assert!(matches!(cold.usage, AgentField::Absent));
    assert_eq!(
        cold.instructions
            .value()
            .unwrap()
            .as_ref()
            .unwrap()
            .as_units(),
        &[0xd800]
    );
    let normalized = Rc::new(cold).with_usage_defaults();
    assert!(Rc::ptr_eq(
        normalized.usage.value().unwrap().as_ref().unwrap(),
        &shared_no_usage()
    ));
    assert!(matches!(normalized.failure, AgentField::Absent));
    let invalid = wire.replace("\"conversation\":null,", "");
    assert!(serde_json::from_str::<Stored>(&invalid).is_err());
    let failure: AgentFailure<PlainData> =
        serde_json::from_str(r#"{"reason":"llm","at":null,"error":{"\ud800":true}}"#).unwrap();
    let AgentFailure::Llm {
        at,
        error: AgentField::Value(error),
    } = failure
    else {
        panic!("llm")
    };
    assert_eq!(at.number(), None);
    assert!(
        stringify_json(&plain_data(&error).unwrap())
            .unwrap()
            .contains("\\ud800")
    );
}
#[test]
fn fanout_restore_uses_the_existing_typed_missing_decoder_and_retains_failure_data() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        flow::fan_out::{FanOutDone, FanOutFailed},
    };
    let done: FanOutDone<PlainData, PlainData> =
        serde_json::from_str(r#"{"item":{"key":"\ud800"}}"#).unwrap();
    assert!(matches!(done.result.as_ref(), PlainData::Undefined));
    assert!(serde_json::from_str::<FanOutDone<PlainData, String>>(r#"{"item":{}}"#).is_err());
    let failed: FanOutFailed<PlainData, PlainData> =
        serde_json::from_str(r#"{"item":null,"error":{"reason":"bad","\udfff":7}}"#).unwrap();
    assert!(
        stringify_json(&plain_data(&failed.error).unwrap())
            .unwrap()
            .contains("\\udfff")
    );
}
#[test]
fn first_running_undefined_does_not_fall_through_and_returned_stage_survives_queue_changes() {
    use demlik_tea::{PlainData, work_queue::Queue};
    let context = Cell::new(3);
    let original = base(&context);
    let stage = original.current_stage().unwrap();
    original.run.core.step_states.items_mut().clear();
    assert!(original.current_stage().is_none());
    drop(original);
    assert_eq!(stage.0.get(), 3);
    let q:Queue<PlainData>=serde_json::from_str(r#"[{"id":"a","status":"running","enqueuedAt":0,"startedAt":0},{"id":"b","status":"running","input":{"later":true},"enqueuedAt":0,"startedAt":0}]"#).unwrap();
    let run: MonitoredRun<PlainData, ()> = MonitoredRun::new(Default::default());
    let mut run_state = run.init().as_ref().clone();
    run_state.core.step_states = q;
    let state: AgentState<PlainData, JsText, PlainData, PlainData> = AgentState {
        run: Rc::new(run_state),
        resilience: empty(),
        tools: Rc::new(FanOutState::default()),
        conversation: None,
        usage: AgentField::Absent,
        compaction: AgentField::Absent,
        tool_resilience: AgentField::Absent,
        refused_calls: AgentField::Absent,
        lifecycle: AgentField::Absent,
        failure: AgentField::Value(None),
        output: AgentField::Absent,
        instructions: AgentField::Absent,
    };
    assert!(matches!(
        state.current_stage().unwrap().as_ref(),
        PlainData::Undefined
    ));
}
