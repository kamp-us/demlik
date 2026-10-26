use std::{cell::Cell, marker::PhantomData, rc::Rc};

use demlik_tea::{
    PlainData, Tagged,
    command::{
        CmdDef, CommandContractError, CommandEdge, CommandFamily, CommandRecord, CommandSpec,
        Failure, Issue, Outcome, SchemaError, Settlement,
    },
    resilience::resilient_call::{CallValue, RunError, RunInput, RunSpec},
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
fn cause<'a>(label: &'a str, visits: &'a Cell<u32>) -> Rc<Opaque<'a>> {
    Rc::new(Opaque {
        label,
        visits,
        source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
    })
}

#[test]
fn classified_closed_failure_keeps_opaque_borrowed_cause_and_command_owners() {
    let label = String::from("caller owned");
    let visits = Cell::new(0);
    let cause = cause(&label, &visits);
    let payload = Rc::new(Cell::new(1));
    for error in [
        RunError::port_rejected(Rc::clone(&cause)),
        RunError::deadline_exceeded(Rc::clone(&cause)),
    ] {
        let command = {
            let definition = CmdDef::<RunSpec<Cell<u32>, (), Rc<Opaque<'_>>>>::named("invoice");
            definition
                .from_record(RunInput {
                    key: "collect".into(),
                    input: CallValue::shared(Rc::clone(&payload)),
                })
                .with_error_classifier(run_error_view)
        };
        let expected_tag = error.kind.tag();
        assert_eq!(command.tag(), "invoice");
        assert!(command.is_defined());
        let CallValue::Shared(original) = &command.cmd().input().input else {
            panic!("typed payload missing");
        };
        assert!(Rc::ptr_eq(original, &payload));
        let edge = CommandEdge::new(|| 17.25);
        let guard = command.dispatch_guard(&edge);
        fn require_send<T: Send>(_: &T) {}
        require_send(&guard);
        visits.set(7);
        payload.set(11);
        let messages = command.settle_in(Some(Outcome::err(error)), &edge).unwrap();
        let [message] = messages.as_slice() else {
            panic!("expected one failure");
        };
        guard.check(message).unwrap();
        assert_eq!(message.tag(), "invoice_err");
        assert_eq!(message.at(), Some(17.25.into()));
        let Settlement::Err(Failure::Declared(error)) = message.outcome() else {
            panic!("original failure missing");
        };
        assert_eq!(error.tag(), expected_tag);
        assert!(Rc::ptr_eq(&cause, &error.details));
        assert_eq!(error.details.label, "caller owned");
        assert!(std::ptr::eq(error.details.visits, &visits));
        assert_eq!(error.details.visits.get(), 7);
        assert_eq!(
            error.details.source.kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let CallValue::Shared(original) = &message.cmd().input().input else {
            panic!("original command missing");
        };
        assert!(Rc::ptr_eq(original, &payload));
        assert_eq!(original.get(), 11);
    }
}

fn undeclared_view<E>(_: &RunError<E>) -> Result<PlainData, CommandContractError> {
    Ok(PlainData::Object(
        [
            ("_tag".into(), PlainData::String("other_family".into())),
            ("detail".into(), PlainData::Number(42.0)),
        ]
        .into_iter()
        .collect(),
    ))
}
#[test]
fn classifier_view_is_checked_and_preserved_as_undeclared_failure_data() {
    let label = String::from("opaque rejected");
    let visits = Cell::new(0);
    let cause = cause(&label, &visits);
    let cmd = CmdDef::<RunSpec<(), (), Rc<Opaque<'_>>>>::named("checked")
        .from_record(RunInput {
            key: "k".into(),
            input: CallValue::value(()),
        })
        .with_error_classifier(undeclared_view);
    let result = cmd.settle_in(
        Some(Outcome::err(RunError::port_rejected(Rc::clone(&cause)))),
        &CommandEdge::new(|| 4.0),
    );
    let Err(CommandContractError::UndeclaredFailure {
        cmd_type,
        failure,
        declared,
    }) = result
    else {
        panic!("undeclared classifier view reached the model");
    };
    assert_eq!(cmd_type, "checked");
    assert_eq!(
        demlik_tea::structural_hash(&failure),
        r#"{"_tag":"other_family","detail":42}"#
    );
    assert_eq!(declared, ["port_rejected", "deadline_exceeded"]);
}

struct Input<'a> {
    label: &'a str,
}
impl CommandRecord for Input<'_> {}
struct Parsed<'a>(PhantomData<&'a ()>);
impl<'a> CommandSpec for Parsed<'a> {
    type Input = Input<'a>;
    type RawOutput = &'a str;
    type Output = &'a str;
    type Error = RunError<Rc<Opaque<'a>>>;
    const NAME: &'static str = "parsed";
    const ERROR_TAGS: &'static [&'static str] = &["port_rejected", "deadline_exceeded"];
    fn parse_input(_: serde_json::Value) -> Result<Self::Input, SchemaError> {
        Err(SchemaError::Issues(vec![Issue::new("", "borrowed input")]))
    }
    fn parse_output(value: &'a str) -> Result<&'a str, SchemaError> {
        match value.trim() {
            "" => Err(SchemaError::Issues(vec![Issue::new("body", "nonempty")])),
            "async" => Err(SchemaError::Async),
            value => Ok(value),
        }
    }
}
#[test]
fn classified_success_uses_the_canonical_transform_and_malformed_output_paths() {
    let def = CmdDef::<Parsed<'_>>::named("transformed");
    let edge = CommandEdge::new(|| 8.5);
    for (value, malformed) in [(" answer ", false), (" ", true)] {
        let command = def
            .from_record(Input { label: "retained" })
            .with_error_classifier(run_error_view);
        let messages = command.settle_in(Some(Outcome::ok(value)), &edge).unwrap();
        assert_eq!(messages[0].cmd().input().label, "retained");
        assert_eq!(messages[0].at(), Some(8.5.into()));
        if malformed {
            let Settlement::Err(Failure::Malformed(error)) = messages[0].outcome() else {
                panic!("malformed output escaped");
            };
            assert_eq!(error.issues, [Issue::new("body", "nonempty")]);
        } else {
            assert!(matches!(messages[0].outcome(), Settlement::Ok("answer")));
        }
    }
    let error = def
        .from_record(Input { label: "retained" })
        .with_error_classifier(run_error_view)
        .settle_in(Some(Outcome::ok("async")), &edge);
    assert!(
        matches!(error, Err(CommandContractError::AsyncSchema { location }) if location == "the \"transformed\" Cmd's ok schema")
    );
}

#[test]
fn classified_messages_need_the_same_engine_provenance_and_replay_stays_unminted() {
    let label = String::from("retained");
    let visits = Cell::new(0);
    let cause = cause(&label, &visits);
    let def = CmdDef::<Parsed<'_>>::new();
    let edge = CommandEdge::new(|| 9.0);
    let foreign = CommandEdge::new(|| 9.0);
    let command = || {
        def.from_record(Input { label: &label })
            .with_error_classifier(run_error_view)
    };
    let guard = command().dispatch_guard(&edge);
    let messages = command().settle_in(Some(Outcome::ok("ok")), &edge).unwrap();
    guard.check(&messages[0]).unwrap();
    let messages = command()
        .settle_in(Some(Outcome::ok("ok")), &foreign)
        .unwrap();
    assert!(matches!(
        guard.check(&messages[0]),
        Err(CommandContractError::Outcome { .. })
    ));
    let messages = command().settle(Some(Outcome::ok("ok")), 9.0).unwrap();
    assert!(matches!(
        guard.check(&messages[0]),
        Err(CommandContractError::Outcome { .. })
    ));
    let replay = def.err(
        command().into_cmd(),
        RunError::port_rejected(cause),
        Some(9.0),
    );
    assert!(matches!(
        guard.check(&replay),
        Err(CommandContractError::Outcome { .. })
    ));
}

#[test]
fn no_completion_and_success_do_not_classify_errors_and_none_does_not_read_clock() {
    fn unexpected<E>(_: &RunError<E>) -> Result<PlainData, CommandContractError> {
        panic!("classifier ran without error");
    }
    let def = CmdDef::<RunSpec<(), (), ()>>::new();
    let command = || {
        def.from_record(RunInput {
            key: "k".into(),
            input: CallValue::value(()),
        })
        .with_error_classifier(unexpected)
    };
    let edge = CommandEdge::new(|| panic!("clock read for no completion"));
    assert!(command().settle_in(None, &edge).unwrap().is_empty());
    assert_eq!(
        command()
            .settle_in(
                Some(Outcome::ok(CallValue::value(()))),
                &CommandEdge::new(|| 1.0)
            )
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn classifier_failure_is_not_rewritten_as_a_declared_settlement() {
    fn refused<E>(_: &RunError<E>) -> Result<PlainData, CommandContractError> {
        Err(CommandContractError::Serialization {
            message: "caller contract view refused".into(),
        })
    }
    let command = CmdDef::<RunSpec<(), (), ()>>::new()
        .from_record(RunInput {
            key: "k".into(),
            input: CallValue::value(()),
        })
        .with_error_classifier(refused);
    assert!(
        matches!(command.settle_in(Some(Outcome::err(RunError::port_rejected(()))), &CommandEdge::new(|| 1.0)), Err(CommandContractError::Serialization { message }) if message == "caller contract view refused")
    );
}

#[test]
fn classified_input_wire_is_unchanged_and_replay_restore_needs_explicit_adaptation() {
    let def = CmdDef::<RunSpec<PlainData, PlainData, PlainData>>::named("wire");
    let original = def.from_record(RunInput {
        key: "k".into(),
        input: CallValue::value(PlainData::Null),
    });
    let bytes = serde_json::to_string(&original).unwrap();
    let classified = original.with_error_classifier(run_error_view);
    assert_eq!(serde_json::to_string(&classified).unwrap(), bytes);
    let restored = def
        .restore_command(serde_json::from_str(&bytes).unwrap())
        .unwrap()
        .with_error_classifier(run_error_view);
    let edge = CommandEdge::new(|| 7.0);
    let guard = restored.dispatch_guard(&edge);
    let messages = restored
        .settle_in(Some(Outcome::ok(CallValue::value(PlainData::Null))), &edge)
        .unwrap();
    guard.check(&messages[0]).unwrap();
    assert_eq!(
        serde_json::to_string(&messages[0]).unwrap(),
        r#"{"type":"wire_ok","cmd":{"key":"k","input":null,"type":"wire"},"value":null,"at":7}"#
    );
}
