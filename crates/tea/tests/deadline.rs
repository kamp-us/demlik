use demlik_tea::{Subscription, resilience::deadline::*};

#[test]
fn deadline_projection_keeps_absolute_targets_names_and_dependency_identity() {
    let select = deadlines_sub(|state: &Option<f64>| {
        state
            .iter()
            .map(|at| deadline_sub("guard", *at).named("search"))
            .collect()
    });
    assert!(select(&None).unwrap().is_none());
    let first = select(&Some(150.0)).unwrap().unwrap();
    let same = select(&Some(150.0)).unwrap().unwrap();
    let changed = select(&Some(151.0)).unwrap().unwrap();
    assert_eq!(first.id(), same.id());
    assert_ne!(first.id(), changed.id());
    assert_eq!(
        serde_json::to_value(first.deps()).unwrap(),
        serde_json::json!([{"type":"deadline","id":"guard","atMs":150.0,"name":"search"}])
    );
    let next = next_timer(first.deps(), 140.0).unwrap();
    assert_eq!(next.ms, 10.0);
    assert_eq!(next.msg.kind, "search_deadline");
    assert_eq!(next.msg.id.as_utf8(), Some("guard"));
    assert_eq!(next.msg.at_ms, 150.0);
    assert_eq!(next_timer(first.deps(), 999.0).unwrap().ms, 0.0);
}

#[test]
fn deadline_selection_preserves_first_ties_and_nan_comparisons() {
    let list = [
        deadline_sub("first", f64::NAN),
        deadline_sub("later", -100.0),
    ];
    let next = next_timer(&list, 0.0).unwrap();
    assert!(next.ms.is_nan());
    assert_eq!(next.msg.id.as_utf8(), Some("first"));
    let list = [deadline_sub("a", 10.0), deadline_sub("b", 10.0)];
    assert_eq!(next_timer(&list, 0.0).unwrap().msg.id.as_utf8(), Some("a"));
    assert!(next_timer(&[], 0.0).is_none());
    assert!(deadlines(&[]).is_none());
    assert!(std::ptr::eq(deadlines(&list).unwrap(), list.as_slice()));
    assert_eq!(deadline_msg_type(Some("")), "_deadline");
}

#[test]
fn injected_deadline_arms_keep_absolute_targets_and_cleanup_calls_the_host_in_order() {
    use std::{cell::RefCell, rc::Rc};
    let armed = Rc::new(RefCell::new(Vec::new()));
    let cancelled = Rc::new(RefCell::new(Vec::new()));
    let output = Rc::new(RefCell::new(Vec::new()));
    let sub = demlik_tea::Sub::new(
        "deadline",
        vec![
            deadline_sub("a", 10.0),
            deadline_sub("b", 20.0).named("search"),
        ],
    )
    .unwrap();
    let cleanup = subscribe_with(
        {
            let armed = armed.clone();
            let cancelled = cancelled.clone();
            move |id: &demlik_tea::data::JsText,
                  at,
                  msg: DeadlineExceeded,
                  dispatch: Dispatch<DeadlineExceeded>|
                  -> Result<_, &'static str> {
                armed
                    .borrow_mut()
                    .push((id.as_utf8().unwrap().to_owned(), at));
                dispatch(msg);
                let id = id.as_utf8().unwrap().to_owned();
                let cancelled = cancelled.clone();
                Ok(move || {
                    cancelled.borrow_mut().push(id.clone());
                    Ok::<_, &'static str>(())
                })
            }
        },
        &sub,
        {
            let output = output.clone();
            Rc::new(move |msg: DeadlineExceeded| output.borrow_mut().push(msg.kind))
        },
    )
    .unwrap();
    assert_eq!(
        *armed.borrow(),
        [("a".into(), 10.0.into()), ("b".into(), 20.0.into())]
    );
    assert_eq!(*output.borrow(), ["deadline_exceeded", "search_deadline"]);
    cleanup.cancel().unwrap();
    cleanup.cancel().unwrap();
    assert_eq!(*cancelled.borrow(), ["a", "b", "a", "b"]);
}
