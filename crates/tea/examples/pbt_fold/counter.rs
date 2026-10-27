use super::{Calls, wire};
use demlik_tea::{Machine, PlainData, Step, Sub, Tagged, Update, core::Row, pbt::fold_events};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    sync::Arc,
};
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Form {
    Reducer,
    Transitions,
    Disambiguated,
}
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Init,
    Subs,
    Update,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Script {
    form: Form,
    loaded: Option<Initial>,
    init_delta: wire::Number,
    boot_command: bool,
    subs: u8,
    fail: Option<Phase>,
    terminal_refuses: bool,
    messages: Vec<Action>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Initial {
    done: bool,
    n: wire::Number,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Add { by: wire::Number },
    Noop,
    Finish,
    Post { by: wire::Number },
    Explode,
    Unknown,
    Reuse { index: usize },
}
#[derive(Clone, Copy)]
enum Kind {
    Add,
    Noop,
    Finish,
    Post,
    Explode,
    Unknown,
}
impl Kind {
    fn tag(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Noop => "noop",
            Self::Finish => "finish",
            Self::Post => "post",
            Self::Explode => "explode",
            Self::Unknown => "unknown",
        }
    }
}
struct Msg {
    kind: Kind,
    by: Option<f64>,
    payload: Rc<PlainData>,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        self.kind.tag()
    }
}
struct State {
    n: f64,
    done: bool,
    payload: Rc<PlainData>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        if self.done { "done" } else { "active" }
    }
}
struct Cmd {
    kind: &'static str,
    n: f64,
    payload: Rc<PlainData>,
}
struct Cause {
    phase: &'static str,
    code: u32,
    _capability: Box<dyn Fn() + Send + Sync>,
}
type Log = Rc<RefCell<Vec<Value>>>;
fn state(s: &State) -> Value {
    json!({"type":s.tag(),"n":wire::number(s.n),"payload":wire::normalized(&s.payload)})
}
fn message(m: &Msg) -> Value {
    json!({"type":m.tag(),"by":m.by.map(wire::number).unwrap_or(json!({"$undefined":true})),"payload":wire::normalized(&m.payload)})
}
fn cmd(c: &Cmd, p: &Rc<PlainData>) -> Value {
    json!({"type":c.kind,"n":wire::number(c.n),"payload":wire::normalized(&c.payload),"samePayload":Rc::ptr_eq(&c.payload,p)})
}
fn id(ids: &mut BTreeMap<usize, usize>, pointer: usize) -> usize {
    let next = ids.len();
    *ids.entry(pointer).or_insert(next)
}
#[allow(
    clippy::arc_with_non_send_sync,
    reason = "Local source-parity traces retain original non-Send state/message handles through the public Arc seam."
)]
fn advance(
    s: &Arc<State>,
    m: &Msg,
    log: &Log,
    cause: &Arc<Cause>,
    fail: Option<Phase>,
) -> Step<Arc<State>, Cmd> {
    log.borrow_mut()
        .push(json!(["cell", s.tag(), wire::number(s.n), m.tag()]));
    if fail == Some(Phase::Update) || matches!(m.kind, Kind::Explode) {
        std::panic::panic_any(Arc::clone(cause));
    }
    match m.kind {
        Kind::Noop => Step::new(Arc::clone(s), vec![]),
        Kind::Finish => Step::new(
            Arc::new(State {
                n: s.n,
                done: true,
                payload: Rc::clone(&s.payload),
            }),
            vec![],
        ),
        Kind::Add | Kind::Post => {
            let n = s.n + m.by.unwrap();
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
        }
        _ => unreachable!(),
    }
}
fn row<'a>(
    log: &Log,
    cause: &Arc<Cause>,
    fail: Option<Phase>,
    empty: bool,
) -> Row<'a, Arc<State>, Msg, Cmd> {
    let mut rows = Row::new();
    if !empty {
        for key in ["add", "noop", "finish", "post", "explode"] {
            let log = Rc::clone(log);
            let cause = Arc::clone(cause);
            let cell: demlik_tea::core::Cell<'a, Arc<State>, Msg, Cmd> =
                Box::new(move |s, m| advance(s, m, &log, &cause, fail));
            rows.insert(key.into(), cell);
        }
    }
    rows
}
#[allow(
    clippy::arc_with_non_send_sync,
    reason = "Local source-parity traces retain original non-Send state/message handles through the public Arc seam."
)]
pub fn run(script: Script, calls: &Calls) -> Value {
    let log = Log::default();
    let payload = Rc::new(PlainData::from(&json!({"counter":"shared"})));
    let cause = Arc::new(Cause {
        phase: match script.fail {
            Some(Phase::Init) => "init",
            Some(Phase::Subs) => "subs",
            _ => "update",
        },
        code: 17,
        _capability: Box::new(|| {}),
    });
    let loaded = script.loaded.map(|s| {
        Arc::new(State {
            n: s.n.value(),
            done: s.done,
            payload: Rc::clone(&payload),
        })
    });
    let saved = loaded.clone();
    let mut messages = Vec::<Arc<Msg>>::new();
    for a in script.messages {
        let (kind, by) = match a {
            Action::Reuse { index } => {
                messages.push(Arc::clone(&messages[index]));
                continue;
            }
            Action::Add { by } => (Kind::Add, Some(by.value())),
            Action::Post { by } => (Kind::Post, Some(by.value())),
            Action::Noop => (Kind::Noop, None),
            Action::Finish => (Kind::Finish, None),
            Action::Explode => (Kind::Explode, None),
            Action::Unknown => (Kind::Unknown, None),
        };
        messages.push(Arc::new(Msg {
            kind,
            by,
            payload: Rc::clone(&payload),
        }));
    }
    let init_log = Rc::clone(&log);
    let init_payload = Rc::clone(&payload);
    let init_cause = Arc::clone(&cause);
    let subs_log = Rc::clone(&log);
    let subs_cause = Arc::clone(&cause);
    let fail = script.fail;
    let delta = script.init_delta.value();
    let count = script.subs;
    let update = match script.form {
        Form::Reducer => Update::raw_reducer(row(&log, &cause, fail, false)),
        Form::Transitions | Form::Disambiguated => Update::raw_transitions(
            [
                ("active".into(), row(&log, &cause, fail, false)),
                (
                    "done".into(),
                    row(&log, &cause, fail, script.terminal_refuses),
                ),
            ]
            .into_iter()
            .collect(),
        ),
    };
    let machine: Machine<'_, Arc<State>, Msg, Cmd, Sub<PlainData>> = Machine {
        init: Box::new(move |loaded, _| {
            init_log.borrow_mut().push(json!([
                "init",
                loaded.as_ref().map(|s: &Arc<State>| state(s))
            ]));
            if fail == Some(Phase::Init) {
                std::panic::panic_any(Arc::clone(&init_cause));
            }
            let s = loaded.unwrap_or_else(|| {
                Arc::new(State {
                    n: 0.0,
                    done: false,
                    payload: Rc::clone(&init_payload),
                })
            });
            let s = if delta == 0.0 {
                s
            } else {
                Arc::new(State {
                    n: s.n + delta,
                    done: s.done,
                    payload: Rc::clone(&s.payload),
                })
            };
            let cmds = if script.boot_command {
                vec![Cmd {
                    kind: "boot",
                    n: s.n,
                    payload: Rc::clone(&s.payload),
                }]
            } else {
                vec![]
            };
            Step::new(s, cmds)
        }),
        update,
        subscriptions: demlik_tea::core::subscriptions(move |s: &Arc<State>| {
            let mut subs = vec![];
            for index in 0..count {
                subs_log
                    .borrow_mut()
                    .push(json!(["subs", index, s.tag(), wire::number(s.n)]));
                if fail == Some(Phase::Subs) {
                    std::panic::panic_any(Arc::clone(&subs_cause));
                }
                subs.push(
                    Sub::new(
                        "watch",
                        PlainData::Object(
                            [("n".into(), PlainData::Number(s.n))].into_iter().collect(),
                        ),
                    )
                    .unwrap(),
                );
            }
            subs
        }),
    };
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        observe!(
            calls,
            fold_events,
            &machine,
            &(),
            loaded,
            messages.iter().cloned()
        )
    }));
    let events = log.borrow().clone();
    match outcome {
        Err(value) => {
            let actual = value.downcast_ref::<Arc<Cause>>().unwrap();
            json!({"status":"error","log":events,"error":{"kind":"callback","sameCause":Arc::ptr_eq(actual,&cause),"phase":actual.phase,"code":actual.code}})
        }
        Ok(Err(error)) => {
            json!({"status":"error","log":events,"error":{"kind":"refusal","value":wire::snapshot(&error)}})
        }
        Ok(Ok(trace)) => {
            let mut states = BTreeMap::new();
            if let Some(saved) = &saved {
                id(&mut states, Arc::as_ptr(saved) as usize);
            }
            let mut msg_ids = BTreeMap::new();
            let input_ids = messages
                .iter()
                .map(|m| id(&mut msg_ids, Arc::as_ptr(m) as usize))
                .collect::<Vec<_>>();
            let state_ids = trace
                .states
                .iter()
                .map(|s| id(&mut states, Arc::as_ptr(s.as_ref()) as usize))
                .collect::<Vec<_>>();
            let steps=trace.steps.iter().enumerate().map(|(i,t)|json!({"prev":id(&mut states,Arc::as_ptr(t.prev.as_ref())as usize),"next":id(&mut states,Arc::as_ptr(t.next.as_ref())as usize),"msgId":id(&mut msg_ids,Arc::as_ptr(&t.msg)as usize),"msg":message(&t.msg),"commands":t.commands.iter().map(|c|cmd(c,&payload)).collect::<Vec<_>>(),"sameState":Arc::ptr_eq(t.prev.as_ref(),t.next.as_ref()),"sameMsg":Arc::ptr_eq(&t.msg,&messages[i]),"prevLink":Arc::ptr_eq(&t.prev,&trace.states[i]),"nextLink":Arc::ptr_eq(&t.next,&trace.states[i+1])})).collect::<Vec<_>>();
            json!({"status":"ok","log":events,"inputMsgIds":input_ids,"states":trace.states.iter().zip(&state_ids).map(|(s,id)|json!({"id":id,"value":state(s),"samePayload":Rc::ptr_eq(&s.payload,&payload)})).collect::<Vec<_>>(),"steps":steps,"final":id(&mut states,Arc::as_ptr(trace.final_state.as_ref())as usize),"finalLink":Arc::ptr_eq(&trace.final_state,trace.states.last().unwrap())})
        }
    }
}
