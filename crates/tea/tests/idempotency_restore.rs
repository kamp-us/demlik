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

#[test]
fn present_null_bounds_are_zero_while_missing_bounds_remain_unbounded() {
    let reload = |state: &IdempotencyStore<bool>| {
        serde_json::from_str::<IdempotencyStore<bool>>(
            &stringify_json(&plain_data(state).unwrap()).unwrap(),
        )
        .unwrap()
    };
    let ttl = idempotency::remember(
        &idempotency::init_store(StoreOptions {
            capacity: None,
            ttl_ms: Some(f64::NAN),
        }),
        "k",
        true,
        0.0,
    )
    .unwrap();
    let ttl = reload(&ttl);
    assert!(!idempotency::seen(&ttl, "k", 0.0).unwrap());
    assert!(
        stringify_json(&plain_data(&ttl).unwrap())
            .unwrap()
            .contains("\"ttlMs\":null")
    );
    let capacity = idempotency::remember(
        &idempotency::init_store(StoreOptions {
            capacity: Some(f64::INFINITY),
            ttl_ms: None,
        }),
        "k",
        true,
        0.0,
    )
    .unwrap();
    let capacity = reload(&capacity);
    let emptied = idempotency::remember(&capacity, "j", true, 1.0).unwrap();
    assert!(emptied.order.is_empty());
    assert!(
        stringify_json(&plain_data(&emptied).unwrap())
            .unwrap()
            .contains("\"capacity\":null")
    );
    let unbounded = reload(&idempotency::init_store(Default::default()));
    let unbounded = idempotency::remember(&unbounded, "k", true, 0.0).unwrap();
    assert!(idempotency::seen(&unbounded, "k", 1e12).unwrap());
    assert_eq!(unbounded.order.len(), 1);
}
