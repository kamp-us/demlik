use super::{Calls, observe};
use demlik_tea::{ApplyError, Machine, NoCellError, Step, Sub, Tagged, TryUpdate, core::Row};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    sync::Arc,
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verb {
    Updates,
    UpdatesShared,
    Msgs,
    MsgsShared,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scenario {
    Empty,
    Ordered,
    RejectFirst,
    RejectMiddle,
    MissingFirst,
    MissingMiddle,
    NestedNoCell,
    Panic,
}
struct Cause;
struct Failure {
    cause: Rc<Cause>,
    nested: Option<NoCellError>,
}
struct Model {
    n: i64,
    owner: Rc<Cause>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
enum Msg {
    Add(i64),
    Reject,
    Unknown,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Add(_) => "add",
            Self::Reject => "reject",
            Self::Unknown => "unknown",
        }
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["add", "reject", "unknown"];
}
struct Cmd(i64);

fn messages(scenario: Scenario) -> Vec<Msg> {
    match scenario {
        Scenario::Empty => vec![],
        Scenario::Ordered => vec![Msg::Add(2), Msg::Add(3), Msg::Add(-1)],
        Scenario::RejectFirst | Scenario::NestedNoCell | Scenario::Panic => {
            vec![Msg::Reject, Msg::Add(99)]
        }
        Scenario::RejectMiddle => vec![Msg::Add(2), Msg::Reject, Msg::Add(99)],
        Scenario::MissingFirst => vec![Msg::Unknown, Msg::Add(99)],
        Scenario::MissingMiddle => vec![Msg::Add(2), Msg::Unknown, Msg::Add(99)],
    }
}
fn add(state: &Model, msg: &Msg, trace: &RefCell<Vec<String>>) -> Step<Model, Cmd> {
    let Msg::Add(by) = msg else {
        panic!("add cell received another tag")
    };
    trace.borrow_mut().push(format!("add:{}", state.n));
    let n = state.n + by;
    Step::new(
        Model {
            n,
            owner: Rc::clone(&state.owner),
        },
        vec![Cmd(n)],
    )
}
#[expect(
    clippy::arc_with_non_send_sync,
    reason = "Shared pure folds explicitly accept retained local opaque values."
)]
pub fn execute(verb: Verb, scenario: Scenario, calls: &Calls) -> Value {
    let trace = Rc::new(RefCell::new(vec![]));
    let cause = Rc::new(Cause);
    let update = if matches!(scenario, Scenario::MissingFirst | Scenario::MissingMiddle) {
        let log = Rc::clone(&trace);
        let mut row: Row<'static, Model, Msg, Cmd> = Row::new();
        row.insert("add".into(), Box::new(move |s, m| add(s, m, &log)));
        TryUpdate::RawReducer(row)
    } else {
        let log = Rc::clone(&trace);
        let original = Rc::clone(&cause);
        TryUpdate::try_reducer(move |state: &Model, msg: &Msg| match msg {
            Msg::Add(_) => Ok(add(state, msg, &log)),
            Msg::Reject => {
                log.borrow_mut().push(format!("reject:{}", state.n));
                if matches!(scenario, Scenario::Panic) {
                    panic!("reducer boundary panic")
                }
                Err(Failure {
                    cause: Rc::clone(&original),
                    nested: matches!(scenario, Scenario::NestedNoCell).then(|| {
                        NoCellError::new("child-missing", "child", vec!["child-ok".into()])
                    }),
                })
            }
            Msg::Unknown => panic!("unknown message reached exhaustive fixture"),
        })
    };
    let machine: Machine<'_, Model, Msg, Cmd, Sub, (), Failure> = Machine {
        init: Box::new(|_, _| panic!("update-only fold called init")),
        update,
        subscriptions: demlik_tea::core::try_subscriptions(|_| {
            panic!("update-only fold selected subscriptions")
        }),
    };
    let seed = Arc::new(Model {
        n: 5,
        owner: Rc::clone(&cause),
    });
    let shared = matches!(verb, Verb::UpdatesShared | Verb::MsgsShared);
    let state_only = matches!(verb, Verb::Msgs | Verb::MsgsShared);
    let result = catch_unwind(AssertUnwindSafe(|| {
        let msgs = messages(scenario);
        match verb {
            Verb::Updates => observe!(
                calls,
                demlik_tea::try_fold_updates,
                &machine.update,
                Model {
                    n: 5,
                    owner: Rc::clone(&cause)
                },
                msgs
            )
            .map(|step| {
                (
                    step.state.n,
                    Some(
                        step.commands
                            .into_iter()
                            .map(|cmd| cmd.0)
                            .collect::<Vec<_>>(),
                    ),
                    Rc::ptr_eq(&step.state.owner, &cause),
                    Value::Null,
                )
            }),
            Verb::Msgs => observe!(
                calls,
                demlik_tea::try_fold_msgs,
                &machine,
                Model {
                    n: 5,
                    owner: Rc::clone(&cause)
                },
                msgs
            )
            .map(|state| (state.n, None, Rc::ptr_eq(&state.owner, &cause), Value::Null)),
            Verb::UpdatesShared => observe!(
                calls,
                demlik_tea::try_fold_updates_shared,
                &machine.update,
                Arc::clone(&seed),
                msgs.into_iter().map(Arc::new)
            )
            .map(|step| {
                (
                    step.state.n,
                    Some(
                        step.commands
                            .into_iter()
                            .map(|cmd| cmd.0)
                            .collect::<Vec<_>>(),
                    ),
                    Rc::ptr_eq(&step.state.owner, &cause),
                    json!(Arc::ptr_eq(&step.state, &seed)),
                )
            }),
            Verb::MsgsShared => observe!(
                calls,
                demlik_tea::try_fold_msgs_shared,
                &machine,
                Arc::clone(&seed),
                msgs.into_iter().map(Arc::new)
            )
            .map(|state| {
                (
                    state.n,
                    None,
                    Rc::ptr_eq(&state.owner, &cause),
                    json!(Arc::ptr_eq(&state, &seed)),
                )
            }),
        }
    }));
    // A panic leaves the normal function-return observation absent; record the
    // actual wrapper call separately rather than invent a successful result.
    if result.is_err() {
        calls.borrow_mut().push("std::panic::catch_unwind");
    }
    let (outcome, profile) = match result {
        Ok(Ok((n, cmds, owner, seed_same))) => (
            json!({"ok":true,"n":n,"cmds":cmds,"owner":owner,"seedSame":seed_same}),
            json!(null),
        ),
        Ok(Err(ApplyError::NoCell(error))) => (
            json!({"ok":false,"kind":"lookup","error":error}),
            json!({"category":"NoCellError"}),
        ),
        Ok(Err(ApplyError::Reduce(error))) => {
            let kind = if error.nested.is_some() {
                "nested-no-cell"
            } else {
                "declared"
            };
            (
                json!({"ok":false,"kind":kind,"sameOriginal":Rc::ptr_eq(&error.cause,&cause),"nested":error.nested}),
                json!({"category":"ApplyError::Reduce"}),
            )
        }
        Err(_) => (
            json!({"ok":false,"kind":"panic","message":"reducer boundary panic"}),
            json!({"category":"native-panic"}),
        ),
    };
    json!({"comparison":{"outcome":outcome,"trace":*trace.borrow(),"seedN":seed.n,"init":0,"subs":0,"effects":0,"shared":shared,"stateOnly":state_only},"errorProfile":profile})
}
