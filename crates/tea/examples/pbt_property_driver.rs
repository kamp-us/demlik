#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The public PBT seam supports opaque local payloads and state handles."
)]
use demlik_tea::{
    Machine, Step, Sub, Tagged, Update,
    core::Row,
    pbt::{self, FailedCase, InvariantFailure, PropertyFailure, PropertyOptions, SequenceOptions},
};
use proptest::strategy::{Just, Strategy};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead},
    rc::Rc,
    sync::Arc,
};
#[path = "pbt_property_driver/invoice.rs"]
mod invoice;
#[expect(
    dead_code,
    reason = "This driver uses only numbers from the shared parity wire module; sibling drivers use its other projections."
)]
#[path = "../../parity/src/paginate_queue/wire.rs"]
mod wire;
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{$calls.borrow_mut().push(stringify!($function));$function($($arg),*)}};}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Form {
    Reducer,
    Transitions,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Init,
    Subs,
    Update,
}
impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Init => "init",
            Self::Subs => "subs",
            Self::Update => "update",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Seed {
    n: wire::Number,
    done: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Predicate {
    kind: PredicateKind,
    at: usize,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum PredicateKind {
    True,
    False,
    Error,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Add { by: wire::Number },
    Post { by: wire::Number },
    Noop,
    Finish,
    Unknown,
    Reuse { index: usize },
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Property,
    Sequence,
}
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Check {
    #[default]
    Invariant,
    Terminates,
    Trace,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Script {
    #[serde(default)]
    check: Check,
    kind: Kind,
    form: Form,
    loaded: Option<Seed>,
    init_delta: wire::Number,
    boot_command: bool,
    terminal_refuses: bool,
    fail: Option<Phase>,
    predicate: Predicate,
    runs: Option<u32>,
    messages: Option<Vec<Action>>,
    tail: Option<usize>,
    prefix: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    input: Script,
}
struct Payload {
    _opaque: Box<dyn Fn()>,
}
struct State {
    n: f64,
    done: bool,
    payload: Rc<Payload>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        if self.done { "done" } else { "active" }
    }
}
struct Msg {
    kind: &'static str,
    by: Option<f64>,
    payload: Rc<Payload>,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        self.kind
    }
}
impl std::fmt::Debug for Msg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Msg")
            .field("kind", &self.kind)
            .field("by", &self.by)
            .finish()
    }
}
struct Cmd {
    kind: &'static str,
    n: f64,
    payload: Rc<Payload>,
}
struct AppError {
    cause: Rc<Payload>,
}
struct Panic {
    _opaque: Box<dyn Fn() + Send + Sync>,
}
type Log = Rc<RefCell<Vec<Value>>>;
fn state(s: &State) -> Value {
    json!({"type":s.tag(),"n":wire::number(s.n)})
}
fn row<'a>(
    log: &Log,
    updates: &Rc<Cell<usize>>,
    cause: &Arc<Panic>,
    fail: Option<Phase>,
    empty: bool,
) -> Row<'a, Arc<State>, Msg, Cmd> {
    let mut row = Row::new();
    if !empty {
        for kind in ["add", "finish", "noop", "post"] {
            let log = Rc::clone(log);
            let updates = Rc::clone(updates);
            let cause = Arc::clone(cause);
            let cell: demlik_tea::core::Cell<'a, Arc<State>, Msg, Cmd> = Box::new(move |s, m| {
                log.borrow_mut()
                    .push(json!(["update", s.tag(), wire::number(s.n), m.kind]));
                updates.set(updates.get() + 1);
                if fail == Some(Phase::Update) {
                    std::panic::panic_any(Arc::clone(&cause));
                }
                if m.kind == "noop" {
                    return Step::new(Arc::clone(s), vec![]);
                }
                if m.kind == "finish" {
                    return Step::new(
                        Arc::new(State {
                            n: s.n,
                            done: true,
                            payload: Rc::clone(&s.payload),
                        }),
                        vec![],
                    );
                }
                let n = s.n + m.by.unwrap_or(0.0);
                Step::new(
                    Arc::new(State {
                        n,
                        done: s.done,
                        payload: Rc::clone(&m.payload),
                    }),
                    vec![Cmd {
                        kind: "observed",
                        n,
                        payload: Rc::clone(&m.payload),
                    }],
                )
            });
            row.insert(kind.into(), cell);
        }
    }
    row
}
fn execute(case: Case) -> Value {
    let calls = Calls::default();
    let script = case.input;
    let log = Log::default();
    let checks = Log::default();
    let runs = Rc::new(Cell::new(0));
    let updates = Rc::new(Cell::new(0));
    let index = Cell::new(0);
    let boot_state = RefCell::new(None::<Arc<State>>);
    let payload = Rc::new(Payload {
        _opaque: Box::new(|| {}),
    });
    let error_cause = Rc::new(Payload {
        _opaque: Box::new(|| {}),
    });
    let panic = Arc::new(Panic {
        _opaque: Box::new(|| {}),
    });
    let loaded = script.loaded.map(|s| {
        Arc::new(State {
            n: s.n.value(),
            done: s.done,
            payload: Rc::clone(&payload),
        })
    });
    let mut fixed = Vec::<Arc<Msg>>::new();
    for action in script.messages.unwrap_or_default() {
        let (kind, by) = match action {
            Action::Add { by } => ("add", Some(by.value())),
            Action::Post { by } => ("post", Some(by.value())),
            Action::Noop => ("noop", None),
            Action::Finish => ("finish", None),
            Action::Unknown => ("unknown", None),
            Action::Reuse { index } => {
                fixed.push(Arc::clone(&fixed[index]));
                continue;
            }
        };
        fixed.push(Arc::new(Msg {
            kind,
            by,
            payload: Rc::clone(&payload),
        }));
    }
    let prefix = (0..script.prefix.unwrap_or(0))
        .map(|_| {
            Arc::new(Msg {
                kind: "add",
                by: Some(1.0),
                payload: Rc::clone(&payload),
            })
        })
        .collect::<Vec<_>>();
    let tail = Arc::new(Msg {
        kind: "add",
        by: Some(2.0),
        payload: Rc::clone(&payload),
    });
    let expected = if script.kind == Kind::Property {
        fixed.clone()
    } else {
        prefix
            .iter()
            .cloned()
            .chain((0..script.tail.unwrap()).map(|_| Arc::clone(&tail)))
            .collect()
    };
    let strategy = if script.kind == Kind::Property {
        Just(fixed).boxed()
    } else {
        observe!(
            calls,
            pbt::msg_sequence,
            Just(tail),
            SequenceOptions {
                tail: (script.tail.unwrap()..=script.tail.unwrap()).into(),
                prefix
            }
        )
        .boxed()
    };
    let update = if script.form == Form::Reducer {
        Update::raw_reducer(row(&log, &updates, &panic, script.fail, false))
    } else {
        let mut rows = indexmap::IndexMap::new();
        rows.insert(
            "active".into(),
            row(&log, &updates, &panic, script.fail, false),
        );
        rows.insert(
            "done".into(),
            row(&log, &updates, &panic, script.fail, script.terminal_refuses),
        );
        Update::raw_transitions(rows)
    };
    let machine: Machine<'_, Arc<State>, Msg, Cmd, Sub> = Machine {
        init: Box::new(|loaded, _| {
            runs.set(runs.get() + 1);
            index.set(0);
            log.borrow_mut().push(json!([
                "init",
                loaded.as_ref().map(|s: &Arc<State>| state(s))
            ]));
            if script.fail == Some(Phase::Init) {
                std::panic::panic_any(Arc::clone(&panic));
            }
            let mut s = loaded.unwrap_or_else(|| {
                Arc::new(State {
                    n: 0.0,
                    done: false,
                    payload: Rc::clone(&payload),
                })
            });
            let delta = script.init_delta.value();
            if delta != 0.0 {
                s = Arc::new(State {
                    n: s.n + delta,
                    done: s.done,
                    payload: Rc::clone(&s.payload),
                });
            }
            let commands = if script.boot_command {
                vec![Cmd {
                    kind: "boot",
                    n: s.n,
                    payload: Rc::clone(&payload),
                }]
            } else {
                vec![]
            };
            boot_state.replace(Some(Arc::clone(&s)));
            Step::new(s, commands)
        }),
        update,
        subscriptions: demlik_tea::core::subscriptions(|s: &Arc<State>| {
            log.borrow_mut()
                .push(json!(["subs", s.tag(), wire::number(s.n)]));
            if script.fail == Some(Phase::Subs) {
                std::panic::panic_any(Arc::clone(&panic));
            }
            vec![]
        }),
    };
    let step_view = |step: &pbt::FoldStep<Arc<State>, Msg, Cmd>, at: usize| {
        let mut message = json!({"type":step.msg.kind});
        if let Some(by) = step.msg.by {
            message["by"] = wire::number(by);
        }
        json!({"index":at,"prev":state(&step.prev),"next":state(&step.next),"msg":message,"commands":step.commands.iter().map(|c|json!({"type":c.kind,"n":wire::number(c.n),"samePayload":Rc::ptr_eq(&c.payload,&payload)})).collect::<Vec<_>>(),"sameState":Arc::ptr_eq(step.prev.as_ref(),step.next.as_ref()),"sameInput":Arc::ptr_eq(&step.msg,&expected[at]),"sameAsPrevious":at>0&&Arc::ptr_eq(&step.msg,&expected[at-1]),"samePayload":Rc::ptr_eq(&step.msg.payload,&payload),"fullFoldComplete":updates.get()==runs.get()*expected.len()})
    };
    let final_view = |s: &Arc<State>| json!({"state":state(s),"samePayload":Rc::ptr_eq(&s.payload,&payload),"sameBoot":boot_state.borrow().as_ref().is_some_and(|boot|Arc::ptr_eq(boot,s)),"fullFoldComplete":updates.get()==runs.get()*expected.len()});
    let predicate = || match script.predicate.kind {
        PredicateKind::False => Ok(false),
        PredicateKind::Error => Err(AppError {
            cause: Rc::clone(&error_cause),
        }),
        PredicateKind::True => Ok(true),
    };
    let options = PropertyOptions {
        num_runs: script
            .runs
            .unwrap_or_else(|| PropertyOptions::default().num_runs),
        seed: Some(42),
    };
    let result = match script.check {
        Check::Invariant => observe!(
            calls,
            pbt::property_invariant,
            &machine,
            &(),
            &strategy,
            || loaded.clone(),
            |step| {
                let at = index.get();
                index.set(at + 1);
                log.borrow_mut().push(json!(["check", at]));
                checks.borrow_mut().push(step_view(step, at));
                if at == script.predicate.at {
                    predicate()
                } else {
                    Ok(true)
                }
            },
            options
        ),
        Check::Terminates => observe!(
            calls,
            pbt::property_terminates,
            &machine,
            &(),
            &strategy,
            || loaded.clone(),
            |s| {
                log.borrow_mut().push(json!(["terminal"]));
                checks.borrow_mut().push(final_view(s));
                predicate()
            },
            options
        ),
        Check::Trace => observe!(
            calls,
            pbt::property_trace,
            &machine,
            &(),
            &strategy,
            || loaded.clone(),
            |steps, final_state| {
                log.borrow_mut().push(json!(["trace"]));
                checks.borrow_mut().push(json!({
                    "steps": steps.iter().enumerate().map(|(i,s)|step_view(s,i)).collect::<Vec<_>>(),
                    "final": final_view(final_state),
                    "finalIsLast": steps.last().is_none_or(|s|std::ptr::eq(s.next.as_ref(),final_state)),
                    "links": steps.windows(2).all(|s|Arc::ptr_eq(&s[0].next,&s[1].prev))
                }));
                predicate()
            },
            options
        ),
    };
    let mut diagnostics = json!(null);
    let (status, failure) = match result {
        Ok(()) => ("ok", json!(null)),
        Err(error) => {
            diagnostics["debug"] = json!(format!("{error:?}"));
            match error {
                PropertyFailure::Case { evaluated, .. } => match evaluated.failure {
                    FailedCase::Invariant {
                        trace,
                        step,
                        failure,
                    } => {
                        diagnostics["retainedMessages"] = json!(
                            evaluated
                                .messages
                                .iter()
                                .map(|m| m.kind)
                                .collect::<Vec<_>>()
                        );
                        diagnostics["traceLinksOriginal"] = json!(
                            trace
                                .steps
                                .iter()
                                .zip(&evaluated.messages)
                                .all(|(s, m)| Arc::ptr_eq(&s.msg, m))
                        );
                        let status = match failure {
                            InvariantFailure::False => "false",
                            InvariantFailure::Error(error) => {
                                diagnostics["originalErrorIdentity"] =
                                    json!(Rc::ptr_eq(&error.cause, &error_cause));
                                "callback"
                            }
                            InvariantFailure::Panic(_) => panic!("not scripted"),
                        };
                        (status, json!({"phase":"invariant","step":step}))
                    }
                    FailedCase::FoldRefused(error) => {
                        diagnostics["refusal"] = json!(error);
                        (
                            "refusal",
                            json!({"phase":"fold","msg":error.msg_type,"state":error.state_name}),
                        )
                    }
                    FailedCase::FoldPanic(cause) => {
                        diagnostics["originalPanicIdentity"] = json!(cause.with_payload(|p| {
                            p.downcast_ref::<Arc<Panic>>()
                                .is_some_and(|actual| Arc::ptr_eq(actual, &panic))
                        }));
                        ("callback", json!({"phase":script.fail.unwrap().name()}))
                    }
                    FailedCase::Terminates { trace, failure }
                    | FailedCase::Trace { trace, failure } => {
                        diagnostics["retainedMessages"] = json!(
                            evaluated
                                .messages
                                .iter()
                                .map(|m| m.kind)
                                .collect::<Vec<_>>()
                        );
                        diagnostics["traceLinksOriginal"] = json!(
                            trace
                                .steps
                                .iter()
                                .zip(&evaluated.messages)
                                .all(|(s, m)| Arc::ptr_eq(&s.msg, m))
                        );
                        let status = match failure {
                            InvariantFailure::False => "false",
                            InvariantFailure::Error(error) => {
                                diagnostics["originalErrorIdentity"] =
                                    json!(Rc::ptr_eq(&error.cause, &error_cause));
                                "callback"
                            }
                            InvariantFailure::Panic(_) => panic!("not scripted"),
                        };
                        (status, json!({"phase":"predicate"}))
                    }
                    FailedCase::LoadedPanic(_) => panic!("not scripted"),
                },
                other => panic!("unexpected {other:?}"),
            }
        }
    };
    json!({"id":case.id,"comparison":{"status":status,"runs":runs.get(),"updates":updates.get(),"log":log.borrow().clone(),"checks":checks.borrow().clone(),"failure":failure},"diagnostics":diagnostics,"observedRustCalls":calls.borrow().clone()})
}
fn main() {
    if std::env::args().any(|a| a == "--no-files") {
        let before = std::fs::read_dir(".")
            .unwrap()
            .map(|f| {
                f.unwrap()
                    .file_name()
                    .into_string()
                    .expect("controlled UTF-8 test filenames")
            })
            .collect::<Vec<_>>();
        let case:Case=serde_json::from_str(r#"{"id":"native.no-files","input":{"kind":"property","form":"reducer","initDelta":0,"bootCommand":true,"terminalRefuses":false,"predicate":{"kind":"false","at":0},"runs":1,"messages":[{"op":"add","by":1}]}}"#).unwrap();
        let output = execute(case);
        let after = std::fs::read_dir(".")
            .unwrap()
            .map(|f| {
                f.unwrap()
                    .file_name()
                    .into_string()
                    .expect("controlled UTF-8 test filenames")
            })
            .collect::<Vec<_>>();
        println!(
            "{}",
            json!({"before":before,"after":after,"sameFiles":before==after,"actual":output})
        );
        return;
    }
    let invoice = std::env::args().any(|a| a == "--invoice");
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if !line.trim().is_empty() {
            let output = if invoice {
                invoice::execute(serde_json::from_str(&line).unwrap())
            } else {
                execute(serde_json::from_str(&line).unwrap())
            };
            println!("{output}");
        }
    }
}
