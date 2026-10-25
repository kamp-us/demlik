use demlik_tea::{
    agent::model::{BrainPorts, MessageLoader, Messages, brain_handler, plain_model},
    command::Outcome,
    llm_call::{Config, LlmCall, Request, Schema},
    resilience::resilient_call::CallValue,
};
use std::{cell::Cell, rc::Rc};
struct Opaque<'a>(&'a Cell<u8>);
enum Raw<'a> {
    Initial(Opaque<'a>),
    Parsed(Output<'a>),
}
struct Output<'a> {
    n: u8,
    opaque: Opaque<'a>,
}
impl<'a> From<Output<'a>> for Raw<'a> {
    fn from(value: Output<'a>) -> Self {
        Self::Parsed(value)
    }
}
struct Failure<'a>(&'a Cell<u8>);
struct Parser<'a>(&'a Cell<usize>);
struct Borrowed<'a>(&'a [Opaque<'a>]);
impl<'ctx, P, I> MessageLoader<P, I, Opaque<'ctx>, Failure<'ctx>> for Borrowed<'ctx> {
    async fn load<'a>(
        &'a self,
        _: &'a Rc<Request<P, I>>,
    ) -> Result<Messages<'a, Opaque<'ctx>>, CallValue<Failure<'ctx>>>
    where
        Opaque<'ctx>: 'a,
    {
        Ok(Messages::Borrowed(self.0))
    }
}
impl<'a> Schema for Parser<'a> {
    type Raw = Raw<'a>;
    type Output = Output<'a>;
    type Error = Failure<'a>;
    fn parse(&self, raw: Raw<'a>) -> Result<Output<'a>, CallValue<Failure<'a>>> {
        self.0.set(self.0.get() + 1);
        Ok(match raw {
            Raw::Initial(opaque) => Output { n: 1, opaque },
            Raw::Parsed(Output { n, opaque }) => Output { n: n + 1, opaque },
        })
    }
}
#[test]
fn plain_model_revalidates_a_distinct_output_type_without_cloning_borrowed_opaque_data() {
    let calls = Cell::new(0);
    let context = Cell::new(7);
    let messages = [Opaque(&context)];
    let schema = Rc::new(Parser(&calls));
    let selected = Rc::clone(&schema);
    let llm = LlmCall::new(
        Config::new(move |_: &&str| Rc::clone(&selected)),
        |error: &Failure<'_>| Ok(error.0.get().to_string().into()),
    );
    let model = plain_model(async |messages: Messages<'_, Opaque<'_>>| {
        assert_eq!(messages.as_ref().len(), 1);
        assert!(std::ptr::eq(messages.as_ref()[0].0, &context));
        std::future::ready(()).await;
        assert_eq!(messages.as_ref()[0].0.get(), 7);
        Ok(Raw::Initial(Opaque(&context)))
    });
    let loader = Borrowed(&messages);
    let handler = brain_handler(&llm, BrainPorts::new(&model).with_loader(&loader));
    let attempted = llm
        .attempt(
            &llm.init(),
            Rc::new(Request::new("turn", None, Opaque(&context))),
            0.0,
        )
        .unwrap();
    let outcome = futures::executor::block_on(handler.handle(&attempted.commands[0])).unwrap();
    let Outcome::Ok {
        value: CallValue::Shared(ok),
    } = outcome
    else {
        panic!("the transformed output should be accepted")
    };
    assert_eq!(ok.output.n, 2);
    assert_eq!(calls.get(), 2);
    assert!(std::ptr::eq(ok.output.opaque.0, &context));
}

struct HeldLoader<'a> {
    receiver: std::cell::RefCell<Option<tokio::sync::oneshot::Receiver<()>>>,
    messages: &'a [Opaque<'a>],
    trace: &'a std::cell::RefCell<Vec<&'static str>>,
}
impl<'ctx, P, I> MessageLoader<P, I, Opaque<'ctx>, Failure<'ctx>> for HeldLoader<'ctx> {
    async fn load<'a>(
        &'a self,
        _: &'a Rc<Request<P, I>>,
    ) -> Result<Messages<'a, Opaque<'ctx>>, CallValue<Failure<'ctx>>>
    where
        Opaque<'ctx>: 'a,
    {
        self.trace.borrow_mut().push("loader");
        let receiver = self.receiver.borrow_mut().take().unwrap();
        receiver.await.unwrap();
        Ok(Messages::Borrowed(self.messages))
    }
}
#[test]
fn a_pending_borrowed_loader_finishes_before_binding_invocation_and_schema_parsing() {
    futures::executor::block_on(async {
        let calls = Cell::new(0);
        let context = Cell::new(3);
        let messages = [Opaque(&context)];
        let trace = std::cell::RefCell::new(vec![]);
        let schema = Rc::new(Parser(&calls));
        let selected = Rc::clone(&schema);
        let llm = LlmCall::new(
            Config::new(move |_: &&str| Rc::clone(&selected)),
            |_: &Failure<'_>| Ok("failure".into()),
        );
        let model = plain_model(async |messages: Messages<'_, Opaque<'_>>| {
            trace.borrow_mut().push("invoke");
            assert!(std::ptr::eq(messages.as_ref()[0].0, &context));
            Ok(Raw::Initial(Opaque(&context)))
        });
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let loader = HeldLoader {
            receiver: std::cell::RefCell::new(Some(receiver)),
            messages: &messages,
            trace: &trace,
        };
        let handler = brain_handler(&llm, BrainPorts::new(&model).with_loader(&loader));
        let step = llm
            .attempt(&llm.init(), Rc::new(Request::new("turn", None, ())), 0.0)
            .unwrap();
        let mut future = Box::pin(handler.handle(&step.commands[0]));
        assert!(futures::poll!(future.as_mut()).is_pending());
        assert_eq!(&*trace.borrow(), &["loader"]);
        assert_eq!(calls.get(), 0);
        sender.send(()).unwrap();
        assert!(future.await.is_ok());
        assert_eq!(&*trace.borrow(), &["loader", "invoke"]);
        assert_eq!(calls.get(), 2);
    });
}

struct RetainingLoader<'ctx> {
    calls: std::cell::RefCell<Vec<Rc<Request<&'static str, Opaque<'ctx>>>>>,
    messages: &'ctx [Opaque<'ctx>],
}
impl<'ctx> MessageLoader<&'static str, Opaque<'ctx>, Opaque<'ctx>, Failure<'ctx>>
    for RetainingLoader<'ctx>
{
    async fn load<'a>(
        &'a self,
        call: &'a Rc<Request<&'static str, Opaque<'ctx>>>,
    ) -> Result<Messages<'a, Opaque<'ctx>>, CallValue<Failure<'ctx>>>
    where
        Opaque<'ctx>: 'a,
    {
        self.calls.borrow_mut().push(Rc::clone(call));
        std::future::ready(()).await;
        Ok(Messages::Borrowed(self.messages))
    }
}
#[test]
fn loader_can_retain_the_original_call_after_the_handler_and_command_are_released() {
    let context = Cell::new(7);
    let calls = Cell::new(0);
    let messages = [Opaque(&context)];
    let loader = RetainingLoader {
        calls: std::cell::RefCell::new(vec![]),
        messages: &messages,
    };
    let input = Rc::new(Request::new("turn", None, Opaque(&context)));
    let weak = Rc::downgrade(&input);
    {
        let schema = Rc::new(Parser(&calls));
        let selected = Rc::clone(&schema);
        let llm = LlmCall::new(
            Config::new(move |_: &&str| Rc::clone(&selected)),
            |_: &Failure<'_>| Ok("failure".into()),
        );
        let model = plain_model(async |received: Messages<'_, Opaque<'_>>| {
            assert!(std::ptr::eq(received.as_ref(), messages.as_slice()));
            Ok(Raw::Initial(Opaque(&context)))
        });
        let handler = brain_handler(&llm, BrainPorts::new(&model).with_loader(&loader));
        let step = llm.attempt(&llm.init(), Rc::clone(&input), 0.0).unwrap();
        assert!(futures::executor::block_on(handler.handle(&step.commands[0])).is_ok());
    }
    assert!(Rc::ptr_eq(&loader.calls.borrow()[0], &input));
    drop(input);
    assert_eq!(
        weak.strong_count(),
        1,
        "only the actual loader history retains this request"
    );
    context.set(9);
    assert_eq!(loader.calls.borrow()[0].payload.0.get(), 9);
    assert!(std::ptr::eq(loader.calls.borrow()[0].payload.0, &context));
}

#[test]
fn schema_selector_panics_remain_native_unwinds_with_the_original_payload() {
    use std::{
        panic::{AssertUnwindSafe, catch_unwind, panic_any},
        sync::Arc,
    };
    for fail_at in [1, 2] {
        let original = Arc::new("original schema lookup");
        let calls = Cell::new(0);
        let reads = Cell::new(0);
        let context = Cell::new(7);
        let schema = Rc::new(Parser(&calls));
        let llm = LlmCall::new(
            Config::new(|_: &&str| {
                reads.set(reads.get() + 1);
                if reads.get() == fail_at {
                    panic_any(Arc::clone(&original));
                }
                Rc::clone(&schema)
            }),
            |_: &Failure<'_>| Ok("failure".into()),
        );
        let model = plain_model(async |_: Messages<'_, ()>| Ok(Raw::Initial(Opaque(&context))));
        let handler = brain_handler(&llm, BrainPorts::new(&model));
        let step = llm
            .attempt(&llm.init(), Rc::new(Request::new("turn", None, ())), 0.0)
            .unwrap();
        let caught = catch_unwind(AssertUnwindSafe(|| {
            futures::executor::block_on(handler.handle(&step.commands[0]))
        }));
        let Err(payload) = caught else {
            panic!("this profile is native unwind, not a declared Result failure")
        };
        let payload = payload.downcast::<Arc<&str>>().unwrap();
        assert!(Arc::ptr_eq(&original, &payload));
        assert_eq!(reads.get(), fail_at);
    }
}
