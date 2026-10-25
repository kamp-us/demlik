use demlik_tea::{
    PlainData,
    command::{CmdDef, Outcome, Settled},
    data::{NumberOrNull, plain_data, stringify_json},
    resilience::resilient_call::{CallValue, RunError, RunInput, RunSpec},
};
type Spec = RunSpec<PlainData, PlainData, PlainData>;
fn command() -> demlik_tea::command::Cmd<Spec> {
    CmdDef::<Spec>::new().from_record(RunInput {
        key: "plan".into(),
        input: CallValue::value(PlainData::String("prompt".into())),
    })
}

#[test]
fn actual_settlements_restore_json_null_without_turning_it_into_an_absent_stamp() {
    let definition = CmdDef::<Spec>::new();
    for at in [17.25, 0.0, -0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for error in [false, true] {
            let outcome = if error {
                Outcome::err(RunError::port_rejected(PlainData::Object(
                    Default::default(),
                )))
            } else {
                Outcome::ok(CallValue::value(PlainData::String("parsed".into())))
            };
            let message = definition
                .settle(command(), Some(outcome), at)
                .unwrap()
                .unwrap();
            assert!(message.at().unwrap().number().is_some());
            let encoded = stringify_json(&plain_data(&message).unwrap()).unwrap();
            let restored: Settled<Spec> = serde_json::from_str(&encoded).unwrap();
            let stamp = restored.at().expect("a null field is still present");
            if at.is_finite() {
                assert_eq!(stamp.number(), Some(at));
            } else {
                assert_eq!(stamp, NumberOrNull(None));
                assert!(encoded.contains("\"at\":null"));
                assert_eq!(stamp.number_or_zero(), 0.0);
            }
            assert_eq!(
                stringify_json(&plain_data(&restored).unwrap()).unwrap(),
                encoded
            );
            assert!(restored.engine_stamp().is_none());
        }
    }
    let unstamped = definition.ok(command(), CallValue::value(PlainData::Null), None);
    let encoded = stringify_json(&plain_data(&unstamped).unwrap()).unwrap();
    assert!(!encoded.contains("\"at\""));
    let restored: Settled<Spec> = serde_json::from_str(&encoded).unwrap();
    assert!(restored.at().is_none());
}

#[test]
fn the_canonical_number_keeps_compatibility_constructor_paths_and_refuses_manual_other_kinds() {
    use demlik_tea::work_queue::QueueTime;
    let time: NumberOrNull = QueueTime(Some(17.25));
    assert_eq!(time.number(), Some(17.25));
    let null: QueueTime = serde_json::from_str("null").unwrap();
    assert_eq!(null, NumberOrNull(None));
    for text in ["true", "\"7\"", "{}", "[]"] {
        assert!(serde_json::from_str::<NumberOrNull>(text).is_err());
    }
}
