use demlik_tea::{
    flow::monitored_run::{MonitoredRun, MonitoredRunConfig, RunPhase, StageResult},
    work_queue::QueueItemStatus,
};
use std::rc::Rc;
struct Stage {
    label: &'static str,
    _local: Rc<()>,
}
struct Payload(u32);
#[test]
fn pipeline_advances_the_shared_queue_and_forces_the_terminal_checkpoint() {
    let stages = [
        Rc::new(Stage {
            label: "first",
            _local: Rc::new(()),
        }),
        Rc::new(Stage {
            label: "last",
            _local: Rc::new(()),
        }),
    ];
    let run: MonitoredRun<Stage, Payload> = MonitoredRun::new(MonitoredRunConfig {
        stages: stages.to_vec(),
        deadline_ms: Some(1000.0),
        snapshot_every: Some(2.0),
        snapshot_key: Some("run".into()),
    });
    let initial = run.init();
    assert!(matches!(initial.phase, RunPhase::Idle));
    assert!(run.deadlines(&initial).is_empty());
    let started = run.start(&initial, "r", 100.0);
    assert_eq!(started.state.step_states.len(), 2);
    assert_eq!(
        started.state.step_states.get(0).unwrap().status,
        QueueItemStatus::Running
    );
    assert!(Rc::ptr_eq(
        &started.state.step_states.get(0).unwrap().input,
        &stages[0]
    ));
    let first = run.advance(&started.state, Rc::new(Payload(1)), StageResult::Ok, 110.0);
    assert!(first.commands.is_empty());
    assert_eq!(first.state.step_states.len(), 1);
    assert_eq!(first.state.step_states.get(0).unwrap().input.label, "last");
    assert_eq!(first.state.progress_seq.number(), Some(1.0));
    assert_eq!(first.state.snapshot.since_last.number(), Some(1.0));
    let payload = Rc::new(Payload(2));
    let done = run.advance(&first.state, Rc::clone(&payload), StageResult::Ok, 120.0);
    assert!(matches!(done.state.phase, RunPhase::Done { .. }));
    assert!(done.state.step_states.is_empty());
    assert!(run.deadlines(&done.state).is_empty());
    assert_eq!(done.commands.len(), 1);
    assert!(Rc::ptr_eq(&done.commands[0].input().payload, &payload));
    assert_eq!(done.commands[0].input().payload.0, 2);
    assert_eq!(done.commands[0].input().seq, 1.0);
    assert_eq!(done.commands[0].input().at, 120.0);
    let stale = run.advance(&done.state, Rc::new(Payload(3)), StageResult::Ok, 130.0);
    assert!(Rc::ptr_eq(&stale.state, &done.state));
    assert!(stale.commands.is_empty());
    assert_eq!(started.state.step_states.len(), 2);
}

#[test]
fn lifting_a_started_run_preserves_an_opaque_host_and_the_command_result() {
    use demlik_tea::flow::monitored_run::lift_run;
    struct Host {
        run: Rc<demlik_tea::flow::monitored_run::MonitoredRunState<Stage>>,
        token: Box<u32>,
    }
    let run: MonitoredRun<Stage, Payload> = MonitoredRun::new(MonitoredRunConfig::default());
    let host = Host {
        run: run.init(),
        token: Box::new(41),
    };
    let token = &*host.token as *const u32;
    let started = run.start(&host.run, "new", 10.0);
    let lifted = lift_run(host, started, |host, run| Host { run, ..host });
    assert!(matches!(lifted.state.run.phase, RunPhase::Running { .. }));
    assert_eq!(&*lifted.state.token as *const u32, token);
    assert!(lifted.commands.is_empty());
}

#[test]
fn single_shot_failure_retains_its_own_undefined_stage_and_json_omits_only_that_value() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
    };
    let run: MonitoredRun<PlainData, PlainData> = MonitoredRun::new(MonitoredRunConfig::default());
    let started = run.start(&run.init(), "r", 10.0).state;
    let failed = run
        .advance(
            &started,
            Rc::new(PlainData::Null),
            StageResult::Fail {
                error: Rc::new(PlainData::String("bad".into())),
            },
            20.0,
        )
        .state;
    let PlainData::Object(fields) = plain_data(failed.as_ref()).unwrap() else {
        panic!("run is a record")
    };
    assert_eq!(
        fields
            .keys()
            .map(|key| key.as_utf8().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "phase",
            "runId",
            "stepStates",
            "startedAt",
            "lastProgressAt",
            "progressSeq",
            "snapshot",
            "failure"
        ]
    );
    let PlainData::Object(failure) = fields
        .get(&demlik_tea::data::JsText::from("failure"))
        .unwrap()
    else {
        panic!("failure is a record")
    };
    assert!(matches!(
        failure.get(&demlik_tea::data::JsText::from("stage")),
        Some(PlainData::Undefined)
    ));
    assert_eq!(
        stringify_json(&PlainData::Object(failure.clone())).unwrap(),
        "{\"reason\":\"stage\",\"error\":\"bad\"}"
    );
    let restored: demlik_tea::flow::monitored_run::MonitoredRunState<PlainData> =
        serde_json::from_str(&stringify_json(&PlainData::Object(fields)).unwrap()).unwrap();
    let PlainData::Object(restored) = plain_data(&restored).unwrap() else {
        panic!("restored run is a record")
    };
    let PlainData::Object(failure) = restored
        .get(&demlik_tea::data::JsText::from("failure"))
        .unwrap()
    else {
        panic!("restored failure is a record")
    };
    assert!(!failure.contains_key(&demlik_tea::data::JsText::from("stage")));
}

#[test]
fn cold_boot_keeps_the_stage_position_resets_cadence_and_refuses_the_old_alarm() {
    use demlik_tea::resilience::deadline::deadline_exceeded;
    let run: MonitoredRun<Stage, Payload> = MonitoredRun::new(MonitoredRunConfig {
        stages: vec![
            Rc::new(Stage {
                label: "a",
                _local: Rc::new(()),
            }),
            Rc::new(Stage {
                label: "b",
                _local: Rc::new(()),
            }),
        ],
        deadline_ms: Some(1000.0),
        snapshot_every: Some(3.0),
        snapshot_key: None,
    });
    let started = run.start(&run.init(), "", 10.0).state;
    let moved = run
        .advance(&started, Rc::new(Payload(1)), StageResult::Ok, 20.0)
        .state;
    let stale = run.mark_stale(&moved).state;
    let old_alarm = run.timer(&stale).unwrap().msg;
    let booted = run.boot(&stale, 9000.0).state;
    assert!(matches!(booted.phase, RunPhase::Running { .. }));
    assert_eq!(booted.progress_seq.number(), Some(2.0));
    assert_eq!(booted.last_progress_at.number(), Some(9000.0));
    assert_eq!(booted.started_at.number(), Some(10.0));
    assert_eq!(booted.snapshot.since_last.number(), Some(0.0));
    assert!(booted.step_states.ptr_eq(&stale.step_states));
    assert_eq!(booted.step_states.get(0).unwrap().input.label, "b");
    assert!(Rc::ptr_eq(
        &run.on_deadline(&booted, &old_alarm).state,
        &booted
    ));
    let live = run.timer(&booted).unwrap();
    assert_eq!(live.ms, 1000.0);
    assert_eq!(live.msg.id.as_utf8(), Some("monitored:safety::2"));
    // The id is the guard; the source accepts an early matching host fire.
    let failed = run
        .on_deadline(&booted, &deadline_exceeded(live.msg.id, 1.0, None))
        .state;
    assert!(
        matches!(&failed.phase, RunPhase::Failed { failure, .. } if matches!(failure.as_ref(), demlik_tea::flow::monitored_run::RunFailure::Deadline { at } if at.number() == Some(1.0)))
    );
    assert!(run.deadlines(&failed).is_empty());
    assert!(Rc::ptr_eq(
        &run.progress(&failed, Rc::new(Payload(2)), 9001.0).state,
        &failed
    ));
    let restarted = run.start(&failed, "next", 10000.0).state;
    assert!(matches!(restarted.phase, RunPhase::Running { .. }));
    assert_eq!(restarted.step_states.len(), 2);
    assert_eq!(restarted.progress_seq.number(), Some(0.0));
}

#[test]
fn idle_cancellation_and_stage_failure_are_terminal_data_without_payload_bounds() {
    struct Failure {
        code: u32,
        _local: Rc<()>,
    }
    let run: MonitoredRun<Stage, Payload, Failure> =
        MonitoredRun::new(MonitoredRunConfig::default());
    let cancelled = run.cancel(&run.init(), 9.0).state;
    assert!(matches!(
        cancelled.phase,
        RunPhase::Cancelled {
            run_id: None,
            at
        } if at.number() == Some(9.0)
    ));
    assert!(Rc::ptr_eq(&run.cancel(&cancelled, 10.0).state, &cancelled));
    let live = run.start(&cancelled, "r", 20.0).state;
    let error = Rc::new(Failure {
        code: 503,
        _local: Rc::new(()),
    });
    let failed = run.advance(
        &live,
        Rc::new(Payload(1)),
        StageResult::Fail {
            error: Rc::clone(&error),
        },
        30.0,
    );
    assert!(failed.commands.is_empty());
    assert_eq!(failed.state.progress_seq.number(), Some(0.0));
    assert_eq!(failed.state.last_progress_at.number(), Some(20.0));
    let RunPhase::Failed { failure, .. } = &failed.state.phase else {
        panic!("stage failure")
    };
    let demlik_tea::flow::monitored_run::RunFailure::Stage {
        stage,
        error: retained,
    } = failure.as_ref()
    else {
        panic!("stage failure")
    };
    assert!(stage.is_undefined());
    assert!(Rc::ptr_eq(retained.value().unwrap(), &error));
    assert_eq!(retained.value().unwrap().code, 503);
    assert!(Rc::ptr_eq(
        &run.boot(&failed.state, 100.0).state,
        &failed.state
    ));
    assert!(Rc::ptr_eq(
        &run.cancel(&failed.state, 100.0).state,
        &failed.state
    ));
}

#[test]
fn restored_null_clocks_and_watchdog_sequences_keep_their_data_and_coerce_only_when_used() {
    use demlik_tea::{
        PlainData,
        data::{plain_data, stringify_json},
        flow::monitored_run::{MonitoredRunState, RunFailure},
        resilience::deadline::deadline_exceeded,
    };
    fn restore(state: &MonitoredRunState<PlainData>) -> Rc<MonitoredRunState<PlainData>> {
        Rc::new(
            serde_json::from_str(&stringify_json(&plain_data(state).unwrap()).unwrap()).unwrap(),
        )
    }
    let run: MonitoredRun<PlainData, PlainData> = MonitoredRun::new(MonitoredRunConfig {
        deadline_ms: Some(50.0),
        ..Default::default()
    });
    let started = run.start(&run.init(), "r", f64::NAN).state;
    let mut seeded = started.as_ref().clone();
    seeded.core.progress_seq = f64::NAN.into();
    let restored = restore(&seeded);
    assert_eq!(restored.started_at.number(), None);
    assert_eq!(restored.last_progress_at.number(), None);
    assert_eq!(restored.progress_seq.number(), None);
    let timer = run.timer(&restored).unwrap();
    assert_eq!(timer.ms, 50.0);
    assert_eq!(timer.msg.id.as_utf8(), Some("monitored:safety:r:null"));
    let booted = run.boot(&restored, 100.0).state;
    assert_eq!(booted.started_at.number(), None);
    assert_eq!(booted.last_progress_at.number(), Some(100.0));
    assert_eq!(booted.progress_seq.number(), Some(1.0));
    let failed = run
        .on_deadline(
            &booted,
            &deadline_exceeded("monitored:safety:r:1", f64::NAN, None),
        )
        .state;
    let failed = restore(&failed);
    assert!(
        matches!(&failed.phase, RunPhase::Failed { failure, .. } if matches!(failure.as_ref(), RunFailure::Deadline { at } if at.number().is_none()))
    );
    assert!(Rc::ptr_eq(&run.boot(&failed, 200.0).state, &failed));
    let cancelled = restore(&run.cancel(&run.init(), f64::NAN).state);
    assert!(matches!(&cancelled.phase, RunPhase::Cancelled { at, .. } if at.number().is_none()));
    assert!(Rc::ptr_eq(&run.cancel(&cancelled, 300.0).state, &cancelled));
}
