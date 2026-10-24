use demlik_tea::timing::throttled_input::*;
use std::cell::Cell;
#[derive(Debug, PartialEq)]
struct Emit<T>(T);
impl<T> demlik_tea::Tagged for Emit<T> {
    fn tag(&self) -> &str {
        "Emit"
    }
}

#[test]
fn settling_keeps_the_last_value_and_waits_for_the_rate_floor() {
    let knob = create_throttled_input(
        ThrottledInputConfig::new(|value: &String| Emit(value.clone()))
            .throttle(100.0)
            .debounce(10.0)
            .with_cache(500.0, |value: &String| value.clone()),
    );
    let state = knob.init();
    let held = knob.input(&state, "first".into(), 0.0).unwrap();
    let first = knob.on_flush(&held.state, 10.0).unwrap();
    assert_eq!(first.commands, [Emit("first".into())]);
    let held = knob.input(&first.state, "last".into(), 20.0).unwrap();
    assert!(std::ptr::eq(
        &first.state.state().cache.as_ref().unwrap().entries,
        &held.state.state().cache.as_ref().unwrap().entries
    ));
    assert_eq!(knob.subs(&held.state, None)[0].at_ms, 110.0);
    let early = knob.on_flush(&held.state, 30.0).unwrap();
    assert!(early.commands.is_empty());
    assert!(early.state.ptr_eq(&held.state));
    let emitted = knob.on_flush(&early.state, 110.0).unwrap();
    assert_eq!(emitted.commands, [Emit("last".into())]);
    assert!(knob.subs(&emitted.state, None).is_empty());
    assert!(
        knob.on_flush(&emitted.state, 999.0)
            .unwrap()
            .state
            .ptr_eq(&emitted.state)
    );
}

#[test]
fn a_pure_no_cache_gate_accepts_borrowed_non_clone_non_send_non_serializable_values() {
    struct Input<'a>(&'a Cell<u32>);
    let observed = Cell::new(7);
    let config = ThrottledInputConfig::new(|value: &Input<'_>| Emit(value.0.get())).debounce(5.0);
    let initial = init_throttled_input();
    let held = input(&config, &initial, Input(&observed), 0.0).unwrap();
    observed.set(9);
    let emitted = on_flush(&config, &held.state, 5.0).unwrap();
    assert_eq!(emitted.commands, [Emit(9)]);
}

#[test]
fn restored_raw_cache_expiry_keeps_null_coercion_and_accepts_string_keys() {
    use demlik_tea::{PlainData, data::decode_json};
    let raw = decode_json(
        r#"{"lastAt":0,"pending":null,"cache":{"entries":{"a":{"value":"a","expiresAtMs":null}}}}"#,
    )
    .unwrap();
    let state = ThrottledInput::restore_data(raw, |raw| match raw {
        PlainData::String(value) => Ok::<_, &'static str>(value.as_utf8().unwrap().to_owned()),
        _ => Err("not text"),
    })
    .unwrap();
    let knob = create_throttled_input(
        ThrottledInputConfig::new(|value: &String| Emit(value.clone()))
            .with_cache(10.0, |value: &String| value.clone()),
    );
    let emitted = knob.input(&state, "a".into(), 1.0).unwrap();
    assert_eq!(emitted.commands, [Emit("a".into())]);
    let hit = knob.input(&emitted.state, "a".into(), 2.0).unwrap();
    assert!(hit.commands.is_empty());
    assert!(hit.state.ptr_eq(&emitted.state));
    let invalid = decode_json(r#"{"lastAt":null,"pending":{"value":13,"at":null}}"#).unwrap();
    let failure = ThrottledInput::<String>::restore_data(invalid, Err::<String, _>).unwrap_err();
    assert!(matches!(
        failure,
        InputRestoreError::Value(PlainData::Number(13.0))
    ));
}
