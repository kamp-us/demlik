use demlik_tea::{
    Tagged,
    paginate::paginated_walk::{Config, PAGE_KEY, PageOk, PaginatedWalk},
    resilience::resilient_call::{CallValue, RunCommand},
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

struct Cursor<'a>(&'a str);
struct Page<'a> {
    next: Option<Rc<Cursor<'a>>>,
    body: &'a str,
    visits: &'a Cell<u32>,
}
enum Command<'a> {
    Fetch(RunCommand<Cursor<'a>, Page<'a>, &'static str>),
    Process(Rc<Page<'a>>),
}
impl<'a> From<RunCommand<Cursor<'a>, Page<'a>, &'static str>> for Command<'a> {
    fn from(command: RunCommand<Cursor<'a>, Page<'a>, &'static str>) -> Self {
        Self::Fetch(command)
    }
}
impl Tagged for Command<'_> {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(command) => command.tag(),
            Self::Process(_) => "process_page",
        }
    }
}

#[test]
fn borrowed_pages_keep_identity_and_backpressure_reopens_only_after_drain() {
    let first_text = String::from("first");
    let next_text = String::from("second");
    let body = String::from("items");
    let first = Rc::new(Cursor(&first_text));
    let next = Rc::new(Cursor(&next_text));
    let visits = Cell::new(0);
    let page = Rc::new(Page {
        next: Some(next.clone()),
        body: &body,
        visits: &visits,
    });
    let order = RefCell::new(vec![]);
    let mut config = Config::new(
        CallValue::shared(first.clone()),
        Rc::new(|page: &CallValue<Page<'_>>| {
            order.borrow_mut().push("next");
            let CallValue::Shared(page) = page else {
                return Err("page missing");
            };
            Ok(page.next.clone())
        }),
        Rc::new(|page: &CallValue<Page<'_>>| {
            order.borrow_mut().push("process");
            let CallValue::Shared(page) = page else {
                return Err("page missing");
            };
            page.visits.set(page.visits.get() + 1);
            Ok(vec![Command::Process(page.clone())])
        }),
    );
    config.page_size = Some(Rc::new(|_| {
        order.borrow_mut().push("size");
        Ok(2.0)
    }));
    config.high_water_mark = 2.0;
    let walk: PaginatedWalk<'_, Cursor<'_>, Page<'_>, &'static str, &'static str, Command<'_>> =
        PaginatedWalk::new(config);
    let idle = walk.init();
    let started = walk.start(&idle, 10.0).unwrap();
    let Command::Fetch(command) = &started.commands[0] else {
        panic!("first page fetch")
    };
    assert_eq!(command.input().key.as_utf8(), Some(PAGE_KEY));
    assert!(
        matches!(&command.input().input,CallValue::Shared(cursor) if Rc::ptr_eq(cursor,&first))
    );
    assert!(
        started
            .state
            .ptr_eq(&walk.start(&started.state, 1000.0).unwrap().state)
    );
    let paused = walk
        .page_ok(
            &started.state,
            PageOk::new(PAGE_KEY, CallValue::shared(page.clone()), 11.0),
        )
        .unwrap();
    assert_eq!(&*order.borrow(), &["size", "next", "process"]);
    assert_eq!(paused.state.walk().phase_name(), "paused");
    assert_eq!(paused.state.walk().seen(), 2.0);
    assert_eq!(paused.state.walk().pages(), 1.0);
    let [Command::Process(processed)] = paused.commands.as_slice() else {
        panic!("one caller command")
    };
    assert!(Rc::ptr_eq(processed, &page));
    assert_eq!(processed.body, "items");
    assert_eq!(visits.get(), 1);
    assert!(
        paused
            .state
            .ptr_eq(&walk.resume(&paused.state, 12.0).unwrap().state)
    );
    let drained = walk.drain(&paused.state, 1.0);
    let resumed = walk.resume(&drained.state, 13.0).unwrap();
    assert_eq!(resumed.state.walk().phase_name(), "fetching");
    let [Command::Fetch(command)] = resumed.commands.as_slice() else {
        panic!("second page fetch")
    };
    assert!(
        matches!(&command.input().input,CallValue::Shared(cursor) if Rc::ptr_eq(cursor,&next) && cursor.0=="second")
    );
    assert_eq!(idle.walk().phase_name(), "idle");
}

#[test]
fn retry_keeps_the_cursor_and_a_late_error_cannot_corrupt_a_finished_walk() {
    use demlik_tea::{
        paginate::paginated_walk::PageErr,
        resilience::{
            deadline::deadline_exceeded,
            resilient_call::{CallFailure, CallPhase, DeadlineConfig},
        },
        retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    };
    let first = Rc::new(Cursor("first"));
    let visits = Cell::new(0);
    let mut config = Config::new(
        CallValue::shared(first.clone()),
        Rc::new(|_| Ok(None)),
        Rc::new(|_| Ok(vec![])),
    );
    config.deadline = Some(DeadlineConfig { ms: 50.0 });
    config.retry = Some(RetryPolicy {
        curve: BackoffCurve {
            base_ms: 10.0,
            factor: 2.0,
            cap_ms: 100.0,
            jitter: Jitter::None,
        },
        budget: CountBound { max_attempts: 3.0 },
    });
    let walk: PaginatedWalk<'_, Cursor<'_>, Page<'_>, &'static str, &'static str, Command<'_>> =
        PaginatedWalk::new(config);
    let started = walk.start(&walk.init(), 0.0).unwrap();
    let failed = walk
        .page_err(
            &started.state,
            PageErr::new(PAGE_KEY, CallFailure::external("offline"), 5.0),
        )
        .unwrap();
    assert!(started.state.walk().ptr_eq(failed.state.walk()));
    assert!(failed.commands.is_empty());
    assert!(
        matches!(failed.state.resilience().call(PAGE_KEY),Some(CallPhase::WaitingRetry {retry_at_ms,..}) if *retry_at_ms==25.0)
    );
    let timer: demlik_tea::TimerDeps<_> = walk.timer(&failed.state).unwrap();
    assert_eq!(timer.ms, 20.0);
    let retried = walk.on_timer(&failed.state, &timer.msg).unwrap();
    let [Command::Fetch(command)] = retried.commands.as_slice() else {
        panic!("retry fetch")
    };
    assert!(
        matches!(&command.input().input,CallValue::Shared(cursor) if Rc::ptr_eq(cursor,&first))
    );
    let timed_out = walk
        .on_timer(
            &retried.state,
            &deadline_exceeded("resilient:deadline:page", 50.0, None),
        )
        .unwrap();
    assert!(timed_out.commands.is_empty());
    assert!(walk.is_stuck(&timed_out.state));
    assert!(!walk.is_complete(&timed_out.state));
    assert!(
        matches!(walk.failure(&timed_out.state).map(|error|error.as_ref()),Some(CallFailure::DeadlineExceeded {at_ms,..}) if *at_ms==50.0)
    );
    let done = walk
        .page_ok(
            &timed_out.state,
            PageOk::new(
                PAGE_KEY,
                CallValue::value(Page {
                    next: None,
                    body: "last",
                    visits: &visits,
                }),
                51.0,
            ),
        )
        .unwrap();
    assert!(walk.is_complete(&done.state));
    assert!(!walk.is_stuck(&done.state));
    assert!(walk.failure(&done.state).is_none());
    let late = walk
        .page_err(
            &done.state,
            PageErr::new(PAGE_KEY, CallFailure::external("late"), 1000.0),
        )
        .unwrap();
    assert!(done.state.ptr_eq(&late.state));
    let late = walk
        .on_timer(
            &done.state,
            &deadline_exceeded("resilient:deadline:page", 1000.0, None),
        )
        .unwrap();
    assert!(done.state.ptr_eq(&late.state));
    assert!(late.commands.is_empty());
}

enum WireCommand {
    Fetch(RunCommand<demlik_tea::PlainData, demlik_tea::PlainData, demlik_tea::PlainData>),
}
impl From<RunCommand<demlik_tea::PlainData, demlik_tea::PlainData, demlik_tea::PlainData>>
    for WireCommand
{
    fn from(
        command: RunCommand<demlik_tea::PlainData, demlik_tea::PlainData, demlik_tea::PlainData>,
    ) -> Self {
        Self::Fetch(command)
    }
}
impl Tagged for WireCommand {
    fn tag(&self) -> &str {
        match self {
            Self::Fetch(command) => command.tag(),
        }
    }
}

#[test]
fn restored_undefined_and_null_first_pages_keep_different_retry_behavior() {
    use demlik_tea::{
        PlainData,
        paginate::paginated_walk::{PageErr, State},
        resilience::resilient_call::{CallFailure, CallPhase},
        retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    };
    for (first, expected_phase, expected_cursor) in [
        (CallValue::Undefined, "failed", None),
        (
            CallValue::value(PlainData::Null),
            "waiting_retry",
            Some(serde_json::Value::Null),
        ),
    ] {
        let mut config = Config::new(first, Rc::new(|_| Ok(None)), Rc::new(|_| Ok(vec![])));
        config.retry = Some(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 1.0,
                factor: 2.0,
                cap_ms: 8.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 3.0 },
        });
        let walk: PaginatedWalk<'_, PlainData, PlainData, PlainData, &'static str, WireCommand> =
            PaginatedWalk::new(config);
        let started = walk.start(&walk.init(), 0.0).unwrap();
        let encoded = serde_json::to_string(&started.state).unwrap();
        let observed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(observed["walk"].get("cursor"), expected_cursor.as_ref());
        let restored: State<PlainData, PlainData, PlainData> =
            serde_json::from_str(&encoded).unwrap();
        assert_eq!(serde_json::to_string(&restored).unwrap(), encoded);
        assert!(restored.ptr_eq(&walk.resume(&restored, 1000.0).unwrap().state));
        let failed = walk
            .page_err(
                &restored,
                PageErr::new(
                    PAGE_KEY,
                    CallFailure::external(PlainData::String("offline".into())),
                    1.0,
                ),
            )
            .unwrap();
        assert_eq!(failed.state.walk().phase_name(), "fetching");
        let actual = match failed.state.resilience().call(PAGE_KEY).unwrap() {
            CallPhase::Failed { .. } => "failed",
            CallPhase::WaitingRetry { .. } => "waiting_retry",
            _ => panic!("settled failure"),
        };
        assert_eq!(actual, expected_phase);
    }
}

#[test]
fn callback_failures_retain_the_callers_cause_and_the_original_running_state() {
    use demlik_tea::{
        PlainData,
        paginate::paginated_walk::{CallbackPhase, NextCursor, WalkError},
        resilience::resilient_call::CallPhase,
    };
    #[derive(Debug)]
    struct Fault {
        cause: Rc<Cell<u32>>,
    }
    let selected = Cell::new(CallbackPhase::PageSize);
    let cause = Rc::new(Cell::new(7));
    let order = RefCell::new(vec![]);
    let next: NextCursor<'_, PlainData, PlainData, Fault> = Rc::new(|_| {
        order.borrow_mut().push("next");
        if selected.get() == CallbackPhase::NextCursor {
            Err(Fault {
                cause: cause.clone(),
            })
        } else {
            Ok(None)
        }
    });
    let mut config = Config::new(
        CallValue::value(PlainData::Null),
        next.clone(),
        Rc::new(|_| {
            order.borrow_mut().push("on");
            if selected.get() == CallbackPhase::OnPage {
                Err(Fault {
                    cause: cause.clone(),
                })
            } else {
                Ok(vec![])
            }
        }),
    );
    config.page_size = Some(Rc::new(|_| {
        order.borrow_mut().push("size");
        if selected.get() == CallbackPhase::PageSize {
            Err(Fault {
                cause: cause.clone(),
            })
        } else {
            Ok(1.0)
        }
    }));
    let walk: PaginatedWalk<'_, PlainData, PlainData, PlainData, Fault, WireCommand> =
        PaginatedWalk::new(config);
    assert_eq!(Rc::strong_count(&next), 2);
    let started = walk.start(&walk.init(), 10.0).unwrap();
    for (phase, expected) in [
        (CallbackPhase::PageSize, vec!["size"]),
        (CallbackPhase::NextCursor, vec!["size", "next"]),
        (CallbackPhase::OnPage, vec!["size", "next", "on"]),
    ] {
        selected.set(phase);
        order.borrow_mut().clear();
        let error = match walk.page_ok(
            &started.state,
            PageOk::new(PAGE_KEY, CallValue::value(PlainData::Null), 11.0),
        ) {
            Ok(_) => panic!("callback refusal"),
            Err(error) => error,
        };
        assert!(
            matches!(error,WalkError::Callback {phase:actual,cause:Fault {cause:actual_cause}} if actual==phase && Rc::ptr_eq(&actual_cause,&cause))
        );
        assert_eq!(&*order.borrow(), &expected);
        assert!(matches!(
            started.state.resilience().call(PAGE_KEY),
            Some(CallPhase::Running { .. })
        ));
        assert_eq!(started.state.resilience().snapshot().clock_ms, 10.0);
        assert_eq!(Rc::strong_count(&next), 2);
    }
}

#[test]
fn on_page_really_reenters_the_same_callable_without_losing_the_second_call() {
    use demlik_tea::{PlainData, paginate::paginated_walk::State};
    type Walk = PaginatedWalk<'static, PlainData, PlainData, PlainData, &'static str, WireCommand>;
    let handle: Rc<RefCell<Option<std::rc::Weak<Walk>>>> = Rc::new(RefCell::new(None));
    let snapshot: Rc<RefCell<Option<State<PlainData, PlainData, PlainData>>>> =
        Rc::new(RefCell::new(None));
    let calls = Rc::new(Cell::new(0));
    let on_page = {
        let handle = handle.clone();
        let snapshot = snapshot.clone();
        let calls = calls.clone();
        Rc::new(move |page: &CallValue<PlainData>| {
            let count = calls.get();
            calls.set(count + 1);
            if count == 0 {
                let walk = handle.borrow().as_ref().unwrap().upgrade().unwrap();
                let state = snapshot.borrow().as_ref().unwrap().clone();
                let reentered = walk
                    .page_ok(&state, PageOk::new(PAGE_KEY, page.clone(), 2.0))
                    .unwrap();
                assert!(walk.is_complete(&reentered.state));
            }
            Ok(vec![])
        })
    };
    let walk: Rc<Walk> = Rc::new(PaginatedWalk::new(Config::new(
        CallValue::value(PlainData::Null),
        Rc::new(|_| Ok(None)),
        on_page,
    )));
    *handle.borrow_mut() = Some(Rc::downgrade(&walk));
    let started = walk.start(&walk.init(), 0.0).unwrap();
    *snapshot.borrow_mut() = Some(started.state.clone());
    let done = walk
        .page_ok(
            &started.state,
            PageOk::new(PAGE_KEY, CallValue::value(PlainData::Null), 1.0),
        )
        .unwrap();
    assert_eq!(calls.get(), 2);
    assert_eq!(done.state.walk().pages(), 1.0);
    assert!(walk.is_complete(&done.state));
}

#[test]
fn lift_keeps_an_unrelated_borrowed_model_and_the_typed_command() {
    use demlik_tea::{PlainData, Step, paginate::paginated_walk::lift_walk};
    struct Host<'a> {
        label: &'a str,
        walk: demlik_tea::paginate::paginated_walk::State<PlainData, PlainData, PlainData>,
    }
    let label = String::from("kept");
    let config = Config::new(
        CallValue::value(PlainData::Null),
        Rc::new(|_| Ok(None)),
        Rc::new(|_| Ok(vec![])),
    );
    let knob: PaginatedWalk<'_, PlainData, PlainData, PlainData, &'static str, WireCommand> =
        PaginatedWalk::new(config);
    let idle = knob.init();
    let started = knob.start(&idle, 17.25).unwrap();
    let lifted = lift_walk(
        Host {
            label: &label,
            walk: idle,
        },
        Step::new(started.state.clone(), started.commands),
        |host: Host<'_>, walk| Host { walk, ..host },
    );
    assert_eq!(lifted.state.label, "kept");
    assert!(lifted.state.walk.ptr_eq(&started.state));
    assert_eq!(lifted.commands.len(), 1);
}

#[test]
fn pure_walk_emits_opaque_commands_before_the_runtime_tag_boundary() {
    enum PureCommand<'a> {
        Fetch(RunCommand<&'a str, &'a str, ()>),
        Save { payload: &'a str },
    }
    impl<'a> From<RunCommand<&'a str, &'a str, ()>> for PureCommand<'a> {
        fn from(command: RunCommand<&'a str, &'a str, ()>) -> Self {
            Self::Fetch(command)
        }
    }
    let text = String::from("borrowed page");
    let config = Config::new(
        CallValue::value("first"),
        Rc::new(|_: &CallValue<&str>| Ok::<_, ()>(None)),
        Rc::new(|page: &CallValue<&str>| {
            let CallValue::Shared(page) = page else {
                panic!("typed page")
            };
            Ok(vec![PureCommand::Save { payload: **page }])
        }),
    );
    let walk: PaginatedWalk<'_, &str, &str, (), (), PureCommand<'_>> = PaginatedWalk::new(config);
    let mut started = walk.start(&walk.init(), 0.0).unwrap();
    let PureCommand::Fetch(command) = started.commands.pop().unwrap() else {
        panic!("fetch")
    };
    assert!(matches!(command.input().input, CallValue::Shared(ref value) if **value == "first"));
    let done = walk
        .page_ok(
            &started.state,
            PageOk::new(PAGE_KEY, CallValue::value(text.as_str()), 1.0),
        )
        .unwrap();
    let [PureCommand::Save { payload }] = done.commands.as_slice() else {
        panic!("caller command")
    };
    assert_eq!(*payload, text);
}
