//! A typed contract view preserves a borrowed opaque cause without a wire codec.
use std::{cell::Cell, rc::Rc};

use demlik_tea::{
    PlainData, Tagged,
    command::{CommandContractError, CommandEdge, CommandFamily, Failure, Outcome, Settlement},
    resilience::resilient_call::{CallValue, RunError, RunInput, run_cmd_def},
};

struct Opaque<'a> {
    label: &'a str,
    visits: &'a Cell<u32>,
    source: std::io::Error,
}
fn run_error_view<E>(error: &RunError<E>) -> Result<PlainData, CommandContractError> {
    Ok(PlainData::Object(
        [("_tag".into(), PlainData::String(error.tag().into()))]
            .into_iter()
            .collect(),
    ))
}
fn main() {
    let label = String::from("original borrowed cause");
    let visits = Cell::new(3);
    let cause = Rc::new(Opaque {
        label: &label,
        visits: &visits,
        source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
    });
    let cmd = run_cmd_def::<_, (), _>("opaque")
        .from_record(RunInput {
            key: "invoice".into(),
            input: CallValue::value(label.as_str()),
        })
        .with_error_classifier(run_error_view);
    assert_eq!(
        serde_json::to_string(&cmd).unwrap(),
        r#"{"key":"invoice","input":"original borrowed cause","type":"opaque_run"}"#
    );
    let edge = CommandEdge::new(|| 17.25);
    let guard = cmd.dispatch_guard(&edge);
    let messages = cmd
        .settle_in(
            Some(Outcome::err(RunError::port_rejected(Rc::clone(&cause)))),
            &edge,
        )
        .unwrap();
    guard.check(&messages[0]).unwrap();
    let Settlement::Err(Failure::Declared(error)) = messages[0].outcome() else {
        panic!("opaque failure was replaced");
    };
    assert!(Rc::ptr_eq(&cause, &error.details));
    assert_eq!(error.details.label, label);
    assert!(std::ptr::eq(error.details.visits, &visits));
    assert_eq!(
        error.details.source.kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(messages[0].at(), Some(17.25.into()));
}
