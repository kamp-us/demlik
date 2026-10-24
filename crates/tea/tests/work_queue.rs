use std::{cell::Cell, rc::Rc};

use demlik_tea::{storage::memory_store, work_queue::*};

#[test]
fn pure_queue_shares_payloads_and_untouched_items_without_clone_bounds() {
    struct Job<'a> {
        name: &'a str,
        calls: Cell<usize>,
    }
    let name = String::from("job");
    let payload = Rc::new(Job {
        name: &name,
        calls: Cell::new(0),
    });
    let empty = Queue::new();
    let first = enqueue_op(&empty, payload.clone(), 1.0, "same");
    let second = enqueue_op(&first.next, payload.clone(), 2.0, "same");
    assert!(empty.is_empty());
    assert!(Rc::ptr_eq(&first.item, &second.next.get(0).unwrap()));
    payload.calls.set(7);
    assert_eq!(second.next.get(0).unwrap().input.calls.get(), 7);
    assert_eq!(second.next.get(1).unwrap().input.name, "job");
    let claimed = claim_next_op(&second.next, 3.5).unwrap();
    assert_eq!(claimed.claimed.status, QueueItemStatus::Running);
    assert_eq!(
        claimed.claimed.started_at.value().unwrap().number(),
        Some(3.5)
    );
    assert!(Rc::ptr_eq(
        &claimed.next.get(1).unwrap(),
        &second.next.get(1).unwrap()
    ));
    assert_eq!(second.next.get(0).unwrap().status, QueueItemStatus::Pending);
    let patched = patch_item_op(&claimed.next, "same", |item| item.clone());
    assert!(patched.changed); // A matched identity patch still causes a save.
    assert!(!patched.next.ptr_eq(&claimed.next));
    assert!(Rc::ptr_eq(
        &patched.next.get(0).unwrap(),
        &claimed.next.get(0).unwrap()
    ));
    let missing = patch_item_op(&patched.next, "missing", |_| panic!("must not patch"));
    assert!(!missing.changed);
    assert!(!missing.next.ptr_eq(&patched.next));
    assert_eq!(mark_done_op(&patched.next, "same").next.len(), 0); // Removes all duplicate ids.
    let reset = reset_running_op(&claimed.next);
    assert!(reset.changed);
    assert!(reset.next.get(0).unwrap().started_at.is_undefined());
    assert!(reset.next.get(1).unwrap().started_at.is_absent());
}

#[tokio::test(flavor = "current_thread")]
async fn store_adapter_uses_restore_and_skips_only_unmatched_saves() {
    let times = Cell::new(0);
    let ids = Cell::new(0);
    let queue = QueueClient::with_sources(
        memory_store(None),
        || {
            let t = times.get();
            times.set(t + 1);
            f64::from(t) + 0.25
        },
        || {
            let id = ids.get();
            ids.set(id + 1);
            format!("id-{id}").into()
        },
    );
    let item = queue.enqueue(Rc::new("a")).await.unwrap();
    assert_eq!(item.enqueued_at.number(), Some(0.25));
    assert!(Rc::ptr_eq(
        &queue.list().await.unwrap().get(0).unwrap(),
        &item
    ));
    queue.mark_failed("missing", "ignored").await.unwrap();
    assert_eq!(times.get(), 1); // Source clock lives inside the matched patch.
    assert_eq!(
        queue
            .claim_next()
            .await
            .unwrap()
            .unwrap()
            .started_at
            .value()
            .unwrap()
            .number(),
        Some(1.25)
    );
    queue.mark_failed("id-0", "boom").await.unwrap();
    queue.bind_output("id-0", "trace").await.unwrap();
    let failed = queue.list().await.unwrap();
    assert_eq!(failed.get(0).unwrap().status, QueueItemStatus::Failed);
    assert_eq!(
        failed.get(0).unwrap().error.value().unwrap().as_utf8(),
        Some("boom")
    );
    queue.retry_item("id-0").await.unwrap();
    let retried = queue.list().await.unwrap();
    assert!(retried.get(0).unwrap().started_at.is_undefined());
    assert!(retried.get(0).unwrap().finished_at.is_undefined());
    assert!(retried.get(0).unwrap().error.is_undefined());
    assert!(retried.get(0).unwrap().output.is_undefined());
    queue.mark_done("id-0").await.unwrap();
    assert!(queue.list().await.unwrap().is_empty());
}

#[test]
fn canonical_adapter_is_substitutable_and_preserves_patch_identity() {
    fn consumer<A: QueueAdapter<&'static str>>(adapter: &A) {
        let created = adapter.enqueue(&Queue::new(), Rc::new("a"), 0.0, "x".into());
        let claimed = adapter.claim(&created.next, 1.0).unwrap();
        let patched = adapter.patch(&claimed.next, "x", |item| item.clone());
        assert!(patched.changed);
        assert!(adapter.mark_done(&patched.next, "x").next.is_empty());
    }
    consumer(&queue_adapter());
}

#[test]
fn json_reload_retains_null_timestamps_and_lone_utf16_ids() {
    let id = demlik_tea::data::JsText::from_units(vec![0xd800]);
    let next = enqueue_op(&Queue::new(), Rc::new("a"), f64::INFINITY, id).next;
    let encoded = serde_json::to_string(&next).unwrap();
    assert_eq!(
        encoded,
        r#"[{"id":"\ud800","status":"pending","input":"a","enqueuedAt":null}]"#
    );
    let restored: Queue<String> = serde_json::from_str(&encoded).unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), encoded);
    let claimed = claim_next_op(&restored, 7.0).unwrap();
    assert_eq!(
        serde_json::to_string(&claimed.next).unwrap(),
        r#"[{"id":"\ud800","status":"running","input":"a","enqueuedAt":null,"startedAt":7}]"#
    );
}

#[test]
fn item_owns_property_order_and_preserves_extra_restored_data() {
    let item = QueueItem::new(Rc::new("job"), 0.0, "x");
    let patched = item
        .with_output(QueueField::Value("trace".into()))
        .with_status(QueueItemStatus::Failed)
        .with_finished_at(QueueField::Value(2.5.into()))
        .with_error(QueueField::Value("boom".into()));
    assert_eq!(
        serde_json::to_string(&patched).unwrap(),
        r#"{"id":"x","status":"failed","input":"job","enqueuedAt":0,"output":"trace","finishedAt":2.5,"error":"boom"}"#
    );
    let raw = r#"{"custom":{"\ud800":"\udc00"},"status":"running","enqueuedAt":null,"input":"job","id":"x","error":"old"}"#;
    let restored: QueueItem<String> = serde_json::from_str(raw).unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), raw);
    let retried = restored.retried();
    assert_eq!(
        serde_json::to_string(&retried).unwrap(),
        r#"{"custom":{"\ud800":"\udc00"},"status":"pending","enqueuedAt":null,"input":"job","id":"x"}"#
    );
    assert_eq!(restored.error.value().unwrap().as_utf8(), Some("old"));
}

#[tokio::test(flavor = "current_thread")]
async fn native_default_sources_use_uuid_v4_and_integer_epoch_milliseconds() {
    let queue = create_queue(memory_store(None));
    let first = queue.enqueue(Rc::new("first")).await.unwrap();
    let second = queue.enqueue(Rc::new("second")).await.unwrap();
    assert_ne!(first.id, second.id);
    let id = first.id.as_utf8().unwrap();
    assert_eq!(id.len(), 36);
    assert_eq!(&id[14..15], "4");
    assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    assert_eq!(first.enqueued_at.number().unwrap().fract(), 0.0);
    assert!(first.enqueued_at.number().unwrap() > 1_000_000_000_000.0);
}

#[tokio::test(flavor = "current_thread")]
async fn a_loaded_memory_array_is_shared_while_each_pure_op_creates_a_new_array() {
    let queue = QueueClient::with_sources(memory_store(None), || 0.0, || "first".into());
    queue.enqueue(Rc::new("first")).await.unwrap();
    let loaded = queue.list().await.unwrap();
    loaded
        .items_mut()
        .push(Rc::new(QueueItem::new(Rc::new("external"), 17.0, "second")));
    let again = queue.list().await.unwrap();
    assert!(loaded.ptr_eq(&again));
    assert_eq!(again.len(), 2);
    let appended = enqueue_op(&loaded, Rc::new("pure"), 18.0, "third");
    assert!(!appended.next.ptr_eq(&loaded));
    assert_eq!(loaded.len(), 2);
    assert_eq!(appended.next.len(), 3);
}

#[test]
fn json_number_overflow_preserves_timestamp_values_before_any_stringify() {
    let raw =
        r#"[{"id":"x","status":"running","input":"a","enqueuedAt":1e400,"startedAt":-1e400}]"#;
    let state: Queue<String> = serde_json::from_str(raw).unwrap();
    assert_eq!(
        state.get(0).unwrap().enqueued_at.number(),
        Some(f64::INFINITY)
    );
    assert_eq!(
        state.get(0).unwrap().started_at.value().unwrap().number(),
        Some(f64::NEG_INFINITY)
    );
    let normal: QueueTime = serde_json::from_value(serde_json::json!(0.25)).unwrap();
    assert_eq!(normal.number(), Some(0.25));
    let null: QueueTime = serde_json::from_value(serde_json::Value::Null).unwrap();
    assert_eq!(null.number(), None);
}
