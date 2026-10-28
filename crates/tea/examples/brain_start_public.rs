use demlik_tea::{
    agent::model::{BrainPorts, Llm, MessageLoader, Messages, ModelFactory, brain_handler},
    command::Outcome,
    data::JsText,
    llm_call::{CauseField, Config, LlmCall, Request, Schema},
    resilience::resilient_call::{CallValue, RunInput},
};
use std::{
    cell::{Cell, RefCell},
    future::Future,
    ops::AsyncFn,
    rc::Rc,
    task::{Context, Poll},
};

struct Opaque<'a> {
    text: &'a str,
    local: Rc<()>,
}
struct Payload<'a>(&'a Cell<u8>);
struct Message<'a>(&'a Cell<u8>);
struct Counts {
    factories: Cell<usize>,
    loads: Cell<usize>,
    binds: Cell<usize>,
    invokes: Cell<usize>,
    parses: Cell<usize>,
    drops: Cell<usize>,
}
struct Parser<'a> {
    counts: &'a Counts,
}
impl<'a> Schema for Parser<'a> {
    type Raw = Rc<Opaque<'a>>;
    type Output = Rc<Opaque<'a>>;
    type Error = Opaque<'a>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        self.counts.parses.set(self.counts.parses.get() + 1);
        Ok(raw)
    }
}
struct Host<'a> {
    counts: &'a Counts,
    raw: Rc<Opaque<'a>>,
    cause: Rc<Opaque<'a>>,
    schema: Rc<Parser<'a>>,
    fail: Cell<bool>,
    context: &'a Cell<u8>,
}
struct Model<'a, 'b> {
    host: &'b Host<'a>,
}
impl Drop for Model<'_, '_> {
    fn drop(&mut self) {
        self.host.counts.drops.set(self.host.counts.drops.get() + 1);
    }
}
impl<'cfg> Llm<Message<'cfg>, Parser<'cfg>> for Model<'cfg, '_> {
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a Parser<'cfg>,
    ) -> Result<
        impl for<'m> AsyncFn(
            Messages<'m, Message<'cfg>>,
        ) -> Result<Rc<Opaque<'cfg>>, CallValue<Opaque<'cfg>>>
        + 'a,
        CallValue<Opaque<'cfg>>,
    > {
        self.host.counts.binds.set(self.host.counts.binds.get() + 1);
        assert!(std::ptr::eq(schema, self.host.schema.as_ref()));
        Ok(async move |messages: Messages<'_, Message<'cfg>>| {
            self.host
                .counts
                .invokes
                .set(self.host.counts.invokes.get() + 1);
            assert!(std::ptr::eq(messages.as_ref()[0].0, self.host.context));
            schema.parse(Rc::clone(&self.host.raw))
        })
    }
}
impl<'cfg> ModelFactory<Message<'cfg>, Parser<'cfg>> for Host<'cfg> {
    fn model_of(
        &self,
        id: Option<&JsText>,
    ) -> Result<impl Llm<Message<'cfg>, Parser<'cfg>>, CallValue<Opaque<'cfg>>> {
        assert!(id.is_none());
        self.counts.factories.set(self.counts.factories.get() + 1);
        if self.fail.get() {
            Err(CallValue::Shared(Rc::clone(&self.cause)))
        } else {
            Ok(Model { host: self })
        }
    }
}
struct Loader<'a> {
    counts: &'a Counts,
    messages: Vec<Message<'a>>,
    history: RefCell<Vec<Rc<Request<&'static str, Payload<'a>>>>>,
    context: &'a Cell<u8>,
}
impl<'cfg> MessageLoader<&'static str, Payload<'cfg>, Message<'cfg>, Opaque<'cfg>>
    for Loader<'cfg>
{
    fn load<'a>(
        &'a self,
        call: &'a Rc<Request<&'static str, Payload<'cfg>>>,
    ) -> impl Future<Output = Result<Messages<'a, Message<'cfg>>, CallValue<Opaque<'cfg>>>>
    where
        Message<'cfg>: 'a,
    {
        self.counts.loads.set(self.counts.loads.get() + 1);
        self.history.borrow_mut().push(Rc::clone(call));
        assert!(std::ptr::eq(call.payload.0, self.context));
        async { Ok(Messages::Borrowed(&self.messages)) }
    }
}
fn main() {
    let text = String::from("borrowed nonserializable answer");
    let context = Cell::new(7);
    let counts = Counts {
        factories: Cell::new(0),
        loads: Cell::new(0),
        binds: Cell::new(0),
        invokes: Cell::new(0),
        parses: Cell::new(0),
        drops: Cell::new(0),
    };
    let raw = Rc::new(Opaque {
        text: &text,
        local: Rc::new(()),
    });
    let cause = Rc::new(Opaque {
        text: &text,
        local: Rc::new(()),
    });
    let schema = Rc::new(Parser { counts: &counts });
    let selected = Rc::clone(&schema);
    let llm = LlmCall::new(
        Config::new(|_: &&str| Rc::clone(&selected)),
        |_: &Opaque<'_>| Ok("caller cause".into()),
    );
    let host = Host {
        counts: &counts,
        raw: Rc::clone(&raw),
        cause: Rc::clone(&cause),
        schema,
        fail: Cell::new(false),
        context: &context,
    };
    let loader = Loader {
        counts: &counts,
        messages: vec![Message(&context)],
        history: RefCell::new(vec![]),
        context: &context,
    };
    let call = Rc::new(Request::new("invoice", None, Payload(&context)));
    let step = llm.attempt(&llm.init(), Rc::clone(&call), 0.0).unwrap();
    let cmd = &step.commands[0];
    let handler = brain_handler(&llm, BrainPorts::new(&host).with_loader(&loader));
    assert!(handler.has_loader());
    let lazy = handler.handle(cmd);
    assert_eq!(counts.factories.get(), 0);
    drop(lazy);
    assert_eq!(counts.factories.get(), 0);
    let operation = handler.start(cmd);
    assert_eq!(counts.factories.get(), 1);
    assert_eq!(counts.loads.get(), 1);
    assert_eq!(counts.binds.get(), 0);
    assert_eq!(counts.invokes.get(), 0);
    assert_eq!(counts.drops.get(), 0);
    assert!(Rc::ptr_eq(&loader.history.borrow()[0], &call));
    let mut operation = std::pin::pin!(operation);
    let mut cx = Context::from_waker(futures::task::noop_waker_ref());
    assert!(operation.as_mut().poll(&mut cx).is_pending());
    assert_eq!(counts.binds.get(), 0);
    assert_eq!(counts.invokes.get(), 0);
    assert_eq!(counts.parses.get(), 0);
    assert!(operation.as_mut().poll(&mut cx).is_pending());
    assert_eq!(counts.binds.get(), 1);
    assert_eq!(counts.invokes.get(), 1);
    assert_eq!(counts.parses.get(), 1);
    assert_eq!(counts.drops.get(), 0);
    let Poll::Ready(Ok(Outcome::Ok {
        value: CallValue::Shared(answer),
    })) = operation.as_mut().poll(&mut cx)
    else {
        panic!("third poll returns typed answer");
    };
    assert_eq!(counts.parses.get(), 2);
    assert!(Rc::ptr_eq(&answer.output, &raw));
    assert!(Rc::ptr_eq(&answer.output.local, &raw.local));
    assert_eq!(counts.drops.get(), 1);
    host.fail.set(true);
    let failed = brain_handler(&llm, BrainPorts::new(&host).with_loader(&loader)).start(cmd);
    assert_eq!(counts.factories.get(), 2);
    assert_eq!(counts.loads.get(), 1);
    let out = futures::executor::block_on(failed).unwrap();
    let Outcome::Err { error } = out else {
        panic!("canonical rejected outcome");
    };
    let CauseField::Own(CallValue::Shared(original)) = error.details.cause() else {
        panic!("original cause");
    };
    assert!(Rc::ptr_eq(original, &cause));
    host.fail.set(false);
    let missing = llm.run().from_record(RunInput {
        key: "invoice".into(),
        input: CallValue::Undefined,
    });
    let rejected = brain_handler(&llm, BrainPorts::new(&host).with_loader(&loader)).start(&missing);
    assert_eq!(counts.factories.get(), 2);
    let Outcome::Err { error } = futures::executor::block_on(rejected).unwrap() else {
        panic!("input refusal stays outcome");
    };
    assert!(matches!(error.details.cause(), CauseField::AccessError(_)));
    let absent = brain_handler(&llm, BrainPorts::new(&host));
    assert!(!absent.has_loader());
    assert_eq!(raw.text, text);
    context.set(8);
    assert_eq!(call.payload.0.get(), 8);
    println!(
        "prefix before poll; ready loader/invoke defer separately; original request/schema/model/output/cause; owned model drop; lazy handle; canonical early rejection; NoMessages absent: true"
    );
}
