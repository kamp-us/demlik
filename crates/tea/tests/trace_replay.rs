use demlik_tea::persistence::{
    recorder::Trace,
    trace_replay::{ReplayError, deep_equal, first_divergence, replay_trace_with, state_walk},
};
use demlik_tea::{
    Machine, PlainData, Step, Sub, Tagged, Update,
    data::{JsText, decode_json},
    js_record::RecordValue,
};
use std::{cell::Cell, rc::Rc, sync::Arc};
fn data(value: &str) -> PlainData {
    decode_json(value).unwrap()
}
#[test]
fn structural_walk_uses_object_is_sorted_utf16_keys_and_source_path_grammar() {
    assert!(deep_equal(
        &PlainData::Number(f64::NAN),
        &PlainData::Number(f64::from_bits(0x7ff8_0000_0000_0001))
    ));
    assert!(!deep_equal(
        &PlainData::Number(0.0),
        &PlainData::Number(-0.0)
    ));
    assert!(deep_equal(
        &data(r#"{"b":2,"a":1}"#),
        &data(r#"{"a":1,"b":2}"#)
    ));
    let expected = data(r#"{"z":0,"items":[{"status":"done"},{"status":"done"}]}"#);
    let actual = data(r#"{"items":[{"status":"done"},{"status":"pending"}],"z":1}"#);
    let difference = first_divergence(&expected, &actual, "state").unwrap();
    assert_eq!(difference.path.as_utf8(), Some("state.items[1].status"));
    assert!(
        matches!(difference.expected,RecordValue::Entry(PlainData::String(text)) if text.as_utf8()==Some("done"))
    );
    assert_eq!(
        first_divergence(&data("[1,2]"), &data("[1]"), "state")
            .unwrap()
            .path
            .as_utf8(),
        Some("state")
    );
    let key = JsText::from_units(vec![0xd800]);
    let path = state_walk::key_path("state", &key);
    assert_eq!(
        path.as_units(),
        ["state.".encode_utf16().collect::<Vec<_>>(), vec![0xd800]].concat()
    );
    assert_eq!(
        state_walk::index_path("state.a", -0.0).as_utf8(),
        Some("state.a[0]")
    );
    assert_eq!(
        state_walk::index_path("state", f64::NAN).as_utf8(),
        Some("state[NaN]")
    );
    assert_eq!(
        state_walk::type_of(&PlainData::Undefined),
        state_walk::ValueType::Undefined
    );
}
#[test]
fn ordinary_missing_properties_and_pristine_prototype_reads_share_the_record_owner() {
    let mut own = indexmap::IndexMap::new();
    own.insert("a".into(), PlainData::Undefined);
    let own = PlainData::Object(own);
    assert!(deep_equal(&data("{}"), &own));
    let mut builtin = indexmap::IndexMap::new();
    builtin.insert("toString".into(), PlainData::Undefined);
    let builtin = PlainData::Object(builtin);
    let difference = first_divergence(&data("{}"), &builtin, "state").unwrap();
    assert_eq!(difference.path.as_utf8(), Some("state.toString"));
    assert!(matches!(
        difference.expected,
        RecordValue::Builtin("toString")
    ));
    assert!(matches!(
        difference.actual,
        RecordValue::Entry(PlainData::Undefined)
    ));
    assert!(deep_equal(&data("{}"), &data(r#"{"__proto__":{}}"#)));
    let expected = PlainData::Object(
        [
            (JsText::from_units(vec![0xe000]), PlainData::Number(1.0)),
            (
                JsText::from_units(vec![0xd800, 0xdc00]),
                PlainData::Number(2.0),
            ),
        ]
        .into_iter()
        .collect(),
    );
    let difference = first_divergence(&expected, &data("{}"), "state").unwrap();
    assert_eq!(
        difference.path.as_units(),
        [
            "state.".encode_utf16().collect::<Vec<_>>(),
            vec![0xd800, 0xdc00]
        ]
        .concat()
    );
}
struct State<'a> {
    count: u32,
    label: &'a str,
    local: Rc<Cell<u32>>,
}
impl Tagged for State<'_> {
    fn tag(&self) -> &str {
        "state"
    }
}
struct Msg {
    by: u32,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        "add"
    }
}
struct Cmd;
#[derive(Debug)]
struct Difference {
    expected: u32,
    actual: u32,
}
#[allow(
    clippy::arc_with_non_send_sync,
    reason = "Opaque local trace values intentionally remain non-Send behind original Arc handles."
)]
#[test]
fn opaque_recorded_replay_uses_only_updates_and_keeps_expected_actual_and_empty_seed_identity() {
    let label = String::from("borrowed");
    let updates = Cell::new(0);
    let local = Rc::new(Cell::new(7));
    let mut row: demlik_tea::core::Row<'_, State<'_>, Msg, Cmd> = Default::default();
    row.insert(
        "add".into(),
        Box::new(|state, msg| {
            updates.set(updates.get() + 1);
            Step::new(
                State {
                    count: state.count + msg.by,
                    label: state.label,
                    local: state.local.clone(),
                },
                vec![Cmd],
            )
        }),
    );
    let machine: Machine<'_, State<'_>, Msg, Cmd, Sub> = Machine {
        init: Box::new(|_, _| panic!("init must not run")),
        update: Update::RawReducer(row),
        subscriptions: demlik_tea::core::subscriptions(|_| panic!("subs must not run")),
    };
    let seed = Arc::new(State {
        count: 10,
        label: &label,
        local: local.clone(),
    });
    let expected = Arc::new(State {
        count: 16,
        label: &label,
        local: local.clone(),
    });
    let trace = Trace {
        loaded: Some(seed.clone()),
        msgs: [1, 2, 3].map(|by| Arc::new(Msg { by })).into(),
        final_state: expected.clone(),
        steps: None,
    };
    let result = replay_trace_with(&machine, &trace, |expected, actual| {
        Ok::<_, &str>((expected.count != actual.count).then_some(Difference {
            expected: expected.count,
            actual: actual.count,
        }))
    })
    .unwrap();
    assert!(result.matches);
    assert_eq!(result.actual.count, 16);
    assert!(Arc::ptr_eq(&result.expected, &expected));
    assert_eq!(updates.get(), 3);
    assert!(Rc::ptr_eq(&result.actual.local, &local));
    let empty = Trace {
        loaded: Some(seed.clone()),
        msgs: vec![],
        final_state: seed.clone(),
        steps: Some(vec![]),
    };
    let result =
        replay_trace_with(&machine, &empty, |_, _| Ok::<_, &str>(None::<Difference>)).unwrap();
    assert!(Arc::ptr_eq(&result.actual, &seed));
    assert_eq!(updates.get(), 3);
    let mut changed = trace.clone();
    changed.final_state = Arc::new(State {
        count: 20,
        label: &label,
        local,
    });
    let result = replay_trace_with(&machine, &changed, |expected, actual| {
        Ok::<_, &str>(Some(Difference {
            expected: expected.count,
            actual: actual.count,
        }))
    })
    .unwrap();
    let difference = result.divergence.unwrap();
    assert_eq!((difference.expected, difference.actual), (20, 16));
    let missing = Trace {
        loaded: None,
        msgs: vec![],
        final_state: expected,
        steps: None,
    };
    assert!(matches!(
        replay_trace_with(&machine, &missing, |_, _| Ok::<_, &str>(None::<Difference>)),
        Err(ReplayError::MissingAnchor)
    ));
}
