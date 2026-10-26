use demlik_tea::agent::conversation::shared_no_usage;
use std::rc::Rc;

#[test]
fn default_usage_retains_one_original_owner_in_the_local_agent_domain() {
    let first = shared_no_usage();
    let second = shared_no_usage();
    assert!(Rc::ptr_eq(&first, &second));
    assert_eq!(first.input_tokens, 0.0);
    assert_eq!(first.output_tokens, 0.0);
}

use demlik_tea::{
    PlainData,
    agent::{
        conversation::{add_usage, fold_summary},
        types::{
            AgentField, AgentNumber, Awaiting, Conversation, ToolCall, ToolOutcome, ToolRecord,
            TurnUsage, is_turn_usage,
        },
    },
    data::{decode_json, plain_data, stringify_json},
};
use std::cell::Cell;
struct Opaque<'a>(&'a Cell<u8>);
#[test]
fn shallow_conversation_copy_retains_arrays_and_opaque_objects_while_fold_allocates_arrays() {
    let context = Cell::new(7);
    let opaque = Rc::new(Opaque(&context));
    let call = Rc::new(ToolCall {
        call_id: "c".into(),
        name: "t".into(),
        args: Rc::clone(&opaque),
    });
    let outcome = Rc::new(ToolOutcome::<_, Opaque<'_>>::Ok(Rc::clone(&opaque)));
    let original: Conversation<Opaque<'_>, Opaque<'_>, Opaque<'_>, Opaque<'_>> = Conversation {
        turns: Rc::new(vec![Rc::clone(&opaque)]),
        tool_records: Rc::new(vec![Rc::new(ToolRecord {
            call: Rc::clone(&call),
            outcome: Rc::clone(&outcome),
            turn: AgentNumber(None),
        })]),
        turn_count: AgentNumber(None),
        awaiting: Awaiting::Tools {
            batch_turn: AgentNumber(None),
        },
        context_tokens: AgentField::Value(AgentNumber(None)),
        legacy_usage: AgentField::Value(None),
    };
    let copied = original.clone();
    assert!(Rc::ptr_eq(&original.turns, &copied.turns));
    assert!(Rc::ptr_eq(&original.tool_records, &copied.tool_records));
    assert!(matches!(copied.legacy_usage, AgentField::Value(None)));
    assert!(matches!(
        copied.context_tokens,
        AgentField::Value(AgentNumber(None))
    ));
    let folded = fold_summary(&original, 0.0, Rc::clone(&opaque));
    assert!(!Rc::ptr_eq(&original.turns, &folded.turns));
    assert!(!Rc::ptr_eq(&original.tool_records, &folded.tool_records));
    assert!(Rc::ptr_eq(&folded.turns[1], &opaque));
    assert!(Rc::ptr_eq(&folded.tool_records[0].outcome, &outcome));
    assert!(Rc::ptr_eq(&folded.tool_records[0].call, &call));
    assert_eq!(folded.tool_records[0].turn, 1.0);
    assert_eq!(original.tool_records[0].turn.number(), None);
    assert_eq!(folded.turn_count.number(), None);
    assert!(matches!(folded.legacy_usage, AgentField::Value(None)));
    context.set(9);
    assert_eq!(folded.turns[1].0.get(), 9);
}
#[test]
fn restored_nulls_remain_data_until_usage_arithmetic_and_guards_stay_strict() {
    let raw = r#"{"inputTokens":null,"outputTokens":null,"reasoningTokens":null}"#;
    let left: TurnUsage = serde_json::from_str(raw).unwrap();
    assert_eq!(left.input_tokens.number(), None);
    assert!(!is_turn_usage(&decode_json(raw).unwrap()));
    let sum = add_usage(&left, &TurnUsage::new(2.0, 3.0));
    let encoded = plain_data(&sum).unwrap();
    assert_eq!(
        stringify_json(&encoded).unwrap(),
        r#"{"inputTokens":2,"outputTokens":3,"reasoningTokens":0}"#
    );
    assert_eq!(left.output_tokens.number(), None);
    assert!(matches!(sum.cached_input_tokens, AgentField::Absent));
}
#[test]
fn conditional_conversation_wire_retains_null_legacy_presence_and_lossless_opaque_payloads() {
    type Conv = Conversation<PlainData, PlainData, PlainData, PlainData>;
    let raw = r#"{"turns":[{"text":"\ud800"}],"toolRecords":[{"call":{"callId":"c","name":"t","args":{"\udfff":1}},"outcome":{"kind":"ok"},"turn":null}],"turnCount":null,"awaiting":{"kind":"tools","batchTurn":null},"contextTokens":null,"usage":null}"#;
    let parsed: Conv = serde_json::from_str(raw).unwrap();
    assert!(matches!(parsed.legacy_usage, AgentField::Value(None)));
    assert_eq!(parsed.turn_count.number(), None);
    assert_eq!(parsed.tool_records[0].turn.number(), None);
    let ToolOutcome::Ok(result) = parsed.tool_records[0].outcome.as_ref() else {
        panic!("ok")
    };
    assert!(matches!(result.as_ref(), PlainData::Undefined));
    let round = stringify_json(&plain_data(&parsed).unwrap()).unwrap();
    let again: Conv = serde_json::from_str(&round).unwrap();
    assert_eq!(round, stringify_json(&plain_data(&again).unwrap()).unwrap());
    assert!(round.contains("\\ud800") && round.contains("\\udfff"));
}
