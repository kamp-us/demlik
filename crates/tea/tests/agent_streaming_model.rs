use demlik_tea::{
    agent::model::{Llm, Messages, ModelFactory, ModelStream, TurnChunk, streaming_model},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
struct Opaque<'a>(&'a Cell<u8>);
struct Failure<'a>(&'a Cell<u8>);
struct Parser<'a>(&'a Cell<usize>);
impl<'a> Schema for Parser<'a> {
    type Raw = Rc<Opaque<'a>>;
    type Output = Rc<Opaque<'a>>;
    type Error = Failure<'a>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        self.0.set(self.0.get() + 1);
        Ok(raw)
    }
}
fn prove<'ctx>(host: &'ctx Cell<u8>, parses: &'ctx Cell<usize>) {
    let messages = [Opaque(host)];
    let expected = messages.as_ptr();
    let answer = Rc::new(Opaque(host));
    let original = Rc::clone(&answer);
    let failure = Rc::new(Failure(host));
    let cause = Rc::clone(&failure);
    let chunk = Rc::new(TurnChunk {
        text: "delta".into(),
    });
    let emitted = Rc::clone(&chunk);
    let chunks = Rc::new(RefCell::new(Vec::new()));
    let captured = Rc::clone(&chunks);
    let model = streaming_model(
        async move |received: Messages<'_, Opaque<'ctx>>, stream: ModelStream| {
            assert!(std::ptr::eq(received.as_ref().as_ptr(), expected));
            assert!(std::ptr::eq(received.as_ref()[0].0, host));
            stream.on_chunk(Rc::clone(&emitted));
            if host.get() == 0 {
                Err(CallValue::shared(Rc::clone(&cause)))
            } else {
                Ok(Rc::clone(&answer))
            }
        },
    );
    let llm = <_ as ModelFactory<Opaque<'ctx>, Parser<'ctx>>>::model_of_with_stream(
        &model,
        None,
        ModelStream::new(move |chunk| captured.borrow_mut().push(Rc::clone(chunk))),
    )
    .unwrap_or_else(|_| panic!("binding is infallible"));
    let schema = Parser(parses);
    let runnable = llm
        .with_structured_output(&schema)
        .unwrap_or_else(|_| panic!("binding is infallible"));
    let Ok(actual) = futures::executor::block_on(runnable(Messages::Borrowed(&messages))) else {
        panic!("model succeeds")
    };
    assert!(Rc::ptr_eq(&actual, &original));
    assert_eq!(parses.get(), 1);
    host.set(0);
    let Err(CallValue::Shared(actual)) =
        futures::executor::block_on(runnable(Messages::Borrowed(&messages)))
    else {
        panic!("model retains its failure")
    };
    assert!(Rc::ptr_eq(&actual, &failure));
    assert!(std::ptr::eq(actual.0, host));
    assert_eq!(parses.get(), 1, "provider errors bypass schema parsing");
    assert_eq!(chunks.borrow().len(), 2);
    assert!(
        chunks
            .borrow()
            .iter()
            .all(|value| Rc::ptr_eq(value, &chunk))
    );
}
#[test]
fn streaming_port_borrows_opaque_messages_schema_and_provider_causes_without_payload_traits() {
    let host = Cell::new(7);
    let parses = Cell::new(0);
    prove(&host, &parses);
}
