use demlik_tea::idempotency::{self, IdempotencyStore, StoreOptions};
use demlik_tea::js_record::JsRead;
use demlik_tea::resilience::cache::{self, TtlCache};
use serde_json::{Value, json};

// The differential drivers encode snapshots themselves. These tests exercise the
// public serde contract that a real Store consumer uses instead.
#[test]
fn ttl_cache_restores_null_and_tagged_failure_values_at_the_same_expiry() {
    let cache = cache::set(&cache::init_cache(), "null", Value::Null, 5.0, 10.0);
    let cache = cache::set(&cache, "failure", json!({"_tag":"timeout"}), 5.0, 20.0);
    let saved = serde_json::to_value(&cache).unwrap();
    assert_eq!(
        saved,
        json!({"entries":{
            "null":{"value":null,"expiresAtMs":15.0},
            "failure":{"value":{"_tag":"timeout"},"expiresAtMs":25.0}
        }})
    );
    let restored: TtlCache<Value> = serde_json::from_value(saved).unwrap();
    assert!(matches!(
        cache::get(&restored, "null", 14.0).unwrap(),
        Some(JsRead::Stored(Value::Null))
    ));
    assert!(!cache::has(&restored, "null", 15.0).unwrap());
    assert_eq!(
        serde_json::to_value(cache::get(&restored, "failure", 24.0).unwrap()).unwrap(),
        json!({"_tag":"timeout"})
    );
}

#[test]
fn idempotency_restores_the_touch_order_and_policy_before_the_next_admission() {
    let store = idempotency::init_store(StoreOptions {
        capacity: Some(2.0),
        ttl_ms: Some(10.0),
    });
    let store = idempotency::remember(&store, "a", Value::Null, 0.0).unwrap();
    let store = idempotency::remember(&store, "b", json!({"_tag":"offline"}), 1.0).unwrap();
    let store = idempotency::remember(&store, "a", Value::Null, 2.0).unwrap();
    let saved = serde_json::to_value(&store).unwrap();
    assert_eq!(
        saved,
        json!({"entries":{
        "a":{"value":null,"atMs":2.0},
        "b":{"value":{"_tag":"offline"},"atMs":1.0}
    },"order":["b","a"],"capacity":2.0,"ttlMs":10.0})
    );
    let restored: IdempotencyStore<Value> = serde_json::from_value(saved).unwrap();
    let next = idempotency::remember(&restored, "c", json!(42), 3.0).unwrap();
    assert!(!idempotency::seen(&next, "b", 3.0).unwrap());
    assert!(matches!(
        idempotency::recall(&next, "a", 11.0).unwrap(),
        Some(JsRead::Stored(Value::Null))
    ));
    assert!(!idempotency::seen(&next, "a", 12.0).unwrap());
}

#[test]
fn json_restoration_keeps_own_proto_keys_and_drops_injected_prototypes() {
    let injected = cache::set(&cache::init_cache(), "__proto__", json!(7), 0.0, 10.0);
    assert!(
        matches!(cache::get(&injected, "__proto__", 1.0).unwrap(), Some(JsRead::Stored(value)) if value == &json!(7))
    );
    let serialized = serde_json::to_string(&injected).unwrap();
    assert_eq!(serialized, "{\"entries\":{}}");
    let restored: TtlCache<Value> = serde_json::from_str(&serialized).unwrap();
    assert!(cache::has(&restored, "__proto__", 1.0).unwrap());
    assert!(cache::get(&restored, "__proto__", 1.0).unwrap().is_none());

    let seeded: TtlCache<Value> =
        serde_json::from_str("{\"entries\":{\"__proto__\":{\"value\":null,\"expiresAtMs\":10}}}")
            .unwrap();
    let overwritten = cache::set(&seeded, "__proto__", json!(42), 1.0, 10.0);
    assert_eq!(
        serde_json::to_value(&overwritten).unwrap(),
        json!({"entries":{
            "__proto__":{"value":42,"expiresAtMs":11.0}
        }})
    );
}
