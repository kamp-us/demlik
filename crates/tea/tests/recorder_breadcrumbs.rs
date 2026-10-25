use demlik_tea::{
    Tagged,
    persistence::recorder::{Trace, breadcrumbs_from_trace, breadcrumbs_from_trace_with},
};
use std::{cell::Cell, rc::Rc, sync::Arc};
struct Msg<'a> {
    kind: &'a str,
    shared: Rc<Cell<u32>>,
}
impl Tagged for Msg<'_> {
    fn tag(&self) -> &str {
        self.kind
    }
}
#[allow(
    clippy::arc_with_non_send_sync,
    reason = "Pure opaque messages intentionally retain local non-Send Arc identities."
)]
#[test]
fn breadcrumb_limits_keep_newest_order_and_full_original_opaque_messages() {
    let word = String::from("borrowed");
    let shared = Rc::new(Cell::new(7));
    let trace = Trace {
        loaded: Some(Arc::new(())),
        msgs: (0..5)
            .map(|_| {
                Arc::new(Msg {
                    kind: &word,
                    shared: shared.clone(),
                })
            })
            .collect(),
        final_state: Arc::new(()),
        steps: None,
    };
    for (limit, count) in [
        (None, 5),
        (Some(f64::NAN), 5),
        (Some(-1.0), 0),
        (Some(-0.0), 0),
        (Some(0.0), 0),
        (Some(0.9), 0),
        (Some(1.9), 1),
        (Some(2.9), 2),
        (Some(f64::INFINITY), 5),
        (Some(f64::NEG_INFINITY), 0),
    ] {
        let crumbs = breadcrumbs_from_trace(&trace, limit);
        assert_eq!(crumbs.len(), count);
        for (crumb, msg) in crumbs.iter().zip(trace.msgs.iter().skip(5 - count)) {
            assert_eq!(
                (crumb.category, crumb.kind, crumb.level),
                ("tea", "default", "info")
            );
            assert_eq!(crumb.message.as_utf8(), Some("borrowed"));
            assert!(Arc::ptr_eq(&crumb.data.msg, msg));
        }
    }
    let calls = Cell::new(0);
    struct Rendered<'a>(&'a str);
    let crumbs = breadcrumbs_from_trace_with(&trace, Some(2.0), |msg| {
        calls.set(calls.get() + 1);
        Ok::<_, ()>(Rendered(msg.kind))
    })
    .unwrap();
    assert_eq!(calls.get(), 2);
    assert_eq!(crumbs[0].message.0, "borrowed");
    shared.set(9);
    assert_eq!(crumbs[1].data.msg.shared.get(), 9);
}
#[test]
fn formatter_failure_keeps_its_original_typed_data_and_stops_at_the_failed_message() {
    struct Fault(Rc<Cell<u32>>);
    let token = Rc::new(Cell::new(7));
    let trace = Trace {
        loaded: Some(Arc::new(())),
        msgs: [1, 2, 3].map(Arc::new).into(),
        final_state: Arc::new(()),
        steps: None,
    };
    let calls = Cell::new(0);
    let result = breadcrumbs_from_trace_with(&trace, None, |value| {
        calls.set(calls.get() + 1);
        if *value == 2 {
            Err(Fault(token.clone()))
        } else {
            Ok(*value)
        }
    });
    let Err(error) = result else {
        panic!("formatter must fail")
    };
    assert!(Rc::ptr_eq(&error.0, &token));
    assert_eq!(calls.get(), 2);
}
