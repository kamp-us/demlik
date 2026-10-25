use demlik_tea::{
    data::{plain_data, stringify_json},
    idempotency::{self, IdempotencyStore, StoreOptions},
};
#[test]
fn a_json_null_timestamp_remains_null_and_uses_zero_for_the_half_open_ttl() {
    let state = idempotency::remember(
        &idempotency::init_store(StoreOptions {
            capacity: None,
            ttl_ms: Some(10.0),
        }),
        "k",
        true,
        f64::NAN,
    )
    .unwrap();
    let encoded = stringify_json(&plain_data(&state).unwrap()).unwrap();
    assert_eq!(
        encoded,
        r#"{"entries":{"k":{"value":true,"atMs":null}},"order":["k"],"ttlMs":10}"#
    );
    let restored: IdempotencyStore<bool> = serde_json::from_str(&encoded).unwrap();
    assert!(idempotency::seen(&restored, "k", 0.0).unwrap());
    assert!(!idempotency::seen(&restored, "k", 10.0).unwrap());
    assert_eq!(
        stringify_json(&plain_data(&restored).unwrap()).unwrap(),
        encoded
    );
    let touched = idempotency::remember(&restored, "k", false, 9.0).unwrap();
    assert!(idempotency::seen(&touched, "k", 18.0).unwrap());
    assert!(!idempotency::seen(&touched, "k", 19.0).unwrap());
    assert_eq!(
        stringify_json(&plain_data(&restored).unwrap()).unwrap(),
        encoded
    );
}
