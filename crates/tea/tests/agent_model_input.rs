use demlik_tea::{
    Tagged,
    agent::model::{BrainPorts, Messages, brain_handler, plain_model},
    command::Outcome,
    llm_call::{CauseField, Config, LlmCall, LlmCause, Request, Schema},
    resilience::resilient_call::{CallFailure, CallPhase, CallValue, RunInput},
};
use std::{cell::Cell, rc::Rc};

struct Opaque<'a>(&'a Cell<u8>);
struct Parser<'a>(&'a Cell<usize>);
impl<'a> Schema for Parser<'a> {
    type Raw = ();
    type Output = ();
    type Error = Opaque<'a>;

    fn parse(&self, (): ()) -> Result<(), CallValue<Opaque<'a>>> {
        self.0.set(self.0.get() + 1);
        Ok(())
    }
}

#[test]
fn missing_and_undefined_inputs_are_rejected_before_model_work() {
    let parses = Cell::new(0);
    let invocations = Cell::new(0);
    let schema = Rc::new(Parser(&parses));
    let selected = Rc::clone(&schema);
    let llm: LlmCall<'_, &str, (), Parser<'_>> = LlmCall::new(
        Config::new(move |_| Rc::clone(&selected)),
        |cause: &Opaque<'_>| Ok(cause.0.get().to_string().into()),
    );
    let model = plain_model(async |_: Messages<'_, ()>| {
        invocations.set(invocations.get() + 1);
        Ok(())
    });
    let handler = brain_handler(&llm, BrainPorts::new(&model));
    let mut previous = None;
    for input in [CallValue::Missing, CallValue::Undefined] {
        let cmd = llm.run().from_record(RunInput {
            key: "turn".into(),
            input,
        });
        let outcome = futures::executor::block_on(handler.handle(&cmd));
        let Ok(Outcome::Err { error }) = outcome else {
            panic!("a missing model-call input must settle as port_rejected")
        };
        assert_eq!(error.tag(), "port_rejected");
        let CauseField::AccessError(cause) = error.details.cause() else {
            panic!("the library error must remain independent of the opaque app cause")
        };
        assert_eq!(cause.name, "TypeError");
        assert_eq!(
            cause.message,
            "Cannot read properties of undefined (reading 'model')"
        );
        let copy = error.details.clone();
        assert!(error.details.same(&copy));
        let CauseField::AccessError(retained) = copy.cause() else {
            panic!("cloning a rejection must retain its cause")
        };
        assert!(Rc::ptr_eq(cause, retained));
        if let Some(previous) = previous {
            assert!(!Rc::ptr_eq(cause, &previous));
        }
        previous = Some(Rc::clone(cause));
    }
    assert_eq!(parses.get(), 0);
    assert_eq!(invocations.get(), 0);
}

struct JsonParser;
impl Schema for JsonParser {
    type Raw = u8;
    type Output = u8;
    type Error = demlik_tea::PlainData;

    fn parse(&self, raw: u8) -> Result<u8, CallValue<Self::Error>> {
        Ok(raw)
    }
}

#[test]
fn library_error_retains_its_live_cause_but_serializes_like_a_js_error() {
    let llm: LlmCall<'_, &str, (), JsonParser> =
        LlmCall::new(Config::new(|_| Rc::new(JsonParser)), |_| {
            panic!("a library cause must bypass the app error formatter")
        });
    let model = plain_model(async |_: Messages<'_, ()>| Ok(7));
    let handler = brain_handler(&llm, BrainPorts::new(&model));
    let missing = llm.run().from_record(RunInput {
        key: "turn".into(),
        input: CallValue::Missing,
    });
    let outcome = futures::executor::block_on(handler.handle(&missing)).unwrap();
    assert_eq!(
        serde_json::to_value(&outcome).unwrap(),
        serde_json::json!({"_tag":"Err","error":{"_tag":"port_rejected","cause":{}}})
    );
    let Outcome::Err { error } = outcome else {
        panic!("missing input is a rejected outcome")
    };
    let CauseField::AccessError(cause) = error.details.cause() else {
        panic!("the caught access error remains available")
    };
    let original = Rc::clone(cause);
    let mut attempted = llm
        .attempt(&llm.init(), Rc::new(Request::new("turn", None, ())), 4.0)
        .unwrap();
    let cmd = attempted.commands.pop().unwrap();
    let msg = llm.run().err(cmd, error, Some(5.0));
    let parsed = llm.err_of(&msg).unwrap();
    assert_eq!(parsed.reason.as_utf8(), Some(original.message.as_str()));
    let LlmCause::AccessError(retained) = &parsed.error else {
        panic!("reading a failure must retain the caught error")
    };
    assert!(Rc::ptr_eq(retained, &original));
    assert_eq!(
        serde_json::to_value(&parsed.error).unwrap(),
        serde_json::json!({})
    );
    let failed = llm.fail(&attempted.state, &msg).unwrap();
    let Some(CallPhase::Failed { error }) = failed.state.call("turn") else {
        panic!("the rejected cause must reach the existing failure state")
    };
    let CallFailure::External(failure) = error.as_ref() else {
        panic!("the failure is a typed external outcome")
    };
    assert!(
        matches!(&failure.error, LlmCause::AccessError(retained) if Rc::ptr_eq(retained, &original))
    );
}
