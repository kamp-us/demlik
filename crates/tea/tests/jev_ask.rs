use demlik_tea::{
    command::Outcome,
    data::{plain_data, stringify_json},
    jev::{
        JevText, Questions,
        ask::{JevAsk, JevAskConfig},
        reply::{JevAskErr, JevRejected},
    },
    resilience::resilient_call::{CallFailure, CallPhase, CallValue, RunError},
};
use std::{cell::Cell, rc::Rc};

#[test]
fn canonical_clone_retains_borrowed_opaque_payload_without_adding_bounds() {
    struct Opaque<'a>(&'a Cell<u8>);
    let cell = Cell::new(0);
    let original = Rc::new(Opaque(&cell));
    let failure = RunError::port_rejected(Rc::clone(&original));
    let copied = failure.clone();
    assert!(Rc::ptr_eq(&original, &copied.details));
    cell.set(9);
    assert_eq!(copied.details.0.get(), 9);
}

#[test]
fn legacy_construction_and_decoder_refusals_keep_their_boundary() {
    let details = demlik_tea::data::decode_json(r#"{"cause":"original"}"#).unwrap();
    let failure = RunError::port_rejected(details);
    assert_eq!(
        stringify_json(&plain_data(&failure).unwrap()).unwrap(),
        r#"{"cause":"original","_tag":"port_rejected"}"#
    );
    for raw in [r#"{"_tag":"unknown"}"#, r#"{"_tag":null}"#, "{}", "[]"] {
        assert!(serde_json::from_str::<RunError<demlik_tea::PlainData>>(raw).is_err());
    }
    assert!(plain_data(&RunError::port_rejected(5_u8)).is_err());
}

#[test]
fn a_terminal_settlement_retains_the_live_error_and_request_with_borrowed_rng() {
    let samples = Cell::new(0);
    let questions = Rc::new(Questions::new());
    let ask = JevAsk::new(JevAskConfig::new(Rc::clone(&questions))).with_rng(|| {
        samples.set(samples.get() + 1);
        0.
    });
    let content = Rc::new(JevText::Text("invoice".into()));
    let mut step = ask
        .attempt(&ask.init(), "invoice", Rc::clone(&content), 1.)
        .unwrap();
    let command = step.commands.pop().unwrap();
    let CallValue::Shared(request) = &command.input().input else {
        panic!("request")
    };
    assert!(Rc::ptr_eq(&request.state, &content));
    assert!(Rc::ptr_eq(&request.questions, &questions));
    let cause = Rc::new(JevAskErr::HttpTerminal {
        status: 401.0.into(),
    });
    let canonical = JevRejected::new(Rc::clone(&cause)).into_run_error();
    let message = ask
        .run()
        .settle(command, Some(Outcome::err(canonical)), 13.)
        .unwrap()
        .unwrap();
    let failed = ask.fail(&step.state, &message).unwrap();
    let Some(CallPhase::Failed { error }) = failed.state.call("invoice") else {
        panic!("terminal")
    };
    assert!(matches!(error.as_ref(),CallFailure::External(e)if Rc::ptr_eq(e,&cause)));
    assert_eq!(samples.get(), 0);
    assert!(failed.commands.is_empty());
}
