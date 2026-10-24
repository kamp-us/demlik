use std::rc::Rc;

use demlik_tea::paginate::paginator::*;

#[test]
fn cursor_walk_is_a_two_way_backpressure_valve() {
    struct Cursor<'a>(&'a str);
    let token = String::from("first");
    let policy = PaginatorPolicy::new(Cursor(&token), 3.0);
    let idle = init_paginator();
    assert!(
        start(&idle, &policy)
            .cursor()
            .is_some_and(|c| c.0 == "first")
    );
    let fetching = start(&idle, &policy);
    assert!(fetching.ptr_eq(&start(&fetching, &policy)));
    let next = Rc::new(Cursor("next"));
    let paused = record_page(&fetching, 3.0, Some(next.clone()), &policy);
    assert_eq!(paused.phase_name(), "paused");
    assert!(Rc::ptr_eq(paused.cursor().unwrap(), &next));
    assert!(paused.ptr_eq(&resume(&paused, &policy)));
    assert!(paused.ptr_eq(&record_page(&paused, 7.0, None, &policy)));
    let drained = drain(&paused, 1.0);
    assert_eq!(paused.seen(), 3.0);
    assert_eq!(drained.seen(), 2.0);
    let fetching = resume(&drained, &policy);
    let done = record_page(&fetching, 2.0, None, &policy);
    assert!(is_done(&done));
    assert_eq!((done.seen(), done.pages()), (4.0, 2.0));
    assert!(done.ptr_eq(&start(&done, &policy)));
    assert!(done.ptr_eq(&resume(&done, &policy)));
    assert_eq!(drain(&done, f64::INFINITY).seen(), 0.0);
}

#[test]
fn numeric_rules_follow_javascript_including_nan_and_signed_zero() {
    let policy = PaginatorPolicy::new(0, 1.0);
    let fetching = start(&init_paginator(), &policy);
    for count in [-3.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let next = record_page(&fetching, count, Some(Rc::new(1)), &policy);
        assert_eq!(next.seen(), 0.0);
        assert_eq!(next.phase_name(), "fetching");
    }
    let next = record_page(&fetching, 0.25, Some(Rc::new(1)), &policy);
    assert!(next.ptr_eq(&drain(&next, 0.0)));
    assert!(drain(&next, f64::NAN).seen().is_nan());
    let poisoned = PaginatorState::from_snapshot(PaginatorSnapshot {
        phase: PaginatorPhase::Paused {
            cursor: Rc::new(7).into(),
        },
        seen: f64::NAN.into(),
        pages: f64::INFINITY.into(),
    });
    assert!(poisoned.ptr_eq(&resume(&poisoned, &policy)));
    let negative_zero = PaginatorState::<i32>::from_snapshot(PaginatorSnapshot {
        phase: PaginatorPhase::Idle,
        seen: (-0.0).into(),
        pages: 0.0.into(),
    });
    // Math.max produces +0, but === sees equal and the original object survives.
    assert!(negative_zero.ptr_eq(&drain(&negative_zero, 1.0)));
    assert!(negative_zero.seen().is_sign_negative());
}

#[test]
fn explicit_json_boundary_round_trips_cursor_data() {
    let policy = PaginatorPolicy::new(vec!["cursor"], 1.0);
    let state = start(&init_paginator(), &policy);
    let encoded = serde_json::to_string(&state).unwrap();
    assert_eq!(
        encoded,
        r#"{"phase":"fetching","cursor":["cursor"],"seen":0,"pages":0}"#
    );
    let restored: PaginatorState<Vec<String>> = serde_json::from_str(&encoded).unwrap();
    assert_eq!(restored.cursor().unwrap().as_slice(), ["cursor"]);
    assert_eq!(default_paginator_policy().high_water_mark, 1000.0);
}

#[test]
fn json_null_counter_is_preserved_then_coerced_by_the_next_transition() {
    let state: PaginatorState<()> =
        serde_json::from_str(r#"{"phase":"idle","seen":null,"pages":null}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&state).unwrap(),
        r#"{"phase":"idle","seen":null,"pages":null}"#
    );
    let started = start(&state, &PaginatorPolicy::new((), 0.0));
    assert_eq!(
        serde_json::to_string(&started).unwrap(),
        r#"{"phase":"fetching","cursor":null,"seen":null,"pages":null}"#
    );
    let done = record_page(&started, 2.5, None, &PaginatorPolicy::new((), 0.0));
    assert_eq!((done.seen(), done.pages()), (2.5, 1.0));
    assert!(!state.ptr_eq(&drain(&state, 1.0))); // 0 !== null
}

#[test]
fn raw_cursor_restore_preserves_lone_units_null_and_missing_properties() {
    use demlik_tea::{
        PlainData,
        data::{JsText, plain_data, stringify_json},
    };
    let cursor = JsText::from_units(vec![0xd800]);
    let state = start(
        &init_paginator(),
        &PaginatorPolicy::new(PlainData::String(cursor.clone()), 1.0),
    );
    let raw = stringify_json(&plain_data(&state).unwrap()).unwrap();
    assert_eq!(
        raw,
        r#"{"phase":"fetching","cursor":"\ud800","seen":0,"pages":0}"#
    );
    let restored: PaginatorState<PlainData> = serde_json::from_str(&raw).unwrap();
    assert!(
        matches!(restored.cursor().unwrap().as_ref(),PlainData::String(value) if value==&cursor)
    );
    let missing: PaginatorState<PlainData> =
        serde_json::from_str(r#"{"phase":"paused","seen":0,"pages":1}"#).unwrap();
    let next = resume(&missing, &PaginatorPolicy::new(PlainData::Null, 1.0));
    assert!(matches!(
        next.snapshot().phase,
        PaginatorPhase::Fetching {
            cursor: PaginatorCursor::Undefined
        }
    ));
    let PlainData::Object(fields) = plain_data(&next).unwrap() else {
        panic!("object")
    };
    assert!(matches!(fields.get("cursor"), Some(PlainData::Undefined)));
    let null: PaginatorState<PlainData> =
        serde_json::from_str(r#"{"phase":"fetching","cursor":null,"seen":0,"pages":1}"#).unwrap();
    assert!(matches!(null.cursor().unwrap().as_ref(), PlainData::Null));
}

#[test]
fn json_number_overflow_reaches_the_numeric_transition_without_rejection() {
    let raw = r#"{"phase":"fetching","cursor":"a","seen":1e400,"pages":1e400}"#;
    let state: PaginatorState<String> = serde_json::from_str(raw).unwrap();
    assert_eq!(
        (state.seen(), state.pages()),
        (f64::INFINITY, f64::INFINITY)
    );
    let done = record_page(&state, 1.0, None, &PaginatorPolicy::new("a".into(), 0.0));
    assert!(is_done(&done));
    assert_eq!(done.seen(), f64::INFINITY);
    let normal: PaginatorCount = serde_json::from_value(serde_json::json!(0.25)).unwrap();
    assert_eq!(normal.number(), 0.25);
}
