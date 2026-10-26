#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The interface consumer deliberately borrows opaque local domain values."
)]
use demlik_tea::{ReadStep, Step};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    sync::Arc,
};
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{$calls.borrow_mut().push(stringify!($function));$function($($arg),*)}};}
struct Opaque<'a> {
    label: &'a str,
    capability: Box<dyn Fn() + 'a>,
}
struct Query<'a> {
    key: &'a str,
    payload: Rc<Opaque<'a>>,
}
struct Answer<'a> {
    title: &'a str,
    payload: Rc<Opaque<'a>>,
}
struct Cache<'a> {
    answer: Rc<Answer<'a>>,
}
struct Pending<'a> {
    query: &'a Query<'a>,
}
struct Model<'a> {
    cache: Rc<Cache<'a>>,
    pending: Rc<Pending<'a>>,
    context: &'a Opaque<'a>,
}
impl<'a> Model<'a> {
    fn with_cache(self: Arc<Self>, cache: Rc<Cache<'a>>) -> Arc<Self> {
        Arc::new(Self {
            cache,
            pending: Rc::clone(&self.pending),
            context: self.context,
        })
    }
    #[allow(
        dead_code,
        reason = "The type-refusal fixture uses this other real field-owner method."
    )]
    fn with_pending(self: Arc<Self>, pending: Rc<Pending<'a>>) -> Arc<Self> {
        Arc::new(Self {
            cache: Rc::clone(&self.cache),
            pending,
            context: self.context,
        })
    }
}
struct Command<'a> {
    query: &'a Query<'a>,
}
struct Cause<'a> {
    owner: &'a Opaque<'a>,
}
struct AppError<'a> {
    cause: &'a Cause<'a>,
    seal: Box<Opaque<'a>>,
}
fn echo<'input, 'value>(
    input: &'input Query<'value>,
    calls: &RefCell<Vec<&'static str>>,
) -> &'input Query<'value> {
    // The returned input loan outlives this function's local callbacks and counter.
    let misses = Cell::new(0);
    let miss = ReadStep {
        name: "cache".into(),
        read: Box::new(|_: &'input Query<'value>| {
            misses.set(misses.get() + 1);
            Ok::<_, Infallible>(None)
        }),
    };
    let hit = ReadStep {
        name: "inFlight".into(),
        read: Box::new(|actual: &'input Query<'value>| Ok(Some(actual))),
    };
    let result = observe!(
        calls,
        demlik_tea::read_in_order,
        input,
        [&miss, &hit],
        input
    );
    assert_eq!(misses.get(), 1);
    match result {
        Ok(answer) => answer,
        Err(never) => match never {},
    }
}
fn read_error<'input, 'value, 'cause>(
    input: &'input Query<'value>,
    cause: &'cause Cause<'cause>,
    calls: &RefCell<Vec<&'static str>>,
) -> AppError<'cause> {
    let error = AppError {
        cause,
        seal: Box::new(Opaque {
            label: "original error",
            capability: Box::new(|| {}),
        }),
    };
    let original_seal = error.seal.as_ref() as *const Opaque<'_>;
    let slot = RefCell::new(Some(error));
    let attempted = Cell::new(0);
    let failed = Rc::new(ReadStep {
        name: "source".into(),
        read: Box::new(|_: &'input Query<'value>| {
            attempted.set(attempted.get() + 1);
            Err::<Option<&'input Query<'value>>, _>(
                slot.borrow_mut().take().expect("one actual callback"),
            )
        }),
    });
    let skipped = Rc::new(ReadStep {
        name: "must-not-run".into(),
        read: Box::new(
            |_: &'input Query<'value>| -> Result<Option<&'input Query<'value>>, AppError<'cause>> {
                panic!("later reader after failure")
            },
        ),
    });
    let result = observe!(
        calls,
        demlik_tea::read_in_order,
        input,
        vec![failed, skipped],
        input
    );
    assert_eq!(attempted.get(), 1);
    match result {
        Err(error) => {
            assert!(std::ptr::eq(error.cause, cause));
            assert!(std::ptr::eq(error.seal.as_ref(), original_seal));
            error
        }
        Ok(_) => panic!("original failure must escape"),
    }
}
fn main() {
    let invoice = String::from("invoice-42");
    let title = String::from("paid invoice");
    let host_label = String::from("borrowed host");
    let payload = Rc::new(Opaque {
        label: &host_label,
        capability: Box::new(|| {}),
    });
    let query = Query {
        key: &invoice,
        payload: Rc::clone(&payload),
    };
    let old_answer = Rc::new(Answer {
        title: "old",
        payload: Rc::clone(&payload),
    });
    let answer = Rc::new(Answer {
        title: &title,
        payload: Rc::clone(&payload),
    });
    let original = Arc::new(Model {
        cache: Rc::new(Cache { answer: old_answer }),
        pending: Rc::new(Pending { query: &query }),
        context: &payload,
    });
    let replacement = Rc::new(Cache {
        answer: Rc::clone(&answer),
    });
    let commands = vec![Command { query: &query }];
    let command_buffer = commands.as_ptr();
    let command_capacity = commands.capacity();
    let calls = RefCell::new(vec![]);
    let lifted = observe!(
        calls,
        demlik_tea::lift_slice,
        Arc::clone(&original),
        Step::new(replacement, commands),
        Model::with_cache
    );
    assert!(!Arc::ptr_eq(&original, &lifted.state));
    assert!(Rc::ptr_eq(&original.pending, &lifted.state.pending));
    assert!(std::ptr::eq(original.context, lifted.state.context));
    assert_eq!(lifted.state.cache.answer.title, "paid invoice");
    assert_eq!(original.cache.answer.title, "old");
    assert!(Rc::ptr_eq(&lifted.state.cache.answer, &answer));
    assert!(Rc::ptr_eq(&answer.payload, &payload));
    assert_eq!(lifted.commands.as_ptr(), command_buffer);
    assert_eq!(lifted.commands.capacity(), command_capacity);
    assert!(std::ptr::eq(lifted.commands[0].query, &query));
    assert!(std::ptr::eq(lifted.state.pending.query, &query));
    let echoed = echo(&query, &calls);
    assert!(std::ptr::eq(echoed, &query));
    assert_eq!(echoed.key, "invoice-42");
    assert!(Rc::ptr_eq(&echoed.payload, &payload));
    let cause = Cause { owner: &payload };
    let error = read_error(&query, &cause, &calls);
    assert!(std::ptr::eq(error.cause.owner, payload.as_ref()));
    (error.seal.capability)();
    assert_eq!(payload.label, "borrowed host");
    // Inferred callback/input/output/error types, with no type arguments on the call.
    let read_answer = ReadStep {
        name: "answer".into(),
        read: Box::new(|_: &Query<'_>| Ok::<_, Infallible>(Some(answer.as_ref()))),
    };
    let chosen = observe!(
        calls,
        demlik_tea::read_in_order,
        &query,
        [&read_answer],
        answer.as_ref()
    );
    let chosen = match chosen {
        Ok(chosen) => chosen,
        Err(never) => match never {},
    };
    assert!(std::ptr::eq(chosen, answer.as_ref()));
    println!(
        "{{\"status\":\"passed\",\"borrowedOpaqueInputOutputError\":true,\"readerForms\":[\"borrowed-array\",\"owned-Rc-iterator\"],\"observedRustCalls\":{:?}}}",
        calls.into_inner()
    );
}
