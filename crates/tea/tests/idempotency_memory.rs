use demlik_tea::{
    data::NumberOrNull,
    idempotency::{StoreOptions, idempotency_memory},
    work_queue::{Queue, QueueAdapter, queue_adapter},
};
use std::rc::Rc;

struct Opaque(Box<dyn Fn() -> u32>);

#[test]
fn memory_verbs_preserve_an_opaque_result_without_serialization() {
    let memory = idempotency_memory();
    let value = Rc::new(Opaque(Box::new(|| 7)));
    let initial = memory.init(StoreOptions::default());
    let next = memory
        .remember(&initial, "key", value.clone(), 0.0)
        .unwrap();
    assert!(memory.is_seen(&next, "key", f64::INFINITY).unwrap());
    let recalled = memory.recall(&next, "key", 1.0).unwrap().unwrap();
    assert!(Rc::ptr_eq(&recalled, &value));
    assert_eq!((recalled.0)(), 7);
    assert_eq!(initial.order.len(), 0);
    assert_eq!(memory.evict(&next, 99.0).unwrap().order.len(), 1);
}

#[test]
fn restored_null_clock_is_stored_before_any_ttl_coercion() {
    let memory = idempotency_memory();
    let store = memory.init(StoreOptions {
        capacity: None,
        ttl_ms: Some(10.0),
    });
    let next = memory
        .remember(&store, "key", true, NumberOrNull(None))
        .unwrap();
    assert_eq!(
        serde_json::to_value(&next).unwrap()["entries"]["key"]["atMs"],
        serde_json::Value::Null
    );
    assert!(memory.is_seen(&next, "key", 9.0).unwrap());
    assert!(!memory.is_seen(&next, "key", 10.0).unwrap());
    let queued = queue_adapter().enqueue(
        &Queue::default(),
        Rc::new(true),
        NumberOrNull(None),
        "q".into(),
    );
    assert_eq!(queued.item.enqueued_at, NumberOrNull(None));
}
