use demlik_tea::{
    command::{Failure, Settlement},
    resilience::resilient_call::{
        CallFailure, CallPhase, CallValue, Config, ResilientCall, RunError, SettleInput,
    },
    retry_backoff::CountBound,
};
use std::{cell::Cell, rc::Rc};

struct Input<'a> {
    text: &'a str,
    visits: &'a Cell<u8>,
}
struct Cause<'a> {
    message: &'a str,
    visits: &'a Cell<u8>,
}
struct HandlerFailure<'a> {
    cause: Rc<Cause<'a>>,
}
struct StoredFailure<'a> {
    reason: &'a str,
    cause: Rc<Cause<'a>>,
}

#[test]
fn a_composition_keeps_raw_handler_errors_separate_from_its_stored_typed_failure() {
    let visits = Cell::new(0);
    let input = Rc::new(Input {
        text: "prompt",
        visits: &visits,
    });
    let cause = Rc::new(Cause {
        message: "provider down",
        visits: &visits,
    });
    let call: ResilientCall<'_, Input<'_>, (), StoredFailure<'_>, CountBound, HandlerFailure<'_>> =
        ResilientCall::new(Config::default());
    let initial = call.init();
    let mut started = call
        .attempt(&initial, "plan", CallValue::shared(input.clone()), 0.0)
        .unwrap();
    let cmd = started.commands.pop().unwrap();
    assert!(matches!(&cmd.input().input,CallValue::Shared(value)if Rc::ptr_eq(value,&input)));
    let message = call.run.err(
        cmd,
        RunError::port_rejected(HandlerFailure {
            cause: cause.clone(),
        }),
        Some(1.0),
    );
    let Settlement::Err(Failure::Declared(raw)) = message.outcome() else {
        panic!("declared handler failure")
    };
    assert!(Rc::ptr_eq(&raw.details.cause, &cause));
    let typed = StoredFailure {
        reason: raw.details.cause.message,
        cause: raw.details.cause.clone(),
    };
    let settled = call
        .settle(
            &started.state,
            SettleInput::err("plan", CallFailure::external(typed), 1.0),
        )
        .unwrap();
    let Some(CallPhase::Failed { error }) = settled.call.call("plan") else {
        panic!("terminal typed failure")
    };
    let CallFailure::External(error) = error.as_ref() else {
        panic!("composition-owned failure")
    };
    assert_eq!(error.reason, "provider down");
    assert!(Rc::ptr_eq(&error.cause, &cause));
    visits.set(4);
    assert_eq!(error.cause.visits.get(), 4);
    assert_eq!(input.visits.get(), 4);
    assert_eq!(input.text, "prompt");
    assert!(initial.call("plan").is_none());
    assert!(settled.commands.is_empty());
}
