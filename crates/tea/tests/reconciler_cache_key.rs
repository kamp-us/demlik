use demlik_tea::{
    data::{JsText, plain_data, stringify_json},
    js_record::JsRead,
    resilience::cache,
};

#[test]
fn absent_json_identity_is_coerced_by_the_cache_owner() {
    let empty = cache::init_cache();
    let stored = cache::set(&empty, None::<JsText>, true, 1.0, 10.0);
    assert!(matches!(
        cache::get(&stored, None::<JsText>, 2.0).unwrap(),
        Some(JsRead::Stored(true))
    ));
    assert!(matches!(
        cache::get(&stored, "undefined", 2.0).unwrap(),
        Some(JsRead::Stored(true))
    ));
    assert_eq!(
        stringify_json(&plain_data(&stored).unwrap()).unwrap(),
        r#"{"entries":{"undefined":{"value":true,"expiresAtMs":11}}}"#
    );
    assert!(cache::get(&stored, None::<JsText>, 11.0).unwrap().is_none());
}

#[test]
fn existing_generic_text_callers_keep_their_bound() {
    fn retained(cache: &cache::TtlCache<bool>, key: impl Into<JsText>) -> bool {
        cache::has(cache, key, 0.0).unwrap()
    }
    let stored = cache::set(&cache::init_cache(), "key", false, 0.0, 10.0);
    assert!(retained(&stored, "key"));
    assert!(cache::has(&stored, Some(JsText::from("key")), 0.0).unwrap());
    let removed = cache::remove(&stored, Some(JsText::from("key")));
    assert!(!retained(&removed, "key"));
}
