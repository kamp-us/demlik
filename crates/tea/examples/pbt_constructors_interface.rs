#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The public generator contract supports borrowed, opaque local messages."
)]
use demlik_tea::{
    Machine, Step, Sub, Tagged, Update,
    pbt::{FailedCase, PredicateFailure, PropertyFailure, PropertyOptions},
};
use proptest::{
    strategy::{Strategy, ValueTree},
    test_runner::{Config, RngSeed, TestRunner, noop_result_cache},
};
use std::{cell::RefCell, fmt, rc::Rc, sync::Arc};

macro_rules! observe {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        $calls.borrow_mut().push(stringify!($function));
        $function($($arg),*)
    }};
}
struct Opaque<'a> {
    invoice: &'a str,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
struct Fields<'a> {
    at: u8,
    invoice: &'a str,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
impl fmt::Debug for Fields<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Fields").field(&self.at).finish()
    }
}
enum Msg<'a> {
    Start,
    Received {
        fields: Fields<'a>,
        receipt: Rc<Opaque<'a>>,
    },
}
impl Tagged for Msg<'_> {
    fn tag(&self) -> &str {
        match self {
            Self::Start => "start",
            Self::Received { .. } => "received",
        }
    }
}
impl demlik_tea::core::Message for Msg<'_> {
    const TYPES: &'static [&'static str] = &["start", "received"];
}
impl fmt::Debug for Msg<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.tag())
    }
}
struct Model<'a> {
    count: u8,
    receipt: Rc<Opaque<'a>>,
}
impl Tagged for Model<'_> {
    fn tag(&self) -> &str {
        "invoice"
    }
}
struct Command<'a> {
    invoice: &'a str,
    receipt: Rc<Opaque<'a>>,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
struct Context<'a> {
    invoice: &'a str,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
struct AppError<'a> {
    note: &'a str,
    cause: Rc<Opaque<'a>>,
}

fn main() {
    let invoice = String::from("invoice-42");
    let receipt = Rc::new(Opaque {
        invoice: &invoice,
        capability: Box::new(|| 17),
    });
    let cause = Rc::new(Opaque {
        invoice: &invoice,
        capability: Box::new(|| 19),
    });
    let calls = RefCell::new(vec![]);
    let original_fields = RefCell::new(vec![]);
    let mut runner = TestRunner::new(Config {
        cases: 1,
        rng_seed: RngSeed::Fixed(731),
        failure_persistence: None,
        result_cache: noop_result_cache,
        ..Config::default()
    });
    let start = {
        let strategy = observe!(&calls, demlik_tea::pbt::constant_msg, Msg::Start);
        let tree = strategy.new_tree(&mut runner).unwrap();
        let first = tree.current();
        assert!(Arc::ptr_eq(&first, &tree.current()));
        first
    };
    let received = {
        let fields = (7u8..=7).prop_map(|at| {
            let capability: Box<dyn Fn() -> u8> = Box::new(move || at);
            original_fields
                .borrow_mut()
                .push((&*capability as *const dyn Fn() -> u8).cast::<()>());
            Fields {
                at,
                invoice: &invoice,
                capability,
            }
        });
        let strategy = observe!(&calls, demlik_tea::pbt::record_msg, fields, |fields| {
            Msg::Received {
                fields,
                receipt: Rc::clone(&receipt),
            }
        });
        strategy.new_tree(&mut runner).unwrap().current()
    };
    let Msg::Received {
        fields,
        receipt: actual,
    } = received.as_ref()
    else {
        panic!("the authored enum constructor owns the message tag")
    };
    assert_eq!(fields.at, 7);
    assert_eq!(fields.invoice, "invoice-42");
    assert_eq!((fields.capability)(), 7);
    assert_eq!(
        (&*fields.capability as *const dyn Fn() -> u8).cast::<()>(),
        original_fields.borrow()[0]
    );
    assert!(std::ptr::eq(actual.as_ref(), receipt.as_ref()));
    assert_eq!(actual.invoice, "invoice-42");
    assert_eq!((actual.capability)(), 17);
    let context = Context {
        invoice: &invoice,
        capability: Box::new(|| 23),
    };
    let machine: Machine<'_, Model<'_>, Msg<'_>, Command<'_>, Sub, Context<'_>> = Machine {
        init: Box::new(|loaded, ctx| {
            assert_eq!(ctx.invoice, "invoice-42");
            assert_eq!((ctx.capability)(), 23);
            Step::new(
                loaded.unwrap_or(Model {
                    count: 0,
                    receipt: Rc::clone(&receipt),
                }),
                vec![],
            )
        }),
        update: Update::reducer(|state: &Model<'_>, message: &Msg<'_>| {
            let count = match message {
                Msg::Start => state.count + 1,
                Msg::Received { fields, .. } => state.count + fields.at,
            };
            Step::new(
                Model {
                    count,
                    receipt: Rc::clone(&state.receipt),
                },
                vec![Command {
                    invoice: &invoice,
                    receipt: Rc::clone(&state.receipt),
                    capability: Box::new(|| 29),
                }],
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let messages = vec![Arc::clone(&start), Arc::clone(&received)];
    let result = observe!(
        &calls,
        demlik_tea::pbt::property_trace,
        &machine,
        &context,
        &proptest::strategy::Just(messages),
        || Some(Model {
            count: 10,
            receipt: Rc::clone(&receipt),
        }),
        |steps, final_state| {
            assert_eq!(steps.len(), 2);
            assert_eq!(final_state.count, 18);
            Err(AppError {
                note: &invoice,
                cause: Rc::clone(&cause),
            })
        },
        PropertyOptions {
            num_runs: 1,
            seed: Some(731),
        }
    );
    let PropertyFailure::Case { evaluated, .. } = result.unwrap_err() else {
        panic!("the original evaluated error must remain available")
    };
    assert!(Arc::ptr_eq(&evaluated.messages[0], &start));
    assert!(Arc::ptr_eq(&evaluated.messages[1], &received));
    let FailedCase::Trace {
        trace,
        failure: PredicateFailure::Error(error),
    } = evaluated.failure
    else {
        panic!("the borrowed app error is not serialized or decorated")
    };
    assert_eq!(error.note, "invoice-42");
    assert!(Rc::ptr_eq(&error.cause, &cause));
    assert_eq!((error.cause.capability)(), 19);
    assert_eq!(trace.final_state.count, 18);
    for (index, step) in trace.steps.iter().enumerate() {
        assert!(Arc::ptr_eq(&step.msg, &evaluated.messages[index]));
        assert_eq!(step.commands.len(), 1);
        assert_eq!(step.commands[0].invoice, "invoice-42");
        assert!(Rc::ptr_eq(&step.commands[0].receipt, &receipt));
        assert_eq!((step.commands[0].capability)(), 29);
    }
    println!(
        r#"{{"status":"passed","borrowedOpaqueNonCloneFields":true,"ordinaryInference":true,"originalMessageAndErrorOwners":true,"observedRustCalls":{:?}}}"#,
        calls.into_inner()
    );
}
