use demlik_tea::{ReadStep, Step, lift_slice, read_in_order};
use std::{
    convert::Infallible,
    panic::{AssertUnwindSafe, catch_unwind, panic_any},
    sync::Arc,
};
struct Opaque<'a> {
    label: &'a str,
    _capability: Box<dyn Fn() + 'a>,
}
struct Host<'a> {
    slice: u32,
    context: Box<Opaque<'a>>,
}
#[test]
fn replacement_consumes_an_owned_host_and_a_non_clone_borrowed_capture() {
    let label = String::from("borrowed replacement");
    let captured = Box::new(Opaque {
        label: &label,
        _capability: Box::new(|| {}),
    });
    let original = captured.as_ref() as *const Opaque<'_>;
    let command = Box::new(Opaque {
        label: "command",
        _capability: Box::new(|| {}),
    });
    let commands = vec![command];
    let buffer = commands.as_ptr();
    let host = Host {
        slice: 1,
        context: Box::new(Opaque {
            label: "old",
            _capability: Box::new(|| {}),
        }),
    };
    let out = lift_slice(host, Step::new(2, commands), move |mut host, slice| {
        host.slice = slice;
        host.context = captured;
        host
    });
    assert_eq!(out.state.slice, 2);
    assert_eq!(out.state.context.label, "borrowed replacement");
    assert!(std::ptr::eq(out.state.context.as_ref(), original));
    assert_eq!(out.commands.as_ptr(), buffer);
    assert_eq!(out.commands[0].label, "command");
}
#[test]
fn callback_and_iterator_panics_keep_the_original_payload_without_error_conversion() {
    for iterator in [false, true] {
        let cause = Arc::new(format!("original {iterator}"));
        let reader: ReadStep<'_, '_, (), (), Infallible> = ReadStep {
            name: "source".into(),
            read: Box::new(|_| panic_any(Arc::clone(&cause))),
        };
        let thrown = catch_unwind(AssertUnwindSafe(|| {
            if iterator {
                let mut first = true;
                let order = std::iter::from_fn(|| {
                    if first {
                        first = false;
                        panic_any(Arc::clone(&cause));
                    }
                    Some(&reader)
                });
                read_in_order(&(), order, ())
            } else {
                read_in_order(&(), [&reader], ())
            }
        }));
        let payload = thrown.expect_err("an unwind is not rewritten as a read Err");
        let actual = payload
            .downcast_ref::<Arc<String>>()
            .expect("original panic type");
        assert!(Arc::ptr_eq(actual, &cause));
    }
}
