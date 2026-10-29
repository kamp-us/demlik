use demlik_tea::{
    command::Outcome,
    data::JsText,
    describe_error::{ErrorView, describe_error},
    llm_call::{
        CauseField, Config, LlmCall, LlmCause, Purpose as LlmPurpose, Request, Schema, State,
        lift_llm_call,
    },
    resilience::resilient_call::{CallFailure, CallPhase, CallValue},
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
};
use std::{cell::Cell, rc::Rc};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Purpose {
    Plan,
    Report,
}
impl LlmPurpose for Purpose {
    fn key(&self) -> JsText {
        match self {
            Self::Plan => "plan".into(),
            Self::Report => "report".into(),
        }
    }
}
struct Prompt {
    local: Rc<()>,
    text: &'static str,
}
struct Plan {
    local: Rc<()>,
    steps: Vec<&'static str>,
}
struct ParseFailure {
    message: JsText,
    local: Rc<()>,
}
enum Raw {
    Plan(Rc<Plan>),
    Wrong,
}
enum Output {
    Plan(Rc<Plan>),
}
struct PlanSchema {
    visits: Cell<usize>,
    metadata: Rc<()>,
    failure: Rc<ParseFailure>,
}
impl Schema for PlanSchema {
    type Raw = Raw;
    type Output = Output;
    type Error = ParseFailure;
    fn parse(&self, raw: Raw) -> Result<Output, CallValue<ParseFailure>> {
        self.visits.set(self.visits.get() + 1);
        match raw {
            Raw::Plan(plan) => Ok(Output::Plan(plan)),
            Raw::Wrong => Err(CallValue::shared(self.failure.clone())),
        }
    }
}
fn describe(error: &ParseFailure) -> Result<JsText, demlik_tea::js_record::JsAccessError> {
    describe_error(ErrorView::ErrorMessage(&error.message))
}

#[test]
fn decode_uses_the_actual_configured_schema_and_keeps_opaque_request_and_output_handles() {
    let failure = Rc::new(ParseFailure {
        message: "plan rejected".into(),
        local: Rc::new(()),
    });
    let schema = Rc::new(PlanSchema {
        visits: Cell::new(0),
        metadata: Rc::new(()),
        failure,
    });
    let selected = schema.clone();
    let llm: LlmCall<'_, Purpose, Prompt, PlanSchema> =
        LlmCall::new(Config::new(move |_| selected.clone()), describe);
    let actual = llm.schema_of(&Purpose::Plan);
    assert!(Rc::ptr_eq(&actual, &schema));
    assert!(Rc::ptr_eq(&actual.metadata, &schema.metadata));
    let input = Rc::new(Request::new(
        Purpose::Plan,
        None,
        Prompt {
            local: Rc::new(()),
            text: "make a plan",
        },
    ));
    let started = llm.attempt(&llm.init(), input.clone(), 0.0).unwrap();
    assert!(
        matches!(&started.commands[0].input().input,CallValue::Shared(request)if Rc::ptr_eq(request,&input))
    );
    let plan = Rc::new(Plan {
        local: Rc::new(()),
        steps: vec!["read", "write"],
    });
    let outcome = llm
        .decode(&started.commands[0], Raw::Plan(plan.clone()))
        .unwrap();
    let Outcome::Ok {
        value: CallValue::Shared(parsed),
    } = outcome
    else {
        panic!("structured success")
    };
    assert_eq!(parsed.key.as_utf8(), Some("plan"));
    assert!(parsed.purpose == Purpose::Plan);
    let Output::Plan(output) = &parsed.output;
    assert!(Rc::ptr_eq(output, &plan));
    assert!(Rc::ptr_eq(&output.local, &plan.local));
    assert_eq!(output.steps, ["read", "write"]);
    assert_eq!(schema.visits.get(), 1);
    assert_eq!(input.payload.text, "make a plan");
    assert_eq!(Rc::strong_count(&input.payload.local), 1);
}

#[test]
fn a_schema_rejection_retains_the_original_cause_and_stores_a_typed_failure() {
    let failure = Rc::new(ParseFailure {
        message: "schema rejected".into(),
        local: Rc::new(()),
    });
    let schema = Rc::new(PlanSchema {
        visits: Cell::new(0),
        metadata: Rc::new(()),
        failure: failure.clone(),
    });
    let llm: LlmCall<'_, Purpose, Prompt, PlanSchema> =
        LlmCall::new(Config::new(move |_| schema.clone()), describe);
    let input = Rc::new(Request::new(
        Purpose::Report,
        Some("local-model".into()),
        Prompt {
            local: Rc::new(()),
            text: "report",
        },
    ));
    let mut started = llm
        .attempt_keyed(&llm.init(), "report:7", input, 4.0)
        .unwrap();
    let cmd = started.commands.pop().unwrap();
    let outcome = llm.decode(&cmd, Raw::Wrong).unwrap();
    let Outcome::Err { error } = outcome else {
        panic!("declared rejection")
    };
    assert!(
        matches!(error.details.cause(),CauseField::Own(CallValue::Shared(actual))if Rc::ptr_eq(actual,&failure))
    );
    let msg = llm.run().err(cmd, error, Some(5.0));
    let parsed = llm.err_of(&msg).unwrap();
    assert_eq!(parsed.key.as_utf8(), Some("report:7"));
    assert!(parsed.purpose == Purpose::Report);
    assert_eq!(parsed.reason.as_utf8(), Some("schema rejected"));
    assert!(
        matches!(&parsed.error,LlmCause::Value(actual)if Rc::ptr_eq(actual,&failure)&&Rc::ptr_eq(&actual.local,&failure.local))
    );
    let failed = llm.fail(&started.state, &msg).unwrap();
    let Some(CallPhase::Failed { error }) = failed.state.call("report:7") else {
        panic!("failed call")
    };
    let CallFailure::External(typed) = error.as_ref() else {
        panic!("typed LlmErr")
    };
    assert_eq!(typed.reason.as_utf8(), Some("schema rejected"));
    assert!(matches!(&typed.error,LlmCause::Value(actual)if Rc::ptr_eq(actual,&failure)));
    assert!(failed.commands.is_empty());
    assert!(matches!(
        started.state.call("report:7"),
        Some(CallPhase::Running { .. })
    ));
}

#[test]
fn a_provider_failure_retries_the_same_request_then_settles_and_lifts_the_parsed_success() {
    let failure = Rc::new(ParseFailure {
        message: "provider unavailable".into(),
        local: Rc::new(()),
    });
    let schema = Rc::new(PlanSchema {
        visits: Cell::new(0),
        metadata: Rc::new(()),
        failure: failure.clone(),
    });
    let draws = Rc::new(Cell::new(0));
    let sampled = draws.clone();
    let config = Config::new(move |_| schema.clone()).with_retry(RetryPolicy {
        curve: BackoffCurve {
            base_ms: 100.0,
            factor: 2.0,
            cap_ms: 10_000.0,
            jitter: Jitter::Full,
        },
        budget: CountBound { max_attempts: 3.0 },
    });
    let llm: LlmCall<'_, Purpose, Prompt, PlanSchema> =
        LlmCall::new(config, describe).with_rng(move || {
            sampled.set(sampled.get() + 1);
            0.0
        });
    let input = Rc::new(Request::new(
        Purpose::Plan,
        None,
        Prompt {
            local: Rc::new(()),
            text: "plan",
        },
    ));
    let mut started = llm.attempt(&llm.init(), input.clone(), 50.0).unwrap();
    let rejected = llm.rejected(CallValue::shared(failure));
    let Outcome::Err { error } = rejected else {
        panic!("port rejection")
    };
    let msg = llm
        .run()
        .err(started.commands.pop().unwrap(), error, Some(50.0));
    let waiting = llm.fail(&started.state, &msg).unwrap();
    assert!(waiting.commands.is_empty());
    let deadlines = llm.deadlines(&waiting.state);
    assert_eq!(deadlines.len(), 1);
    assert_eq!(deadlines[0].id.as_utf8(), Some("resilient:retry:plan"));
    assert_eq!(deadlines[0].at_ms, 50.0);
    let timer = llm.timer(&waiting.state).unwrap();
    assert_eq!(timer.ms, 0.0);
    assert_eq!(draws.get(), 1);
    let mut retried = llm.on_timer(&waiting.state, &timer.msg).unwrap();
    assert_eq!(retried.commands.len(), 1);
    assert!(
        matches!(&retried.commands[0].input().input,CallValue::Shared(request)if Rc::ptr_eq(request,&input))
    );
    let plan = Rc::new(Plan {
        local: Rc::new(()),
        steps: vec!["done"],
    });
    let cmd = retried.commands.pop().unwrap();
    let Outcome::Ok { value } = llm.decode(&cmd, Raw::Plan(plan.clone())).unwrap() else {
        panic!("parsed success")
    };
    let msg = llm.run().ok(cmd, value, Some(51.0));
    let completed = llm.succeed(&retried.state, &msg).unwrap();
    assert!(completed.commands.is_empty());
    assert!(llm.timer(&completed.state).is_none());
    assert!(llm.deadlines(&completed.state).is_empty());
    assert_eq!(completed.state.snapshot().retry.own_entries().count(), 0);
    struct Host {
        resilience: State<Purpose, Prompt, Output, ParseFailure>,
        opaque: Rc<()>,
    }
    let opaque = Rc::new(());
    let host = Host {
        resilience: waiting.state,
        opaque: opaque.clone(),
    };
    let lifted = lift_llm_call(host, completed, |mut host, resilience| {
        host.resilience = resilience;
        host
    });
    assert!(Rc::ptr_eq(&lifted.state.opaque, &opaque));
    let Some(CallPhase::Succeeded {
        result: CallValue::Shared(parsed),
    }) = lifted.state.resilience.call("plan")
    else {
        panic!("succeeded plan")
    };
    let Output::Plan(output) = &parsed.output;
    assert!(Rc::ptr_eq(output, &plan));
    assert_eq!(output.steps, ["done"]);
}

#[test]
fn rejection_wire_boundary_preserves_absence_null_and_inherited_cause_without_double_owners() {
    use demlik_tea::{PlainData, llm_call::Rejected};
    use indexmap::IndexMap;
    let mut fields = IndexMap::new();
    fields.insert("cause".into(), PlainData::Null);
    let refused = Rejected::<PlainData>::from_field(CauseField::Missing, fields)
        .err()
        .expect("reserved cause refused");
    assert_eq!(refused.field.as_utf8(), Some("cause"));
    let own = Rejected::<PlainData>::new(CallValue::Undefined);
    assert_eq!(serde_json::to_string(&own).unwrap(), "{}");
    let inherited = Rejected::from_field(
        CauseField::Inherited(CallValue::value(PlainData::Null)),
        IndexMap::new(),
    )
    .unwrap();
    assert_eq!(serde_json::to_string(&inherited).unwrap(), "{}");
    let missing: Rejected<PlainData> = serde_json::from_str("{}").unwrap();
    assert!(matches!(missing.cause(), CauseField::Missing));
    let null: Rejected<PlainData> = serde_json::from_str("{\"cause\":null}").unwrap();
    assert!(
        matches!(null.cause(),CauseField::Own(CallValue::Shared(value))if matches!(value.as_ref(),PlainData::Null))
    );
    assert_eq!(serde_json::to_string(&null).unwrap(), "{\"cause\":null}");
}

#[test]
fn restored_payload_and_output_absence_uses_the_owned_decoder_without_default_bounds() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        llm_call::LlmOk,
    };
    let missing: Request<String, PlainData> =
        serde_json::from_str(r#"{"purpose":"plan","model":null}"#).unwrap();
    assert!(!missing.has_payload());
    assert!(matches!(missing.payload, PlainData::Undefined));
    assert_eq!(
        stringify_json(&plain_data(&missing).unwrap()).unwrap(),
        r#"{"purpose":"plan","model":null}"#
    );
    let present: Request<String, PlainData> =
        serde_json::from_str(r#"{"purpose":"plan","model":null,"payload":null}"#).unwrap();
    assert!(present.has_payload());
    assert!(matches!(present.payload, PlainData::Null));
    assert!(
        serde_json::from_str::<Request<String, String>>(r#"{"purpose":"plan","model":null}"#)
            .is_err()
    );
    let parsed: LlmOk<String, PlainData> =
        serde_json::from_str(r#"{"key":"plan","purpose":"plan"}"#).unwrap();
    assert!(matches!(parsed.output, PlainData::Undefined));
    assert!(
        serde_json::from_str::<LlmOk<String, String>>(r#"{"key":"plan","purpose":"plan"}"#)
            .is_err()
    );
}

#[test]
fn caller_owned_live_retry_budget_is_retained_and_read_only_when_provider_fails() {
    use demlik_tea::retry_backoff::Budget;
    use std::cell::RefCell;
    struct LiveBudget<'a> {
        attempts: Rc<Cell<f64>>,
        elapsed: &'a Cell<Option<f64>>,
        reads: &'a RefCell<Vec<&'static str>>,
    }
    impl Budget for LiveBudget<'_> {
        fn max_attempts(&self) -> Option<f64> {
            self.reads.borrow_mut().push("attempts");
            Some(self.attempts.get())
        }
        fn max_elapsed_ms(&self) -> Option<f64> {
            self.reads.borrow_mut().push("elapsed");
            self.elapsed.get()
        }
    }
    for change_attempts in [true, false] {
        let attempts = Rc::new(Cell::new(3.0));
        let elapsed = Cell::new(Some(100.0));
        let reads = RefCell::new(Vec::new());
        let selections = Cell::new(0);
        let failure = Rc::new(ParseFailure {
            message: "provider unavailable".into(),
            local: Rc::new(()),
        });
        let schema = Rc::new(PlanSchema {
            visits: Cell::new(0),
            metadata: Rc::new(()),
            failure: Rc::clone(&failure),
        });
        let llm: LlmCall<'_, Purpose, Prompt, PlanSchema, LiveBudget<'_>> = LlmCall::new(
            Config::new(|_| {
                selections.set(selections.get() + 1);
                Rc::clone(&schema)
            })
            .with_retry(RetryPolicy {
                curve: BackoffCurve {
                    base_ms: 5.0,
                    factor: 1.0,
                    cap_ms: 5.0,
                    jitter: Jitter::None,
                },
                budget: LiveBudget {
                    attempts: Rc::clone(&attempts),
                    elapsed: &elapsed,
                    reads: &reads,
                },
            }),
            describe,
        );
        let construction_reads = reads.borrow().clone();
        if change_attempts {
            attempts.set(1.0);
        } else {
            elapsed.set(Some(0.0));
        }
        let input = Rc::new(Request::new(
            Purpose::Plan,
            None,
            Prompt {
                local: Rc::new(()),
                text: "plan",
            },
        ));
        let mut started = llm.attempt(&llm.init(), Rc::clone(&input), 50.0).unwrap();
        let Outcome::Err { error } = llm.rejected(CallValue::Shared(Rc::clone(&failure))) else {
            panic!("provider rejection")
        };
        let message = llm
            .run()
            .err(started.commands.pop().unwrap(), error, Some(50.0));
        let failed = llm.fail(&started.state, &message).unwrap();
        assert!(
            llm.timer(&failed.state).is_none(),
            "the caller's changed live bound must stop the first rejection"
        );
        assert!(matches!(
            failed.state.call("plan"),
            Some(CallPhase::Failed { .. })
        ));
        assert!(
            construction_reads.is_empty(),
            "construction must not read either bound"
        );
        assert_eq!(
            Rc::strong_count(&attempts),
            2,
            "LlmCall retains the original budget owner"
        );
        assert_eq!(selections.get(), 0);
        assert_eq!(schema.visits.get(), 0);
        assert_eq!(
            &*reads.borrow(),
            if change_attempts {
                &["attempts"][..]
            } else {
                &["attempts", "elapsed"][..]
            },
            "getters keep their original failure-time short-circuit order"
        );
        drop(llm);
        assert_eq!(Rc::strong_count(&attempts), 1);
    }
}
