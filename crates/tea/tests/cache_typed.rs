use demlik_tea::{
    js_record::{JsAccessError, JsRead},
    resilience::cache,
};
use std::{cell::Cell, rc::Rc};

#[derive(Debug)]
struct ResultValue<'a> {
    text: &'a str,
    visits: &'a Cell<u32>,
}
#[test]
fn cache_stored_values_need_neither_clone_nor_serde_and_projection_is_lazy() {
    let text = String::from("borrowed result");
    let visits = Cell::new(1);
    let value = Rc::new(ResultValue {
        text: &text,
        visits: &visits,
    });
    let initial = cache::init_cache();
    let filled = cache::set(&initial, "key", value.clone(), 10.0, 20.0);
    let projections = Cell::new(0);
    let project = |_: &Rc<ResultValue<'_>>| {
        projections.set(projections.get() + 1);
        Err(JsAccessError {
            name: "ProjectionRefused",
            message: "the caller supplied no raw-value codec".into(),
        })
    };
    let Some(JsRead::Stored(hit)) =
        cache::get_with_projection(&filled, "key", 29.0, project).unwrap()
    else {
        panic!("typed stored hit")
    };
    assert!(Rc::ptr_eq(hit, &value));
    visits.set(7);
    assert_eq!(hit.visits.get(), 7);
    assert_eq!(hit.text, "borrowed result");
    assert!(
        cache::get_with_projection(&filled, "key", 30.0, project)
            .unwrap()
            .is_none()
    );
    let prototype = cache::set(&filled, "__proto__", value.clone(), 10.0, 20.0);
    let Some(JsRead::Stored(hit)) =
        cache::get_with_projection(&prototype, "__proto__", 29.0, project).unwrap()
    else {
        panic!("typed inherited entry")
    };
    assert!(Rc::ptr_eq(hit, &value));
    assert_eq!(projections.get(), 0);
    let error = cache::get_with_projection(&prototype, "value", 29.0, project).unwrap_err();
    assert_eq!(error.name, "ProjectionRefused");
    assert!(error.message.contains("codec"));
    assert_eq!(projections.get(), 1);
}

#[test]
fn cache_record_json_preserves_lone_unit_keys_and_overflow_values() {
    use demlik_tea::{
        PlainData,
        data::JsText,
        js_record::{JsRecord, RecordValue},
        resilience::cache::CacheEntry,
    };
    let restored: JsRecord<CacheEntry<PlainData>> =
        serde_json::from_str(r#"{"\ud800":{"value":1e400,"expiresAtMs":100}}"#).unwrap();
    let (key, RecordValue::Entry(entry)) = restored.own_entries().next().unwrap() else {
        panic!("typed cache entry")
    };
    assert_eq!(key, &JsText::from_units(vec![0xd800]));
    assert!(matches!(entry.value,PlainData::Number(value) if value==f64::INFINITY));
}

#[test]
fn an_inherited_undefined_value_is_a_missing_cache_entry() {
    let cache = cache::set(
        &cache::init_cache(),
        "__proto__",
        demlik_tea::PlainData::Undefined,
        0.0,
        100.0,
    );
    assert!(cache::get(&cache, "value", 1.0).unwrap().is_none());
    assert!(!cache::has(&cache, "value", 1.0).unwrap());
}
