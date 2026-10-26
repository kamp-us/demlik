use demlik_tea::{
    agent::{
        conversation::{NO_USAGE, add_usage, dedupe_by_call_id, fold_summary, fresh_conversation},
        types::{
            AgentField, AgentNumber, Awaiting, Conversation, ToolCall, ToolOutcome, ToolRecord,
            TurnUsage,
        },
    },
    data::{JsText, plain_data, stringify_json},
};
use std::{cell::Cell, rc::Rc};

#[test]
fn fresh_conversation_and_usage_sum_keep_optional_presence_without_guarding_arithmetic() {
    let fresh = fresh_conversation::<()>();
    assert!(fresh.turns.is_empty());
    assert!(fresh.tool_records.is_empty());
    assert_eq!(fresh.turn_count, 0.0);
    assert!(matches!(fresh.awaiting, Awaiting::Llm));
    assert!(matches!(
        fresh.context_tokens,
        AgentField::Value(AgentNumber(None))
    ));
    assert_eq!(
        stringify_json(&plain_data(&NO_USAGE).unwrap()).unwrap(),
        r#"{"inputTokens":0,"outputTokens":0}"#
    );
    let mut left = TurnUsage::new(-0.0, f64::MAX);
    left.reasoning_tokens = AgentField::Undefined;
    let mut right = TurnUsage::new(-0.0, f64::MAX);
    right.cached_input_tokens = AgentField::Value(AgentNumber(Some(0.0)));
    let sum = add_usage(&left, &right);
    assert!(sum.input_tokens.number().unwrap().is_sign_negative());
    assert_eq!(sum.output_tokens, f64::INFINITY);
    assert!(matches!(sum.reasoning_tokens, AgentField::Absent));
    assert!(matches!(
        sum.cached_input_tokens,
        AgentField::Value(AgentNumber(Some(0.0)))
    ));
    assert!(matches!(left.cached_input_tokens, AgentField::Absent));
}

struct Opaque<'a>(&'a Cell<u8>);

#[test]
fn conversation_wire_encoding_is_conditional_and_keeps_failed_outcome_data_flat() {
    use demlik_tea::{PlainData, data::decode_json};
    let fresh = fresh_conversation::<PlainData>();
    assert_eq!(
        stringify_json(&plain_data(&fresh).unwrap()).unwrap(),
        r#"{"turns":[],"toolRecords":[],"turnCount":0,"awaiting":{"kind":"llm"},"contextTokens":null}"#
    );
    let failure = Rc::new(ToolOutcome::<PlainData>::Error(Rc::new(
        decode_json(r#"{"kind":"error","reason":"bad","_tag":"denied","detail":{"code":4}}"#)
            .unwrap(),
    )));
    let record = ToolRecord {
        call: Rc::new(ToolCall {
            call_id: "c".into(),
            name: "t".into(),
            args: Rc::new(PlainData::Undefined),
        }),
        outcome: Rc::clone(&failure),
        turn: f64::NAN.into(),
    };
    assert_eq!(
        stringify_json(&plain_data(&record).unwrap()).unwrap(),
        r#"{"call":{"callId":"c","name":"t"},"outcome":{"kind":"error","reason":"bad","_tag":"denied","detail":{"code":4}},"turn":null}"#
    );
}
#[test]
fn dedupe_and_fold_keep_borrowed_opaque_values_and_original_call_outcome_identities() {
    let changed = Cell::new(1);
    let make_call = |id: JsText| {
        Rc::new(ToolCall {
            call_id: id,
            name: "tool".into(),
            args: Rc::new(Opaque(&changed)),
        })
    };
    let first = make_call("x".into());
    let duplicate = make_call("x".into());
    let surviving = make_call(JsText::from_units(vec![0xd800]));
    let calls = [Rc::clone(&first), duplicate, Rc::clone(&surviving)];
    let unique = dedupe_by_call_id(&calls);
    assert_eq!(unique.len(), 2);
    assert!(Rc::ptr_eq(&unique[0], &first));
    assert!(Rc::ptr_eq(&unique[1], &surviving));

    let turns: Vec<_> = (0..3).map(|_| Rc::new(Opaque(&changed))).collect();
    let summary = Rc::new(Opaque(&changed));
    let result = Rc::new(Opaque(&changed));
    let outcome = Rc::new(ToolOutcome::<_, Opaque<'_>>::Ok(Rc::clone(&result)));
    let records: Vec<_> = [0.0, 1.0, 2.0]
        .into_iter()
        .map(|turn| {
            Rc::new(ToolRecord {
                call: Rc::clone(&surviving),
                outcome: Rc::clone(&outcome),
                turn: turn.into(),
            })
        })
        .collect();
    let mut conv = Conversation::fresh();
    conv.turns = Rc::new(turns);
    conv.tool_records = Rc::new(records);
    conv.turn_count = 9.0.into();
    conv.awaiting = Awaiting::Tools {
        batch_turn: 2.0.into(),
    };
    conv.context_tokens = AgentField::Value(33.0.into());
    let folded = fold_summary(&conv, 2.0, Rc::clone(&summary));
    assert_eq!(folded.turns.len(), 2);
    assert!(Rc::ptr_eq(&folded.turns[0], &summary));
    assert!(Rc::ptr_eq(&folded.turns[1], &conv.turns[2]));
    assert_eq!(folded.tool_records.len(), 1);
    assert!(!Rc::ptr_eq(&folded.tool_records[0], &conv.tool_records[2]));
    assert!(Rc::ptr_eq(&folded.tool_records[0].call, &surviving));
    assert!(Rc::ptr_eq(&folded.tool_records[0].outcome, &outcome));
    assert_eq!(folded.tool_records[0].turn, 1.0);
    assert_eq!(folded.turn_count, 9.0);
    assert!(matches!(folded.awaiting, Awaiting::Llm));
    assert!(matches!(
        folded.context_tokens,
        AgentField::Value(AgentNumber(None))
    ));
    changed.set(2);
    assert_eq!(folded.turns[1].0.get(), 2);
    assert_eq!(folded.tool_records[0].call.args.0.get(), 2);
    let ToolOutcome::Ok(retained) = folded.tool_records[0].outcome.as_ref() else {
        panic!("ok")
    };
    assert!(Rc::ptr_eq(retained, &result));
    assert_eq!(retained.0.get(), 2);
    assert_eq!(conv.turns.len(), 3);
    assert_eq!(conv.tool_records[2].turn, 2.0);
    for folding in [-0.75, -0.5, -f64::from_bits(1), -0.0, 0.0] {
        let near_zero = fold_summary(&conv, folding, Rc::clone(&summary));
        assert_eq!(near_zero.turns.len(), 4);
        assert!(Rc::ptr_eq(&near_zero.turns[1], &conv.turns[0]));
    }
}
