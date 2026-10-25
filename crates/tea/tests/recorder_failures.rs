use demlik_tea::{
    Machine, PlainData, Sub, Tagged, Update,
    data::decode_json,
    persistence::{
        recorder::{
            JsonlError, JsonlWriteError, Recorder, RecorderOptions, Trace, parse_jsonl_with,
        },
        trace_replay::{ReplayError, replay_trace_with},
    },
};
use std::{cell::Cell, fmt, rc::Rc, sync::Arc};

#[derive(Debug)]
struct Failure {
    reason: &'static str,
    cause: Rc<Cell<u32>>,
}
impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.reason)
    }
}
impl std::error::Error for Failure {}
struct State;
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
struct Msg;
impl Tagged for Msg {
    fn tag(&self) -> &str {
        "event"
    }
}

#[test]
fn boundary_codecs_keep_typed_failure_identity_raw_data_and_physical_line() {
    let cause = Rc::new(Cell::new(9));
    let rec = Recorder::<State, Msg>::new(RecorderOptions::default());
    rec.record_boot(Arc::new(State));
    let result = rec.to_jsonl_with(
        |_| {
            Err(Failure {
                reason: "state codec refused",
                cause: cause.clone(),
            })
        },
        |_| Ok(PlainData::Null),
    );
    let Err(JsonlWriteError::Codec(error)) = result else {
        panic!("typed codec failure")
    };
    assert!(Rc::ptr_eq(&error.cause, &cause));
    assert_eq!(error.reason, "state codec refused");
    let parsed = parse_jsonl_with::<State, Msg, Failure>(
        "\n{\"kind\":\"boot\",\"state\":{\"reason\":\"bad\",\"details\":[1,2]}}",
        |_| {
            Err(Failure {
                reason: "restore codec refused",
                cause: cause.clone(),
            })
        },
        |_| Ok(Msg),
    );
    let Err(error) = parsed else {
        panic!("typed restore refusal")
    };
    assert!(std::error::Error::source(&error).is_some());
    let JsonlError::Codec {
        line,
        field,
        value,
        cause: error,
    } = error
    else {
        panic!("codec variant")
    };
    assert_eq!((line, field), (2, "state"));
    assert!(demlik_tea::persistence::trace_replay::deep_equal(
        &value,
        &decode_json(r#"{"reason":"bad","details":[1,2]}"#).unwrap(),
    ));
    assert!(Rc::ptr_eq(&error.cause, &cause));
    cause.set(10);
    assert_eq!(error.cause.get(), 10);
}

#[test]
fn cold_replay_keeps_typed_comparison_failures_and_refuses_a_missing_update_cell() {
    let machine: Machine<'_, State, Msg, (), Sub> = Machine {
        init: Box::new(|_, _| panic!("replay cannot init")),
        update: Update::RawReducer(Default::default()),
        subscriptions: demlik_tea::core::subscriptions(|_| panic!("replay cannot select subs")),
    };
    let cause = Rc::new(Cell::new(12));
    let trace = Trace {
        loaded: Some(Arc::new(State)),
        msgs: vec![],
        final_state: Arc::new(State),
        steps: None,
    };
    let result = replay_trace_with(&machine, &trace, |_, _| {
        Err::<Option<()>, _>(Failure {
            reason: "comparator refused",
            cause: cause.clone(),
        })
    });
    let Err(ReplayError::Comparison(error)) = result else {
        panic!("comparison refusal")
    };
    assert_eq!(error.reason, "comparator refused");
    assert!(Rc::ptr_eq(&error.cause, &cause));
    let trace = Trace {
        msgs: vec![Arc::new(Msg)],
        ..trace
    };
    let result = replay_trace_with(&machine, &trace, |_, _| -> Result<Option<()>, Failure> {
        panic!("comparison cannot run after an unhandled message")
    });
    let Err(ReplayError::NoCell(error)) = result else {
        panic!("missing cell refusal")
    };
    assert_eq!(error.name(), "NoCellError");
    assert_eq!(error.msg_type, "event");
    assert_eq!(error.state_name, "state");
    assert!(error.accepted_types.is_empty());
}
