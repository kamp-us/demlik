use demlik_tea::{
    PlainData,
    agent::types::{AGENT_TURN_SCHEMA, is_agent_turn, is_turn_usage},
    data::{decode_json, stringify_json},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
};
use std::rc::Rc;

#[test]
fn guarded_turn_schema_retains_the_original_raw_object_and_unknown_fields() {
    let input = Rc::new(decode_json(r#"{"content":"hi","toolCalls":[{"callId":"c","name":"t","args":[]}],"provider":null,"usage":{"inputTokens":1,"outputTokens":2,"extra":"count"},"extra":{"opaque":1}}"#).unwrap());
    assert!(is_agent_turn(&input));
    let parsed = match AGENT_TURN_SCHEMA.parse(Rc::clone(&input)) {
        Ok(value) => value,
        Err(_) => panic!("the independently valid turn should parse"),
    };
    assert!(Rc::ptr_eq(&parsed, &input));
    assert_eq!(stringify_json(&parsed), stringify_json(&input));
    let bad = Rc::new(decode_json(r#"{"content":"hi","toolCalls":[],"usage":{"inputTokens":9007199254740992,"outputTokens":0}}"#).unwrap());
    assert!(!is_agent_turn(&bad));
    let Err(CallValue::Shared(error)) = AGENT_TURN_SCHEMA.parse(Rc::clone(&bad)) else {
        panic!("out-of-safe-range usage must be a structured parse failure")
    };
    let demlik_tea::agent::StructuredOutputError::Live(error) = error.as_ref() else {
        panic!("fresh turn rejection must be live");
    };
    assert_eq!(error.name(), "Error");
    assert_eq!(
        error.message(),
        "structured-output parse failed: not an AgentTurn"
    );
    assert!(Rc::ptr_eq(error.value(), &bad));
    assert!(!is_turn_usage(&PlainData::Null));
}

#[test]
fn compaction_schema_reuses_the_parser_contract_and_retains_lone_units_and_extras() {
    use demlik_tea::agent::compaction::{
        COMPACTION_PURPOSE, COMPACTION_SUMMARY_SCHEMA, CompactionPurpose, is_compaction_summary,
    };
    use demlik_tea::llm_call::Purpose;
    let input = Rc::new(decode_json(r#"{"summary":"\ud800","extra":{"opaque":1}}"#).unwrap());
    assert!(is_compaction_summary(&input));
    let parsed = COMPACTION_SUMMARY_SCHEMA
        .parse(Rc::clone(&input))
        .unwrap_or_else(|_| panic!("valid summary"));
    assert!(Rc::ptr_eq(&parsed, &input));
    assert_eq!(COMPACTION_PURPOSE, CompactionPurpose::Compact);
    assert_eq!(COMPACTION_PURPOSE.key().as_utf8(), Some("$compact"));
    let rejected = Rc::new(decode_json(r#"{"summary":1}"#).unwrap());
    let Err(CallValue::Shared(error)) = COMPACTION_SUMMARY_SCHEMA.parse(Rc::clone(&rejected))
    else {
        panic!("a non-string summary must fail")
    };
    let demlik_tea::agent::StructuredOutputError::Live(error) = error.as_ref() else {
        panic!("fresh summary rejection must be live");
    };
    assert_eq!(
        error.message(),
        "structured-output parse failed: not a CompactionSummary"
    );
    assert!(Rc::ptr_eq(error.value(), &rejected));
}

#[test]
fn the_actual_llm_decoder_uses_the_builtin_guard_schema_without_rebuilding_output() {
    use demlik_tea::{
        agent::StructuredOutputError,
        command::Outcome,
        llm_call::{Config, LlmCall, Request},
    };
    let schema = Rc::new(AGENT_TURN_SCHEMA);
    let llm: LlmCall<'_, &str, (), _> = LlmCall::new(
        Config::new(move |_| Rc::clone(&schema)),
        StructuredOutputError::describe,
    );
    let attempted = llm
        .attempt(&llm.init(), Rc::new(Request::new("turn", None, ())), 0.0)
        .unwrap();
    let raw = Rc::new(decode_json(r#"{"content":"answer","toolCalls":[],"extra":{"kept":true},"usage":{"inputTokens":0,"outputTokens":0,"cachedInputTokens":9}}"#).unwrap());
    let outcome = llm.decode(&attempted.commands[0], Rc::clone(&raw)).unwrap();
    let Outcome::Ok {
        value: CallValue::Shared(ok),
    } = outcome
    else {
        panic!("accepted guarded output")
    };
    assert!(Rc::ptr_eq(&ok.output, &raw));
    assert_eq!(ok.key.as_utf8(), Some("turn"));
}
