use demlik_tea::{
    data::JsText,
    flow::reconciler::{Config, Phase, Reconciler},
    js_record::{JsAccessError, JsRead},
    paginate::paginated_walk::{PAGE_KEY, PageOk},
    resilience::{
        cache,
        resilient_call::{CallValue, RunCommand},
    },
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

struct Cursor<'a>(&'a str);
struct Actual<'a> {
    label: &'a str,
}
struct Desired<'a> {
    target: &'a str,
}
struct Change<'a> {
    key: &'a str,
    visits: Rc<Cell<u32>>,
}
struct Page<'a> {
    next: Option<Rc<Cursor<'a>>>,
    rows: Vec<Rc<Actual<'a>>>,
}
enum Command<'a> {
    Fetch(RunCommand<Cursor<'a>, Page<'a>, &'static str>),
    Apply(Rc<Change<'a>>),
}
impl<'a> From<RunCommand<Cursor<'a>, Page<'a>, &'static str>> for Command<'a> {
    fn from(value: RunCommand<Cursor<'a>, Page<'a>, &'static str>) -> Self {
        Self::Fetch(value)
    }
}
type Sync<'a> = Reconciler<
    'a,
    Actual<'a>,
    Desired<'a>,
    Page<'a>,
    Change<'a>,
    Cursor<'a>,
    &'static str,
    &'static str,
    Command<'a>,
>;

#[test]
fn opaque_borrowed_changes_wait_for_ack_and_replanning_uses_the_enabled_ledger() {
    let first_text = String::from("first");
    let second_text = String::from("second");
    let actual_text = String::from("actual");
    let desired_text = String::from("desired");
    let first_key = String::from("one");
    let second_key = String::from("two");
    let first = Rc::new(Cursor(first_text.as_str()));
    let second = Rc::new(Cursor(second_text.as_str()));
    let actual = Rc::new(Actual {
        label: actual_text.as_str(),
    });
    let desired = Rc::new(Desired {
        target: desired_text.as_str(),
    });
    let one = Rc::new(Change {
        key: first_key.as_str(),
        visits: Rc::new(Cell::new(0)),
    });
    let two = Rc::new(Change {
        key: second_key.as_str(),
        visits: Rc::new(Cell::new(0)),
    });
    let plan = Rc::new(vec![
        CallValue::shared(one.clone()),
        CallValue::shared(two.clone()),
    ]);
    let diff_count = Cell::new(0);
    let callbacks = RefCell::new(vec![]);
    let config = Config::with_id(
        desired.clone(),
        CallValue::shared(first.clone()),
        Rc::new(|page: &CallValue<Page<'_>>| {
            callbacks.borrow_mut().push("next");
            let CallValue::Shared(page) = page else {
                return Err("missing page");
            };
            Ok(page.next.clone())
        }),
        Rc::new(|page: &CallValue<Page<'_>>| {
            callbacks.borrow_mut().push("items");
            let CallValue::Shared(page) = page else {
                return Err("missing page");
            };
            Ok(page.rows.clone())
        }),
        Rc::new(|value: &Desired<'_>, rows: &Rc<Vec<Rc<Actual<'_>>>>| {
            callbacks.borrow_mut().push("diff");
            diff_count.set(diff_count.get() + 1);
            assert!(std::ptr::eq(value, desired.as_ref()));
            assert_eq!(value.target, "desired");
            assert_eq!(rows.len(), 2);
            assert!(rows.iter().all(|row| Rc::ptr_eq(row, &actual)));
            assert_eq!(rows[0].label, "actual");
            Ok(plan.clone())
        }),
        Rc::new(|change: &Rc<Change<'_>>| {
            callbacks.borrow_mut().push("apply");
            Ok(Command::Apply(change.clone()))
        }),
        Rc::new(|change: &CallValue<Change<'_>>| {
            callbacks.borrow_mut().push("id");
            let CallValue::Shared(change) = change else {
                return Err("missing change");
            };
            Ok(JsText::from(change.key))
        }),
    );
    let sync: Sync<'_> = Reconciler::new(config);
    let idle = sync.init();
    let started = sync.scan(&idle, 10.0).unwrap();
    assert_eq!(started.state.phase(), Phase::Scanning);
    assert!(
        started
            .state
            .ptr_eq(&sync.scan(&started.state, 999.0).unwrap().state)
    );
    let [Command::Fetch(command)] = started.commands.as_slice() else {
        panic!("first fetch")
    };
    assert!(
        matches!(&command.input().input, CallValue::Shared(value) if Rc::ptr_eq(value,&first) && value.0=="first")
    );
    let next = sync
        .page_ok(
            &started.state,
            PageOk::new(
                PAGE_KEY,
                CallValue::value(Page {
                    next: Some(second.clone()),
                    rows: vec![actual.clone()],
                }),
                11.0,
            ),
        )
        .unwrap();
    let [Command::Fetch(command)] = next.commands.as_slice() else {
        panic!("next fetch")
    };
    assert!(
        matches!(&command.input().input, CallValue::Shared(value) if Rc::ptr_eq(value,&second))
    );
    assert_eq!(next.state.actual().len(), 1);
    assert_eq!(diff_count.get(), 0);
    let applying = sync
        .page_ok(
            &next.state,
            PageOk::new(
                PAGE_KEY,
                CallValue::value(Page {
                    next: None,
                    rows: vec![actual.clone()],
                }),
                12.0,
            ),
        )
        .unwrap();
    assert_eq!(applying.state.phase(), Phase::Applying);
    assert!(Rc::ptr_eq(applying.state.plan(), &plan));
    assert_eq!(applying.state.applied_cursor().number(), Some(0.0));
    let [Command::Apply(change)] = applying.commands.as_slice() else {
        panic!("first apply")
    };
    assert!(Rc::ptr_eq(change, &one));
    assert_eq!(
        &*callbacks.borrow(),
        &["next", "items", "next", "items", "diff", "id", "apply"]
    );
    let again = sync.apply_next(&applying.state, 13.0).unwrap();
    assert_eq!(again.state.applied_cursor().number(), Some(0.0));
    assert!(matches!(&again.commands[0],Command::Apply(change) if Rc::ptr_eq(change,&one)));
    let acknowledged = sync
        .applied(&again.state, CallValue::shared(one.clone()), 14.0)
        .unwrap();
    assert_eq!(acknowledged.state.applied_cursor().number(), Some(1.0));
    assert!(matches!(&acknowledged.commands[0],Command::Apply(change) if Rc::ptr_eq(change,&two)));
    one.visits.set(9);
    let stored = cache::get_with_projection(acknowledged.state.applied(), "one", 15.0, |_| {
        Err(JsAccessError {
            name: "UnexpectedProjection",
            message: "opaque stored value must stay typed".into(),
        })
    })
    .unwrap();
    assert!(
        matches!(stored,Some(JsRead::Stored(CallValue::Shared(value))) if Rc::ptr_eq(value,&one) && value.visits.get()==9)
    );
    let replanned = sync
        .planned(&acknowledged.state, 16.0, Some(plan.clone()))
        .unwrap();
    assert_eq!(diff_count.get(), 1);
    assert_eq!(replanned.state.applied_cursor().number(), Some(1.0));
    assert!(matches!(&replanned.commands[0],Command::Apply(change) if Rc::ptr_eq(change,&two)));
    let done = sync
        .applied(&replanned.state, CallValue::shared(two), 17.0)
        .unwrap();
    assert!(sync.is_complete(&done.state));
    assert_eq!(done.state.applied_cursor().number(), Some(2.0));
    assert!(done.commands.is_empty());
    assert!(
        done.state.ptr_eq(
            &sync
                .applied(&done.state, CallValue::shared(one), 18.0)
                .unwrap()
                .state
        )
    );
    assert_eq!(idle.phase(), Phase::Idle);
    assert!(idle.actual().is_empty());
}

enum JsonCommand {
    Fetch(RunCommand<demlik_tea::PlainData, demlik_tea::PlainData, demlik_tea::PlainData>),
    Apply(Rc<demlik_tea::PlainData>),
}
impl From<RunCommand<demlik_tea::PlainData, demlik_tea::PlainData, demlik_tea::PlainData>>
    for JsonCommand
{
    fn from(
        value: RunCommand<demlik_tea::PlainData, demlik_tea::PlainData, demlik_tea::PlainData>,
    ) -> Self {
        Self::Fetch(value)
    }
}
type JsonSync = Reconciler<
    'static,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    &'static str,
    JsonCommand,
>;
type JsonConfig = Config<
    'static,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    demlik_tea::PlainData,
    &'static str,
    JsonCommand,
>;
fn json_config() -> JsonConfig {
    use demlik_tea::PlainData;
    Config::new(
        Rc::new(PlainData::Null),
        CallValue::value(PlainData::Number(0.0)),
        Rc::new(|_| Ok(None)),
        Rc::new(|_| Ok(vec![])),
        Rc::new(|_, _| Ok(Rc::new(vec![]))),
        Rc::new(|change| Ok(JsonCommand::Apply(change.clone()))),
    )
}
fn json_sync() -> JsonSync {
    Reconciler::new(json_config())
}

#[test]
fn default_json_identity_preserves_undefined_nonfinite_collisions_and_property_order() {
    use demlik_tea::{
        PlainData,
        data::{decode_json, plain_data, stringify_json},
    };
    let sync = json_sync();
    let started = sync.scan(&sync.init(), 0.0).unwrap();
    assert!(
        matches!(&started.commands[0], JsonCommand::Fetch(command) if command.input().key.as_utf8() == Some(PAGE_KEY))
    );
    let pending = sync
        .planned(
            &sync.init(),
            0.0,
            Some(Rc::new(vec![CallValue::value(PlainData::Bool(true))])),
        )
        .unwrap();
    let undefined = sync
        .applied(&pending.state, CallValue::Undefined, 1.0)
        .unwrap();
    assert_eq!(undefined.state.phase(), Phase::Done);
    assert_eq!(
        stringify_json(&plain_data(undefined.state.applied()).unwrap()).unwrap(),
        r#"{"entries":{"undefined":{"expiresAtMs":9007199254740992}}}"#
    );
    let nonfinite = sync
        .planned(
            &sync.init(),
            0.0,
            Some(Rc::new(vec![
                CallValue::value(PlainData::Number(f64::NAN)),
                CallValue::value(PlainData::Null),
            ])),
        )
        .unwrap();
    let ack = sync
        .applied(
            &nonfinite.state,
            CallValue::value(PlainData::Number(f64::NAN)),
            1.0,
        )
        .unwrap();
    assert_eq!(ack.state.phase(), Phase::Done);
    assert!(ack.commands.is_empty());
    assert_eq!(
        ack.state
            .applied()
            .entries
            .own_entries()
            .next()
            .unwrap()
            .0
            .as_utf8(),
        Some("null")
    );
    let a = Rc::new(decode_json(r#"{"a":1,"b":2}"#).unwrap());
    let b = Rc::new(decode_json(r#"{"b":2,"a":1}"#).unwrap());
    let plan = Rc::new(vec![
        CallValue::shared(a.clone()),
        CallValue::shared(b.clone()),
    ]);
    let applying = sync.planned(&sync.init(), 0.0, Some(plan)).unwrap();
    let next = sync
        .applied(&applying.state, CallValue::shared(a), 1.0)
        .unwrap();
    assert!(matches!(&next.commands[0],JsonCommand::Apply(value) if Rc::ptr_eq(value,&b)));
    let done = sync
        .applied(&next.state, CallValue::shared(b), 2.0)
        .unwrap();
    let keys = done
        .state
        .applied()
        .entries
        .own_entries()
        .map(|(key, _)| key.as_utf8().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(keys, vec![r#"{"a":1,"b":2}"#, r#"{"b":2,"a":1}"#]);
}

#[test]
fn a_stored_undefined_acknowledgment_does_not_mark_a_defined_change_as_applied() {
    use demlik_tea::PlainData;
    let sync: JsonSync = Reconciler::new(Config::with_id(
        Rc::new(PlainData::Null),
        CallValue::value(PlainData::Number(0.0)),
        Rc::new(|_| Ok(None)),
        Rc::new(|_| Ok(vec![])),
        Rc::new(|_, _| Ok(Rc::new(vec![]))),
        Rc::new(|change| Ok(JsonCommand::Apply(change.clone()))),
        Rc::new(|_| Ok("same".into())),
    ));
    let applying = sync
        .planned(
            &sync.init(),
            0.0,
            Some(Rc::new(vec![
                CallValue::value(PlainData::Bool(true)),
                CallValue::value(PlainData::Bool(false)),
            ])),
        )
        .unwrap();
    let next = sync
        .applied(&applying.state, CallValue::Undefined, 1.0)
        .unwrap();
    assert_eq!(next.state.phase(), Phase::Applying);
    assert_eq!(next.state.applied_cursor().number(), Some(1.0));
    assert!(
        matches!(next.commands.as_slice(), [JsonCommand::Apply(value)] if matches!(value.as_ref(), PlainData::Bool(false)))
    );
}

#[test]
fn scan_retries_and_deadlines_escalate_while_late_frames_keep_the_completed_lifecycle() {
    use demlik_tea::{
        PlainData, TimerDeps,
        paginate::paginated_walk::PageErr,
        resilience::{
            deadline::{DeadlineExceeded, deadline_exceeded},
            resilient_call::{CallFailure, CallPhase},
        },
        retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    };
    let mut config = json_config();
    config.retry = Some(RetryPolicy {
        curve: BackoffCurve {
            base_ms: 10.0,
            factor: 1.0,
            cap_ms: 10.0,
            jitter: Jitter::None,
        },
        budget: CountBound { max_attempts: 2.0 },
    });
    config.deadline = Some(demlik_tea::resilience::resilient_call::DeadlineConfig { ms: 30.0 });
    let sync: JsonSync = Reconciler::new(config);
    let started = sync.scan(&sync.init(), 0.0).unwrap();
    let retry = sync
        .page_err(
            &started.state,
            PageErr::new(
                PAGE_KEY,
                CallFailure::external(PlainData::String("down".into())),
                5.0,
            ),
        )
        .unwrap();
    assert_eq!(retry.state.phase(), Phase::Scanning);
    assert_eq!(retry.state.actual().len(), 0);
    assert!(
        retry
            .state
            .walk()
            .walk()
            .ptr_eq(started.state.walk().walk())
    );
    assert_eq!(sync.deadlines(&retry.state).len(), 2);
    let timer: TimerDeps<DeadlineExceeded> = sync.timer(&retry.state).unwrap();
    assert_eq!(timer.ms, 10.0);
    assert_eq!(timer.msg.at_ms.number(), Some(15.0));
    let resumed = sync.on_timer(&retry.state, &timer.msg).unwrap();
    assert!(
        matches!(&resumed.commands[0],JsonCommand::Fetch(command) if matches!(&command.input().input,CallValue::Shared(value) if matches!(value.as_ref(),PlainData::Number(value) if *value==0.0)))
    );
    let failed = sync
        .page_err(
            &resumed.state,
            PageErr::new(
                PAGE_KEY,
                CallFailure::external(PlainData::String("down".into())),
                20.0,
            ),
        )
        .unwrap();
    assert_eq!(failed.state.phase(), Phase::Failed);
    assert!(!sync.is_complete(&failed.state));
    assert!(
        matches!(failed.state.walk().resilience().call(PAGE_KEY),Some(CallPhase::Failed {error}) if matches!(error.as_ref(),CallFailure::External(value) if matches!(value.as_ref(),PlainData::String(text) if text.as_utf8()==Some("down"))))
    );
    let deadline = sync
        .on_timer(
            &started.state,
            &deadline_exceeded("resilient:deadline:page", 30.0, None),
        )
        .unwrap();
    assert_eq!(deadline.state.phase(), Phase::Failed);
    assert!(
        matches!(deadline.state.walk().resilience().call(PAGE_KEY),Some(CallPhase::Failed {error}) if matches!(error.as_ref(),CallFailure::DeadlineExceeded {at_ms,..} if at_ms.number()==Some(30.0)))
    );
    let done = sync
        .page_ok(
            &started.state,
            PageOk::new(PAGE_KEY, CallValue::value(PlainData::Null), 1.0),
        )
        .unwrap();
    assert!(sync.is_complete(&done.state));
    let late = sync
        .page_err(
            &done.state,
            PageErr::new(
                PAGE_KEY,
                CallFailure::external(PlainData::Bool(false)),
                1000.0,
            ),
        )
        .unwrap();
    assert_eq!(late.state.phase(), Phase::Done);
    assert!(late.state.walk().ptr_eq(done.state.walk()));
    assert!(!late.state.ptr_eq(&done.state));
    let ignored = sync
        .on_timer(
            &done.state,
            &deadline_exceeded("resilient:deadline:page", 1000.0, None),
        )
        .unwrap();
    assert!(ignored.state.ptr_eq(&done.state));
}

#[test]
fn callback_failures_keep_the_original_cause_and_do_not_publish_partial_scan_state() {
    use demlik_tea::{
        PlainData,
        flow::reconciler::{CallbackPhase, ReconcileError},
        paginate::paginated_walk::{CallbackPhase as WalkPhase, WalkError},
    };
    #[derive(Debug)]
    struct Fault {
        code: &'static str,
        token: Rc<Cell<u32>>,
    }
    for stage in ["next", "items", "diff", "id", "apply"] {
        let token = Rc::new(Cell::new(7));
        let fault = |code| Fault {
            code,
            token: token.clone(),
        };
        let plan = Rc::new(vec![CallValue::value(PlainData::Bool(true))]);
        let config = Config::with_id(
            Rc::new(PlainData::Null),
            CallValue::value(PlainData::Number(0.0)),
            Rc::new(|_| {
                if stage == "next" {
                    Err(fault("next"))
                } else {
                    Ok(None)
                }
            }),
            Rc::new(|_| {
                if stage == "items" {
                    Err(fault("items"))
                } else {
                    Ok(vec![Rc::new(PlainData::Number(1.0))])
                }
            }),
            Rc::new(|_, _| {
                if stage == "diff" {
                    Err(fault("diff"))
                } else {
                    Ok(plan.clone())
                }
            }),
            Rc::new(|change| {
                if stage == "apply" {
                    Err(fault("apply"))
                } else {
                    Ok(JsonCommand::Apply(change.clone()))
                }
            }),
            Rc::new(|_| {
                if stage == "id" {
                    Err(fault("id"))
                } else {
                    Ok(JsText::from("id"))
                }
            }),
        );
        let sync: Reconciler<
            '_,
            PlainData,
            PlainData,
            PlainData,
            PlainData,
            PlainData,
            PlainData,
            Fault,
            JsonCommand,
        > = Reconciler::new(config);
        let started = sync.scan(&sync.init(), 1.0).unwrap();
        let error = match sync.page_ok(
            &started.state,
            PageOk::new(PAGE_KEY, CallValue::value(PlainData::Null), 2.0),
        ) {
            Err(error) => error,
            Ok(_) => panic!("expected callback failure at {stage}"),
        };
        let cause = match error {
            ReconcileError::Walk(WalkError::Callback {
                phase: WalkPhase::NextCursor,
                cause,
            }) if stage == "next" => cause,
            ReconcileError::Callback { phase, cause } => {
                let expected = match stage {
                    "items" => CallbackPhase::ItemsOf,
                    "diff" => CallbackPhase::Diff,
                    "id" => CallbackPhase::Identity,
                    "apply" => CallbackPhase::Apply,
                    _ => panic!("phase"),
                };
                assert_eq!(phase, expected);
                cause
            }
            _ => panic!("wrong callback failure shape"),
        };
        assert_eq!(cause.code, stage);
        assert!(Rc::ptr_eq(&cause.token, &token));
        token.set(9);
        assert_eq!(cause.token.get(), 9);
        assert_eq!(started.state.phase(), Phase::Scanning);
        assert!(started.state.actual().is_empty());
        assert!(started.state.plan().is_empty());
        assert_eq!(
            started
                .state
                .walk()
                .resilience()
                .snapshot()
                .clock_ms
                .number(),
            Some(1.0)
        );
    }
}

#[test]
fn json_identity_serialization_refusal_is_data_before_any_apply_command() {
    use demlik_tea::{PlainData, data::DependencyError, flow::reconciler::ReconcileError};
    use serde::{Serialize, Serializer, ser::Error};
    struct Refuse {
        calls: Rc<Cell<u32>>,
    }
    impl Serialize for Refuse {
        fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
            self.calls.set(self.calls.get() + 1);
            Err(S::Error::custom("identity sentinel refusal"))
        }
    }
    let serialized = Rc::new(Cell::new(0));
    let applied = Cell::new(0);
    let desired_text = String::from("opaque desired");
    let config = Config::new(
        Rc::new(Desired {
            target: &desired_text,
        }),
        CallValue::value(PlainData::Number(0.0)),
        Rc::new(|_| Ok(None)),
        Rc::new(|_| Ok(vec![])),
        Rc::new(|_, _| Ok(Rc::new(vec![]))),
        Rc::new(|_: &Rc<Refuse>| {
            applied.set(applied.get() + 1);
            Ok(JsonCommand::Apply(Rc::new(PlainData::Null)))
        }),
    );
    let sync: Reconciler<
        '_,
        PlainData,
        Desired<'_>,
        PlainData,
        Refuse,
        PlainData,
        PlainData,
        &'static str,
        JsonCommand,
    > = Reconciler::new(config);
    let idle = sync.init();
    let result = sync.planned(
        &idle,
        0.0,
        Some(Rc::new(vec![CallValue::value(Refuse {
            calls: serialized.clone(),
        })])),
    );
    assert!(
        matches!(result,Err(ReconcileError::Identity(DependencyError::Serialization(error))) if error.to_string().contains("identity sentinel refusal"))
    );
    assert_eq!(serialized.get(), 1);
    assert_eq!(applied.get(), 0);
    assert_eq!(idle.phase(), Phase::Idle);
    assert!(idle.plan().is_empty());
}

#[test]
fn reflected_opaque_ledger_values_use_the_existing_cache_projection_boundary() {
    use demlik_tea::{PlainData, flow::reconciler::ReconcileError};
    struct Opaque<'a> {
        id: &'a str,
        value: bool,
        expires: f64,
    }
    let a = Rc::new(Opaque {
        id: "__proto__",
        value: true,
        expires: 1000.0,
    });
    let b = Rc::new(Opaque {
        id: "value",
        value: false,
        expires: 0.0,
    });
    let config = Config::with_id(
        Rc::new(PlainData::Null),
        CallValue::value(PlainData::Number(0.0)),
        Rc::new(|_| Ok(None)),
        Rc::new(|_| Ok(vec![])),
        Rc::new(|_, _| Ok(Rc::new(vec![]))),
        Rc::new(|_: &Rc<Opaque<'_>>| Ok(JsonCommand::Apply(Rc::new(PlainData::Bool(true))))),
        Rc::new(|change: &CallValue<Opaque<'_>>| match change {
            CallValue::Shared(change) => Ok(JsText::from(change.id)),
            _ => Err("missing change"),
        }),
    );
    let sync: Reconciler<
        '_,
        PlainData,
        PlainData,
        PlainData,
        Opaque<'_>,
        PlainData,
        PlainData,
        &'static str,
        JsonCommand,
    > = Reconciler::new(config);
    let started = sync
        .planned(
            &sync.init(),
            0.0,
            Some(Rc::new(vec![
                CallValue::shared(a.clone()),
                CallValue::shared(b),
            ])),
        )
        .unwrap();
    let refused = sync.applied(&started.state, CallValue::shared(a.clone()), 0.0);
    assert!(matches!(refused,Err(ReconcileError::Cache(error)) if error.name=="ProjectionRefused"));
    assert_eq!(started.state.applied().entries.own_entries().count(), 0);
    let count = Cell::new(0);
    let projection: demlik_tea::flow::reconciler::LedgerProjection<'_, Opaque<'_>> =
        Rc::new(|value| {
            count.set(count.get() + 1);
            let CallValue::Shared(value) = value else {
                return Err(JsAccessError {
                    name: "BadProjection",
                    message: "missing value".into(),
                });
            };
            assert!(Rc::ptr_eq(value, &a));
            Ok(PlainData::Object(
                [
                    ("value".into(), PlainData::Bool(value.value)),
                    ("expiresAtMs".into(), PlainData::Number(value.expires)),
                ]
                .into_iter()
                .collect(),
            ))
        });
    let sync = sync.with_ledger_projection(projection.clone());
    assert_eq!(Rc::strong_count(&projection), 2);
    let done = sync
        .applied(&started.state, CallValue::shared(a.clone()), 0.0)
        .unwrap();
    assert_eq!(done.state.phase(), Phase::Done);
    assert!(done.commands.is_empty());
    assert_eq!(count.get(), 1);
}

#[test]
fn json_reload_keeps_utf16_ledger_identity_and_nullable_cursor_indexing() {
    use demlik_tea::{
        PlainData,
        data::decode_json,
        flow::reconciler::{AppliedCursor, State},
    };
    type JsonState = State<PlainData, PlainData, PlainData, PlainData, PlainData>;
    let sync = json_sync();
    let change = Rc::new(decode_json(r#"{"\ud800":"\udc00"}"#).unwrap());
    let plan = Rc::new(vec![
        CallValue::Undefined,
        CallValue::shared(change.clone()),
    ]);
    let planned = sync.planned(&sync.init(), 0.0, Some(plan)).unwrap();
    assert_eq!(planned.state.applied_cursor().number(), Some(1.0));
    let done = sync
        .applied(&planned.state, CallValue::shared(change.clone()), 1.0)
        .unwrap();
    let encoded = serde_json::to_string(&done.state).unwrap();
    assert!(encoded.contains(r#""plan":[null,{"\ud800":"\udc00"}]"#));
    let restored: JsonState = serde_json::from_str(&encoded).unwrap();
    let repeated = sync
        .planned(
            &restored,
            2.0,
            Some(Rc::new(vec![CallValue::shared(change)])),
        )
        .unwrap();
    assert!(repeated.commands.is_empty());
    assert_eq!(repeated.state.phase(), Phase::Done);
    let pending = sync
        .planned(
            &sync.init(),
            0.0,
            Some(Rc::new(vec![
                CallValue::value(PlainData::Number(1.0)),
                CallValue::value(PlainData::Number(2.0)),
            ])),
        )
        .unwrap();
    let mut snapshot = pending.state.snapshot().clone();
    snapshot.applied_cursor = f64::INFINITY.into();
    let encoded = serde_json::to_string(&JsonState::from_snapshot(snapshot)).unwrap();
    assert!(encoded.contains(r#""appliedCursor":null"#));
    let restored: JsonState = serde_json::from_str(&encoded).unwrap();
    assert!(matches!(restored.applied_cursor(), AppliedCursor(None)));
    let next = sync.apply_next(&restored, 0.0).unwrap();
    assert_eq!(next.state.applied_cursor().number(), Some(1.0));
    assert!(
        matches!(&next.commands[0],JsonCommand::Apply(value) if matches!(value.as_ref(),PlainData::Number(value) if *value==2.0))
    );
}

#[test]
fn the_same_apply_callable_reenters_without_skipping_the_nested_command() {
    use demlik_tea::{
        PlainData,
        flow::reconciler::{Apply, State},
    };
    use std::rc::Weak;
    type Model = State<PlainData, PlainData, PlainData, PlainData, PlainData>;
    let weak: Rc<RefCell<Weak<JsonSync>>> = Rc::new(RefCell::new(Weak::new()));
    let current: Rc<RefCell<Option<Model>>> = Rc::new(RefCell::new(None));
    let calls = Rc::new(Cell::new(0));
    let weak_callback = weak.clone();
    let current_callback = current.clone();
    let count = calls.clone();
    let apply: Apply<'static, PlainData, JsonCommand, &'static str> = Rc::new(move |change| {
        count.set(count.get() + 1);
        if count.get() == 1 {
            let sync = weak_callback.borrow().upgrade().unwrap();
            let state = current_callback.borrow().as_ref().unwrap().clone();
            let nested = sync.apply_next(&state, 0.0).unwrap();
            assert_eq!(nested.commands.len(), 1);
        }
        Ok(JsonCommand::Apply(change.clone()))
    });
    let mut config = json_config();
    config.apply = apply.clone();
    let sync = Rc::new(Reconciler::new(config));
    assert_eq!(Rc::strong_count(&apply), 2);
    *weak.borrow_mut() = Rc::downgrade(&sync);
    let mut snapshot = sync.init().snapshot().clone();
    snapshot.phase = Phase::Applying;
    snapshot.plan = Rc::new(vec![CallValue::value(PlainData::Bool(true))]);
    let state = Model::from_snapshot(snapshot);
    *current.borrow_mut() = Some(state.clone());
    let outer = sync.apply_next(&state, 0.0).unwrap();
    assert_eq!(calls.get(), 2);
    assert_eq!(outer.commands.len(), 1);
    assert_eq!(outer.state.applied_cursor().number(), Some(0.0));
    assert_eq!(state.phase(), Phase::Applying);
}

#[test]
fn lift_keeps_the_callers_borrowed_host_and_commands() {
    use demlik_tea::{
        PlainData, Step,
        flow::reconciler::{State, lift_reconciler},
    };
    struct Host<'a> {
        label: &'a str,
        rec: State<PlainData, PlainData, PlainData, PlainData, PlainData>,
    }
    let label = String::from("kept");
    let sync = json_sync();
    let started = sync.scan(&sync.init(), 17.25).unwrap();
    let expected = started.state.clone();
    let lifted = lift_reconciler(
        Host {
            label: &label,
            rec: sync.init(),
        },
        Step::new(started.state, started.commands),
        |host: Host<'_>, rec| Host { rec, ..host },
    );
    assert_eq!(lifted.state.label, "kept");
    assert!(lifted.state.rec.ptr_eq(&expected));
    assert_eq!(lifted.commands.len(), 1);
}
