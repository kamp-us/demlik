use demlik_tea::command::{CmdDef, Settled};
use demlik_tea::flow::monitored_run::{
    self as monitor, MonitoredRun, MonitoredRunConfig, MonitoredRunState, RunPhase, StageResult,
};
use demlik_tea::persistence::snapshot::{
    self as snapshot, Snapshot, SnapshotConfig, SnapshotFailure, SnapshotState, SnapshotWriteInput,
    SnapshotWriteSpec,
};
use demlik_tea::resilience::deadline::deadline_exceeded;
use demlik_tea::{
    PlainData, Step,
    data::{JsText, plain_data, stringify_json},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead},
    rc::Rc,
};
#[path = "../paginate_queue/wire.rs"]
mod wire;
use wire::{Number, data, number, text};
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe { ($calls:expr,$function:path $(,$arg:expr)* $(,)?) => {{let value=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));value}}; }

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum TextInput {
    Utf8(String),
    Units {
        #[serde(rename = "$utf16")]
        units: Vec<u16>,
    },
}
impl From<TextInput> for JsText {
    fn from(text: TextInput) -> Self {
        match text {
            TextInput::Utf8(text) => text.into(),
            TextInput::Units { units } => JsText::from_units(units),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotInput {
    since_last: Number,
    seq: Number,
    last_saved_seq: Option<Number>,
    last_saved_at: Option<Number>,
}
impl From<SnapshotInput> for Rc<SnapshotState> {
    fn from(value: SnapshotInput) -> Self {
        Rc::new(SnapshotState {
            since_last: value.since_last.value().into(),
            seq: value.seq.value().into(),
            last_saved_seq: value.last_saved_seq.map(Number::value),
            last_saved_at: value.last_saved_at.map(Number::value),
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum LivePhase {
    Running,
    Stale,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialRun {
    phase: LivePhase,
    run_id: TextInput,
    started_at: Number,
    last_progress_at: Number,
    progress_seq: Number,
    snapshot: SnapshotInput,
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Script {
    Snapshot {
        every: Number,
        key: Option<TextInput>,
        initial: Option<SnapshotInput>,
        actions: Vec<SnapshotAction>,
    },
    MonitoredRun {
        stages: Vec<Value>,
        deadline_ms: Option<Number>,
        snapshot_every: Option<Number>,
        snapshot_key: Option<TextInput>,
        initial: Option<InitialRun>,
        lift: bool,
        actions: Vec<RunAction>,
    },
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SnapshotAction {
    Record {
        payload: Value,
        at: Number,
    },
    Force {
        payload: Value,
        at: Number,
    },
    Confirm {
        seq: Number,
        at: Number,
        settled_at: Number,
    },
    Boot,
    RequestLoad,
    Reset,
    RoundTrip,
    WriteOk {
        payload: Value,
        seq: Number,
        at: Number,
        settled_at: Number,
    },
    WriteErr {
        detail: Value,
        seq: Number,
        at: Number,
        settled_at: Number,
    },
    LoadOk {
        value: Value,
        settled_at: Number,
    },
    LoadErr {
        detail: Value,
        settled_at: Number,
    },
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum RunAction {
    Start {
        run_id: TextInput,
        at: Number,
    },
    Progress {
        payload: Value,
        at: Number,
    },
    Advance {
        payload: Value,
        at: Number,
        result: StageResultInput,
    },
    MarkStale,
    Cancel {
        at: Number,
    },
    Deadline {
        id: Option<TextInput>,
        at: Number,
    },
    Boot {
        at: Number,
    },
    Confirm {
        seq: Number,
        at: Number,
        settled_at: Number,
    },
    Reset,
    RoundTrip,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum StageResultInput {
    Ok,
    Fail { error: Value },
}
fn keys(value: &Value) -> Vec<String> {
    value.as_object().unwrap().keys().cloned().collect()
}
fn snapshot_msg(
    definition: &CmdDef<SnapshotWriteSpec<PlainData>>,
    seq: f64,
    at: f64,
    settled_at: f64,
    calls: &Calls,
) -> Settled<SnapshotWriteSpec<PlainData>> {
    let cmd = observe!(
        calls,
        CmdDef::from_record,
        definition,
        SnapshotWriteInput {
            key: "foreign/ack".into(),
            seq: seq.into(),
            at: at.into(),
            payload: Rc::new(PlainData::Null)
        }
    );
    observe!(
        calls,
        CmdDef::ok,
        definition,
        cmd,
        PlainData::Undefined,
        Some(settled_at)
    )
}
fn run_snapshot(
    every: f64,
    key: Option<JsText>,
    initial: Option<SnapshotInput>,
    actions: Vec<SnapshotAction>,
    calls: &Calls,
) -> Value {
    let knob = observe!(
        calls,
        snapshot::create_snapshot,
        SnapshotConfig { every, key }
    );
    let mut state = initial.map_or_else(|| observe!(calls, Snapshot::init, &knob), Rc::from);
    let row = |state: &Rc<SnapshotState>,
               commands: Vec<Value>,
               same: Option<bool>,
               unchanged: bool,
               event: Option<Value>| {
        let value = wire::snapshot(state);
        json!({"stateKeys":keys(&value),"state":value,"commands":commands,"sameState":same,"priorStateUnchanged":unchanged,"event":event})
    };
    let mut rows = vec![row(&state, vec![], None, true, None)];
    for action in actions {
        let before = wire::snapshot(&state);
        let mut event = None;
        let (next, commands) = match action {
            SnapshotAction::Record { payload, at } => {
                let step = observe!(
                    calls,
                    Snapshot::record,
                    &knob,
                    &state,
                    Rc::new(data(&payload)),
                    at.value()
                );
                (
                    step.state,
                    step.commands.iter().map(wire::snapshot).collect(),
                )
            }
            SnapshotAction::Force { payload, at } => {
                let step = observe!(
                    calls,
                    Snapshot::force,
                    &knob,
                    &state,
                    Rc::new(data(&payload)),
                    at.value()
                );
                (
                    step.state,
                    step.commands.iter().map(wire::snapshot).collect(),
                )
            }
            SnapshotAction::Confirm {
                seq,
                at,
                settled_at,
            } => {
                let msg = snapshot_msg(
                    &knob.write,
                    seq.value(),
                    at.value(),
                    settled_at.value(),
                    calls,
                );
                event = Some(wire::snapshot(&msg));
                let step = observe!(calls, Snapshot::confirm, &knob, &state, &msg);
                (step.state, vec![])
            }
            SnapshotAction::Boot => {
                let step = observe!(calls, Snapshot::boot, &knob, &state);
                (step.state, vec![])
            }
            SnapshotAction::RequestLoad => {
                let step = observe!(calls, Snapshot::request_load, &knob, &state);
                (
                    step.state,
                    step.commands.iter().map(wire::snapshot).collect(),
                )
            }
            SnapshotAction::Reset => (observe!(calls, Snapshot::init, &knob), vec![]),
            SnapshotAction::RoundTrip => {
                let encoded = observe!(
                    calls,
                    stringify_json,
                    &observe!(calls, plain_data, &state).unwrap()
                )
                .unwrap();
                (Rc::new(serde_json::from_str(&encoded).unwrap()), vec![])
            }
            SnapshotAction::WriteOk {
                payload,
                seq,
                at,
                settled_at,
            } => {
                let def = observe!(calls, snapshot::snapshot_write_def);
                let cmd = observe!(
                    calls,
                    CmdDef::from_record,
                    &def,
                    SnapshotWriteInput {
                        key: "definition".into(),
                        seq: seq.value().into(),
                        at: at.value().into(),
                        payload: Rc::new(data(&payload))
                    }
                );
                event = Some(wire::snapshot(&observe!(
                    calls,
                    CmdDef::ok,
                    &def,
                    cmd,
                    PlainData::Undefined,
                    Some(settled_at.value())
                )));
                (Rc::clone(&state), vec![])
            }
            SnapshotAction::WriteErr {
                detail,
                seq,
                at,
                settled_at,
            } => {
                let def = observe!(calls, snapshot::snapshot_write_def::<PlainData>);
                let cmd = observe!(
                    calls,
                    CmdDef::from_record,
                    &def,
                    SnapshotWriteInput {
                        key: "definition".into(),
                        seq: seq.value().into(),
                        at: at.value().into(),
                        payload: Rc::new(PlainData::Null)
                    }
                );
                let failure = SnapshotFailure(PlainData::Object(
                    [
                        (
                            "_tag".into(),
                            PlainData::String("snapshot_write_failed".into()),
                        ),
                        ("detail".into(), data(&detail)),
                    ]
                    .into_iter()
                    .collect(),
                ));
                event = Some(wire::snapshot(&observe!(
                    calls,
                    CmdDef::err,
                    &def,
                    cmd,
                    failure,
                    Some(settled_at.value())
                )));
                (Rc::clone(&state), vec![])
            }
            SnapshotAction::LoadOk { value, settled_at } => {
                let def = observe!(calls, snapshot::snapshot_load_def::<PlainData>);
                let cmd = observe!(
                    calls,
                    CmdDef::from_record,
                    &def,
                    snapshot::SnapshotLoadInput {
                        key: "definition".into()
                    }
                );
                let value = (!value.is_null()).then(|| Rc::new(data(&value)));
                event = Some(wire::snapshot(&observe!(
                    calls,
                    CmdDef::ok,
                    &def,
                    cmd,
                    value,
                    Some(settled_at.value())
                )));
                (Rc::clone(&state), vec![])
            }
            SnapshotAction::LoadErr { detail, settled_at } => {
                let def = observe!(calls, snapshot::snapshot_load_def::<PlainData>);
                let cmd = observe!(
                    calls,
                    CmdDef::from_record,
                    &def,
                    snapshot::SnapshotLoadInput {
                        key: "definition".into()
                    }
                );
                let failure = SnapshotFailure(PlainData::Object(
                    [
                        (
                            "_tag".into(),
                            PlainData::String("snapshot_load_failed".into()),
                        ),
                        ("detail".into(), data(&detail)),
                    ]
                    .into_iter()
                    .collect(),
                ));
                event = Some(wire::snapshot(&observe!(
                    calls,
                    CmdDef::err,
                    &def,
                    cmd,
                    failure,
                    Some(settled_at.value())
                )));
                (Rc::clone(&state), vec![])
            }
        };
        let unchanged = before == wire::snapshot(&state);
        let same = Rc::ptr_eq(&state, &next);
        state = next;
        rows.push(row(&state, commands, Some(same), unchanged, event));
    }
    json!(rows)
}
struct Host {
    run: Rc<MonitoredRunState<PlainData>>,
    marker: Rc<()>,
}
fn run_monitor(
    config: MonitoredRunConfig<PlainData>,
    initial: Option<InitialRun>,
    lift: bool,
    actions: Vec<RunAction>,
    calls: &Calls,
) -> Value {
    let knob = observe!(calls, monitor::create_monitored_run, config);
    let mut state = observe!(calls, MonitoredRun::init, &knob);
    if let Some(initial) = initial {
        let run_id = JsText::from(initial.run_id);
        state = observe!(
            calls,
            MonitoredRun::start,
            &knob,
            &state,
            run_id.clone(),
            initial.started_at.value()
        )
        .state;
        let state = Rc::make_mut(&mut state);
        state.phase = match initial.phase {
            LivePhase::Running => RunPhase::Running { run_id },
            LivePhase::Stale => RunPhase::Stale { run_id },
        };
        state.core.last_progress_at = initial.last_progress_at.value().into();
        state.core.progress_seq = initial.progress_seq.value().into();
        state.core.snapshot = Rc::from(initial.snapshot);
    }
    let checkpoint = observe!(calls, MonitoredRun::checkpoint, &knob);
    let marker = Rc::new(());
    let row = |state: &Rc<MonitoredRunState<PlainData>>,
               commands: Vec<Value>,
               same: Option<bool>,
               same_snapshot: Option<bool>,
               unchanged: bool,
               event: Option<Value>| {
        let deadlines = observe!(calls, MonitoredRun::deadlines, &knob, state);
        let timer = observe!(calls, MonitoredRun::timer, &knob, state);
        let value = wire::snapshot(state);
        let failure_keys = value.get("failure").map_or_else(Vec::new, keys);
        json!({"stateKeys":keys(&value),"failureKeys":failure_keys,"state":value,"commands":commands,"sameState":same,"sameSnapshot":same_snapshot,"priorStateUnchanged":unchanged,"event":event,
            "deadlines":deadlines.iter().map(|deadline|json!({"id":text(&deadline.id),"type":"deadline","atMs":wire::snapshot(&deadline.at_ms)})).collect::<Vec<_>>(),
            "timer":timer.map(|timer|json!({"ms":number(timer.ms),"msg":{"type":timer.msg.kind,"id":text(&timer.msg.id),"atMs":wire::snapshot(&timer.msg.at_ms)}}))})
    };
    let mut rows = vec![row(&state, vec![], None, None, true, None)];
    for action in actions {
        let before = wire::snapshot(&state);
        let mut event = None;
        let step = match action {
            RunAction::Start { run_id, at } => observe!(
                calls,
                MonitoredRun::start,
                &knob,
                &state,
                run_id,
                at.value()
            ),
            RunAction::Progress { payload, at } => observe!(
                calls,
                MonitoredRun::progress,
                &knob,
                &state,
                Rc::new(data(&payload)),
                at.value()
            ),
            RunAction::Advance {
                payload,
                at,
                result,
            } => observe!(
                calls,
                MonitoredRun::advance,
                &knob,
                &state,
                Rc::new(data(&payload)),
                match result {
                    StageResultInput::Ok => StageResult::Ok,
                    StageResultInput::Fail { error } => StageResult::Fail {
                        error: Rc::new(data(&error))
                    },
                },
                at.value()
            ),
            RunAction::MarkStale => observe!(calls, MonitoredRun::mark_stale, &knob, &state),
            RunAction::Cancel { at } => {
                observe!(calls, MonitoredRun::cancel, &knob, &state, at.value())
            }
            RunAction::Deadline { id, at } => {
                let id = id.map(JsText::from).unwrap_or_else(|| {
                    observe!(calls, MonitoredRun::deadlines, &knob, &state)
                        .first()
                        .map_or_else(|| "rogue".into(), |deadline| deadline.id.clone())
                });
                let msg = observe!(calls, deadline_exceeded, id, at.value(), None);
                event = Some(wire::snapshot(&msg));
                observe!(calls, MonitoredRun::on_deadline, &knob, &state, &msg)
            }
            RunAction::Boot { at } => {
                observe!(calls, MonitoredRun::boot, &knob, &state, at.value())
            }
            RunAction::Confirm {
                seq,
                at,
                settled_at,
            } => {
                let msg = snapshot_msg(
                    checkpoint,
                    seq.value(),
                    at.value(),
                    settled_at.value(),
                    calls,
                );
                event = Some(wire::snapshot(&msg));
                Step::new(
                    observe!(calls, MonitoredRun::confirm_snapshot, &knob, &state, &msg),
                    vec![],
                )
            }
            RunAction::Reset => Step::new(observe!(calls, MonitoredRun::init, &knob), vec![]),
            RunAction::RoundTrip => {
                let encoded = observe!(
                    calls,
                    stringify_json,
                    &observe!(calls, plain_data, &state).unwrap()
                )
                .unwrap();
                Step::new(Rc::new(serde_json::from_str(&encoded).unwrap()), vec![])
            }
        };
        let step = if lift {
            let host = Host {
                run: Rc::clone(&state),
                marker: Rc::clone(&marker),
            };
            let step = observe!(calls, monitor::lift_run, host, step, |host, run| Host {
                run,
                ..host
            });
            assert!(Rc::ptr_eq(&step.state.marker, &marker));
            Step::new(step.state.run, step.commands)
        } else {
            step
        };
        let unchanged = before == wire::snapshot(&state);
        let same = Rc::ptr_eq(&state, &step.state);
        let same_snapshot = Rc::ptr_eq(&state.snapshot, &step.state.snapshot);
        let commands = step.commands.iter().map(wire::snapshot).collect();
        state = step.state;
        rows.push(row(
            &state,
            commands,
            Some(same),
            Some(same_snapshot),
            unchanged,
            event,
        ));
    }
    json!(rows)
}
fn execute(script: Script) -> Value {
    let calls = Calls::new(vec![]);
    let comparison = match script {
        Script::Snapshot {
            every,
            key,
            initial,
            actions,
        } => run_snapshot(
            every.value(),
            key.map(JsText::from),
            initial,
            actions,
            &calls,
        ),
        Script::MonitoredRun {
            stages,
            deadline_ms,
            snapshot_every,
            snapshot_key,
            initial,
            lift,
            actions,
        } => run_monitor(
            MonitoredRunConfig {
                stages: stages.iter().map(|value| Rc::new(data(value))).collect(),
                deadline_ms: deadline_ms.map(Number::value),
                snapshot_every: snapshot_every.map(Number::value),
                snapshot_key: snapshot_key.map(JsText::from),
            },
            initial,
            lift,
            actions,
            &calls,
        ),
    };
    json!({"comparison":comparison,"observedRustCalls":*calls.borrow()})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let script: Script = serde_json::from_str(&line).expect("validated monitored-run script");
        println!("{}", execute(script));
    }
}
