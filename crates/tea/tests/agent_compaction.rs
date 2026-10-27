use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, PlainCalls, PlainToolCall, StructuredOutputError,
        compaction::{CompactErr, CompactOk, CompactionPolicy, CompactionPurpose},
        conversation::fold_summary,
        create_agent,
        types::{AGENT_TURN_SCHEMA, AgentField, Conversation},
    },
    data::{JsText, decode_json},
    llm_call::{self, LlmCall, LlmCause, LlmErr, LlmOk},
    resilience::resilient_call::{CallFailure, CallPhase, CallValue},
};
use std::{cell::Cell, rc::Rc};
struct Tool(Rc<PlainToolCall>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        self.0.name().as_utf8().unwrap()
    }
}
type History = Conversation<PlainData, PlainData, PlainData, PlainData, PlainCalls>;
fn llm() -> Rc<LlmCall<'static, JsText, (), demlik_tea::agent::GuardedSchema>> {
    let schema = Rc::new(AGENT_TURN_SCHEMA);
    Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &JsText| Rc::clone(&schema)),
        StructuredOutputError::describe,
    ))
}
fn turn(id: &str) -> Rc<PlainData> {
    Rc::new(decode_json(&format!(r#"{{"content":"invoice","toolCalls":[{{"callId":"{id}","name":"collect","args":{{"kept":true}}}}]}}"#)).unwrap())
}
macro_rules! two_drains {
    ($agent:expr) => {{
        let a = &$agent;
        let mut state = a.start(&a.init(), "r", 0.0).unwrap().state;
        state = a.turn(&state, turn("a"), 1.0).unwrap().state;
        state = a
            .tool_ok(&state, "a", Rc::new(PlainData::Null), 2.0)
            .unwrap()
            .state;
        state = a.turn(&state, turn("b"), 3.0).unwrap().state;
        a.tool_ok(&state, "b", Rc::new(PlainData::Null), 4.0)
            .unwrap()
            .state
    }};
}
// Contract: a real typed compact path retains opaque borrowed data and causes.
// Regression: add Clone/serde/static bounds or rebuild a command/result owner.
// Old tests never enter compacting; no test-only production seam is used.
#[test]
fn borrowed_opaque_compaction_retains_payload_result_and_cause() {
    struct Cause<'a> {
        text: &'a str,
        marker: Rc<Cell<u32>>,
    }
    struct Summary<'a> {
        text: &'a str,
    }
    let text = String::from("original");
    let borrowed = text.as_str();
    let original = Rc::new(Cell::new(7));
    let marker = Rc::clone(&original);
    let held = Rc::new(std::cell::RefCell::new(None::<Rc<History>>));
    let payload = Rc::clone(&held);
    let policy = CompactionPolicy::new(
        |history: &Rc<History>| if history.turns.len() >= 2 { 2.0 } else { 0.0 },
        move |history, _| {
            payload.replace(Some(Rc::clone(history)));
            (Rc::clone(history), borrowed)
        },
        |summary: &Summary<'_>| {
            Ok(Rc::new(
                decode_json(&format!(
                    r#"{{"content":"{}","toolCalls":[]}}"#,
                    summary.text
                ))
                .unwrap(),
            ))
        },
    );
    let agent = create_agent(
        AgentConfig::from_plain_turns(
            llm(),
            vec![Rc::new(())],
            |_| "invoice".into(),
            |call| Tool(Rc::clone(call)),
            |_, _, _| (),
        )
        .with_compaction(policy)
        .expect("select before predicate"),
    );
    let state = two_drains!(agent);
    let held = held.borrow().as_ref().unwrap().clone();
    let compact = state.compaction.value().unwrap();
    let Some(CallPhase::Running {
        input: CallValue::Shared(input),
        ..
    }) = compact.call("$compact")
    else {
        panic!("running compact")
    };
    assert!(Rc::ptr_eq(&input.payload.0, &held));
    assert_eq!(input.payload.1, borrowed);
    let output = Rc::new(LlmOk {
        key: "$compact".into(),
        purpose: CompactionPurpose::Compact,
        output: Summary { text: borrowed },
    });
    let ok = CompactOk {
        key: "$compact".into(),
        result: Rc::clone(&output),
        at: 5.0,
    };
    let folded = agent.compact_ok(&state, &ok.key, &ok, 5.0).unwrap().state;
    let Some(CallPhase::Succeeded {
        result: CallValue::Shared(actual),
    }) = folded.compaction.value().unwrap().call("$compact")
    else {
        panic!("settled output")
    };
    assert!(Rc::ptr_eq(actual, &output));
    assert_eq!(actual.output.text, borrowed);
    let cause = Rc::new(Cause {
        text: borrowed,
        marker,
    });
    let err = CompactErr {
        key: "$compact".into(),
        error: Rc::new(LlmErr {
            key: "$compact".into(),
            purpose: CompactionPurpose::Compact,
            reason: "opaque".into(),
            error: LlmCause::Value(Rc::clone(&cause)),
        }),
        at: 6.0,
    };
    let resumed = agent
        .compact_err(&state, &err.key, &err, 6.0)
        .unwrap()
        .state;
    let Some(CallPhase::Failed { error }) = resumed.compaction.value().unwrap().call("$compact")
    else {
        panic!("exhausted compact")
    };
    let CallFailure::External(error) = error.as_ref() else {
        panic!("original business error")
    };
    let LlmCause::Value(actual) = &error.error else {
        panic!("original cause")
    };
    assert!(Rc::ptr_eq(actual, &cause));
    assert!(Rc::ptr_eq(&actual.marker, &original));
    assert_eq!(actual.text, borrowed);
}
// Contract: refusing an old-state predicate keeps both supplied owners recoverable.
// Regression: silently discard/reproject the predicate or lose the supplied policy.
// Existing OFF configuration never changes the state's compaction data family.
#[test]
fn profile_refusal_retains_original_predicate_and_policy() {
    let calls = Rc::new(Cell::new(0));
    let original = Rc::clone(&calls);
    let config = AgentConfig::from_plain_turns(
        llm(),
        vec![Rc::new(())],
        |_| "invoice".into(),
        |call| Tool(Rc::clone(call)),
        |_, _, _| (),
    )
    .stop_when(move |_| {
        calls.set(calls.get() + 1);
        false
    });
    let plans = Rc::new(Cell::new(0));
    let counter = Rc::clone(&plans);
    let policy: CompactionPolicy<'_, History, PlainData, PlainData, Rc<PlainData>, ()> =
        CompactionPolicy::from_plain(
            move |history| {
                counter.set(counter.get() + 1);
                if history.turns.len() >= 2 { 2.0 } else { 0.0 }
            },
            |_, _| PlainData::Null,
        );
    let refusal = config
        .with_compaction(policy)
        .err()
        .expect("must refuse incompatible predicate");
    assert_eq!(
        format!("{refusal}"),
        "select compaction before configuring stop_when"
    );
    let recovered = create_agent(*refusal.config);
    let _ = two_drains!(recovered);
    assert_eq!(original.get(), 2);
    let mut next = AgentConfig::from_plain_turns(
        llm(),
        vec![Rc::new(())],
        |_| "invoice".into(),
        |call| Tool(Rc::clone(call)),
        |_, _, _| (),
    )
    .with_compaction(*refusal.policy)
    .expect("policy is recoverable");
    let enabled = Rc::new(Cell::new(0));
    let callback = Rc::clone(&enabled);
    next = next.stop_when(move |state| {
        assert!(matches!(state.compaction, AgentField::Value(_)));
        callback.set(callback.get() + 1);
        false
    });
    let resumed = create_agent(next);
    let state = two_drains!(resumed);
    assert_eq!(enabled.get(), 2);
    assert_eq!(plans.get(), 2);
    assert!(matches!(
        state.conversation.as_ref().unwrap().awaiting,
        demlik_tea::agent::types::Awaiting::Compacting { .. }
    ));
}
// Contract: the existing four-argument turbofish remains source-compatible.
// Regression: adding V directly to the public function breaks old callers.
// Existing behavioral cases inferred all type arguments and would miss this.
#[test]
fn legacy_four_argument_fold_keeps_original_turn() {
    struct Opaque;
    let original: Conversation<(), Opaque, (), ()> = Conversation::fresh();
    let summary = Rc::new(Opaque);
    let folded = fold_summary::<(), Opaque, (), ()>(&original, 0.0, Rc::clone(&summary));
    assert!(Rc::ptr_eq(&folded.turns[0], &summary));
}
