use demlik_tea::data::{JsText, PlainData, decode_json, stringify_json, structural_hash};

#[test]
fn json_values_and_keys_preserve_lone_surrogates_and_number_semantics() {
    let value = decode_json(
        r#"{"\ud800":"\udc00","emoji":"\ud83d\ude00","overflow":1e400,"unsafe":9007199254740993}"#,
    )
    .unwrap();
    let PlainData::Object(values) = &value else {
        panic!("expected object")
    };
    let key = JsText::from_units(vec![0xd800]);
    let PlainData::String(text) = &values[&key] else {
        panic!("expected text")
    };
    assert_eq!(text.as_units(), &[0xdc00]);
    assert!(text.as_utf8().is_none());
    let PlainData::String(emoji) = &values["emoji"] else {
        panic!("expected emoji")
    };
    assert_eq!(emoji.as_utf8(), Some("😀"));
    assert!(matches!(values["overflow"], PlainData::Number(value) if value == f64::INFINITY));
    assert!(matches!(
        values["unsafe"],
        PlainData::Number(9007199254740992.0)
    ));
    assert_eq!(
        stringify_json(&value).unwrap(),
        r#"{"\ud800":"\udc00","emoji":"😀","overflow":null,"unsafe":9007199254740992}"#
    );
    assert_eq!(
        structural_hash(&value),
        r#"{"emoji":"😀","overflow":Infinity,"unsafe":9007199254740992,"\ud800":"\udc00"}"#
    );
}

#[test]
fn json_stringify_and_structural_hash_have_distinct_undefined_rules() {
    let value = PlainData::Object(
        [
            ("missing".into(), PlainData::Undefined),
            (
                "items".into(),
                PlainData::Array(vec![PlainData::Undefined, PlainData::Number(f64::NAN)]),
            ),
        ]
        .into(),
    );
    assert_eq!(stringify_json(&value).unwrap(), r#"{"items":[null,null]}"#);
    assert_eq!(structural_hash(&value), r#"{"items":[undefined,NaN]}"#);
    assert!(stringify_json(&PlainData::Undefined).is_none());
}

#[test]
fn public_subscription_constructor_preserves_data_before_json_transport() {
    use demlik_tea::{Sub, Subscription, data::plain_data};
    let value = decode_json(r#"{"\ud800":1e400,"list":[-0,"\udc00"]}"#).unwrap();
    let sub = Sub::new("pulse", value).unwrap();
    assert_eq!(
        sub.id().as_str(),
        r#"{"deps":{"list":[0,"\udc00"],"\ud800":Infinity},"type":"pulse"}"#
    );
    assert_eq!(
        stringify_json(&plain_data(sub.deps()).unwrap()).unwrap(),
        r#"{"\ud800":null,"list":[0,"\udc00"]}"#
    );
    let ordinary = serde_json::json!({ "$serde_json::private::RawValue": "1e400", "$demlik::PlainData": "undefined" });
    assert_eq!(
        structural_hash(&plain_data(&ordinary).unwrap()),
        r#"{"$demlik::PlainData":"undefined","$serde_json::private::RawValue":"1e400"}"#
    );
}

#[test]
fn json_roundtrip_preserves_utf16_keys_and_numeric_property_order() {
    let input = r#"{"10":"ten","2":"two","01":"one","\ud800":"\udc00"}"#;
    let value: PlainData = serde_json::from_str(input).unwrap();
    let encoded = serde_json::to_string(&value).unwrap();
    assert_eq!(
        encoded,
        r#"{"2":"two","10":"ten","01":"one","\ud800":"\udc00"}"#
    );
    let restored: PlainData = serde_json::from_str(&encoded).unwrap();
    assert_eq!(structural_hash(&value), structural_hash(&restored));
}

#[test]
fn typed_policy_state_preserves_lone_keys_through_serde_and_public_reads() {
    use demlik_tea::{idempotency, resilience::cache};
    let key = JsText::from_units(vec![0xd800]);
    let cache: cache::TtlCache<PlainData> =
        serde_json::from_str(r#"{"entries":{"\ud800":{"value":"\udc00","expiresAtMs":10}}}"#)
            .unwrap();
    assert!(cache::has(&cache, &key, 9.0).unwrap());
    assert_eq!(
        serde_json::to_string(&cache).unwrap(),
        r#"{"entries":{"\ud800":{"value":"\udc00","expiresAtMs":10}}}"#
    );
    assert!(!cache::has(&cache, &key, 10.0).unwrap());
    let store = idempotency::remember(
        &idempotency::init_store(idempotency::StoreOptions::default()),
        &key,
        PlainData::String(JsText::from_units(vec![0xdc00])),
        1.0,
    )
    .unwrap();
    let wire = serde_json::to_string(&store).unwrap();
    assert_eq!(
        wire,
        r#"{"entries":{"\ud800":{"value":"\udc00","atMs":1}},"order":["\ud800"]}"#
    );
    let restored: idempotency::IdempotencyStore<PlainData> = serde_json::from_str(&wire).unwrap();
    assert!(idempotency::seen(&restored, &key, 2.0).unwrap());
}
