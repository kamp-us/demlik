use demlik_tea::{
    PlainData,
    agent::{GuardedSchema, PlainCalls, StateOf, StructuredOutputError, types::AGENT_TURN_SCHEMA},
    data::{JsText, decode_json, stringify_json},
    llm_call::{LlmCause, LlmErr, Schema},
    resilience::resilient_call::CallValue,
};
use std::rc::Rc;

#[test]
fn default_guard_error_has_the_source_empty_object_wire() {
    let invalid = Rc::new(decode_json("null").unwrap());
    let Err(CallValue::Shared(error)) = AGENT_TURN_SCHEMA.parse(Rc::clone(&invalid)) else {
        panic!("the actual default guard must reject null");
    };
    let StructuredOutputError::Live(live) = error.as_ref() else {
        panic!("a fresh rejection is live");
    };
    assert!(Rc::ptr_eq(live.value(), &invalid));
    assert_eq!(live.name(), "Error");
    assert_eq!(
        error.describe().unwrap().as_utf8(),
        Some("structured-output parse failed: not an AgentTurn")
    );
    let bytes = serde_json::to_string(error.as_ref()).unwrap();
    assert_eq!(bytes, "{}");
    let decoded: StructuredOutputError = serde_json::from_str(&bytes).unwrap();
    let StructuredOutputError::Plain(value) = &decoded else {
        panic!("JSON does not revive a live rejection");
    };
    assert_eq!(stringify_json(value).as_deref(), Some("{}"));
    assert_eq!(
        decoded.describe().unwrap().as_utf8(),
        Some("[object Object]")
    );
}

#[test]
fn plain_error_description_preserves_values_and_coercion_failures() {
    for (json, expected) in [
        ("null", "null"),
        ("true", "true"),
        ("17.25", "17.25"),
        (r#""invoice""#, "invoice"),
        ("[1,null,{}]", "1,,[object Object]"),
        (
            r#"{"message":"not an Error","name":"Error"}"#,
            "[object Object]",
        ),
        ("1e400", "Infinity"),
    ] {
        let error: StructuredOutputError = serde_json::from_str(json).unwrap();
        assert!(matches!(error, StructuredOutputError::Plain(_)));
        assert_eq!(error.describe().unwrap().as_utf8(), Some(expected));
    }
    let error: StructuredOutputError = serde_json::from_str(r#"{"toString":0}"#).unwrap();
    let failure = error.describe().unwrap_err();
    assert_eq!(failure.name, "TypeError");
    assert_eq!(failure.message, "Cannot convert object to primitive value");
    let undefined = StructuredOutputError::Plain(Rc::new(PlainData::Undefined));
    assert!(serde_json::to_string(&undefined).is_err());
}

#[test]
fn decoded_metadata_and_lone_units_do_not_manufacture_live_diagnostics() {
    let bytes = r#"{"name":"Error","message":"invented","value":{"opaque":1},"expected":"an AgentTurn","extra":"\ud800","__proto__":{"kept":true}}"#;
    let error: StructuredOutputError = serde_json::from_str(bytes).unwrap();
    let StructuredOutputError::Plain(value) = &error else {
        panic!("plain metadata")
    };
    let expected = decode_json(bytes).unwrap();
    assert_eq!(stringify_json(value), stringify_json(&expected));
    assert_eq!(serde_json::to_string(&error).unwrap(), bytes);
    assert_eq!(error.describe().unwrap().as_utf8(), Some("[object Object]"));
}

#[test]
fn json_occurrences_do_not_claim_the_pre_save_shared_error_identity() {
    let Err(CallValue::Shared(error)) = AGENT_TURN_SCHEMA.parse(Rc::new(PlainData::Null)) else {
        panic!("guard")
    };
    let occurrences = [Rc::clone(&error), Rc::clone(&error)];
    assert!(Rc::ptr_eq(&occurrences[0], &occurrences[1]));
    let bytes = serde_json::to_string(&occurrences).unwrap();
    assert_eq!(bytes, "[{},{}]");
    let decoded: Vec<Rc<StructuredOutputError>> = serde_json::from_str(&bytes).unwrap();
    assert!(!Rc::ptr_eq(&decoded[0], &decoded[1]));
    let (StructuredOutputError::Plain(a), StructuredOutputError::Plain(b)) =
        (decoded[0].as_ref(), decoded[1].as_ref())
    else {
        panic!("plain occurrences")
    };
    assert!(!Rc::ptr_eq(a, b));
}

#[test]
fn full_default_state_codec_is_conditional_on_its_actual_fields_only() {
    type State = StateOf<
        (),
        JsText,
        PlainData,
        GuardedSchema,
        PlainData,
        PlainData,
        PlainData,
        PlainData,
        PlainCalls,
    >;
    fn codec<T: serde::Serialize + serde::de::DeserializeOwned>() {}
    codec::<State>();
}

#[test]
fn persisted_outer_reason_and_cause_presence_remain_distinct() {
    let with_null: LlmErr<String, StructuredOutputError> = serde_json::from_str(
        r#"{"key":"x","purpose":"x","reason":"original reason","error":null}"#,
    )
    .unwrap();
    assert_eq!(with_null.reason.as_utf8(), Some("original reason"));
    let LlmCause::Value(error) = with_null.error else {
        panic!("present null cause")
    };
    assert!(
        matches!(error.as_ref(),StructuredOutputError::Plain(value) if matches!(value.as_ref(), PlainData::Null))
    );
    let missing: LlmErr<String, StructuredOutputError> =
        serde_json::from_str(r#"{"key":"x","purpose":"x","reason":"original reason"}"#).unwrap();
    assert!(matches!(missing.error, LlmCause::Missing));
}
