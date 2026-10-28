use std::cell::{Cell, RefCell};
use std::future::Future;
use std::rc::Rc;

use demlik_tea::agent::model::{MessageLoader, Messages};
use demlik_tea::data::JsText;
use demlik_tea::llm_call::Request;
use demlik_tea::resilience::resilient_call::CallValue;

struct Payload<'a> {
    text: &'a str,
    fail: bool,
}
struct Opaque<'a> {
    text: &'a str,
    local: Rc<Cell<usize>>,
}
struct Message<'a>(&'a str);
struct Loader<'cfg> {
    starts: Cell<usize>,
    messages: Vec<Message<'cfg>>,
    history: RefCell<Vec<Rc<Request<JsText, Payload<'cfg>>>>>,
    cause: Rc<Opaque<'cfg>>,
}
impl<'cfg> MessageLoader<JsText, Payload<'cfg>, Message<'cfg>, Opaque<'cfg>> for Loader<'cfg> {
    fn load<'a>(
        &'a self,
        call: &'a Rc<Request<JsText, Payload<'cfg>>>,
    ) -> impl Future<Output = Result<Messages<'a, Message<'cfg>>, CallValue<Opaque<'cfg>>>>
    where
        Message<'cfg>: 'a,
    {
        self.starts.set(self.starts.get() + 1);
        self.history.borrow_mut().push(Rc::clone(call));
        assert_eq!(call.payload.text, self.messages[0].0);
        async move {
            if call.payload.fail {
                Err(CallValue::Shared(Rc::clone(&self.cause)))
            } else {
                Ok(Messages::Borrowed(&self.messages))
            }
        }
    }
}
fn main() {
    let text = String::from("borrowed caller");
    let cause = Rc::new(Opaque {
        text: &text,
        local: Rc::new(Cell::new(0)),
    });
    let loader = Loader {
        starts: Cell::new(0),
        messages: vec![Message(&text)],
        history: RefCell::new(vec![]),
        cause: Rc::clone(&cause),
    };
    let call = Rc::new(Request::new(
        JsText::from("invoice"),
        None,
        Payload {
            text: &text,
            fail: false,
        },
    ));
    let future = loader.load(&call);
    assert_eq!(
        loader.starts.get(),
        1,
        "ordinary function prefix runs before poll"
    );
    let messages = match futures::executor::block_on(future) {
        Ok(v) => v,
        Err(_) => panic!("expected messages"),
    };
    assert!(std::ptr::eq(messages.as_ref(), loader.messages.as_slice()));
    drop(messages);
    assert!(Rc::ptr_eq(&loader.history.borrow()[0], &call));
    let fail = Rc::new(Request::new(
        JsText::from("invoice"),
        None,
        Payload {
            text: &text,
            fail: true,
        },
    ));
    let future = loader.load(&fail);
    assert_eq!(loader.starts.get(), 2);
    match futures::executor::block_on(future) {
        Err(CallValue::Shared(original)) => assert!(Rc::ptr_eq(&original, &cause)),
        _ => panic!("original cause"),
    }
    assert_eq!(cause.text, text);
    assert_eq!(cause.local.get(), 0);
    println!(
        "ordinary fn implements unchanged async MessageLoader; prefix before poll, borrowed messages, original request/cause: true"
    );
}
