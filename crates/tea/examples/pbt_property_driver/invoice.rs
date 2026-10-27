use demlik_tea::{
    Machine, Step, Tagged, Update,
    core::Row,
    flow::poller::{Poller, PollerConfig, PollerPhase, PollerState, create_poller},
    pbt::{self, FailedCase, PredicateFailure, PropertyFailure, PropertyOptions},
    resilience::deadline::{DeadlinesSub, deadlines_sub},
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    work_queue::QueueField,
};
use proptest::strategy::Just;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{$calls.push(stringify!($function));$function($($arg),*)}};}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Check {
    Terminates,
    Trace,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Seed {
    Fresh,
    Done,
    GaveUp,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Rule {
    Done,
    GaveUp,
    Provenance,
    False,
    Error,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Op {
    Start,
    Tick,
    Unpaid,
    Paid,
    Error,
    Noop,
    Unknown,
}
impl Op {
    fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Tick => "tick",
            Self::Unpaid => "unpaid",
            Self::Paid => "paid",
            Self::Error => "error",
            Self::Noop => "noop",
            Self::Unknown => "unknown",
        }
    }
}
#[derive(Deserialize)]
enum Kind {
    #[serde(rename = "invoice")]
    Invoice,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Script {
    kind: Kind,
    check: Check,
    loaded: Seed,
    rule: Rule,
    runs: u32,
    events: Vec<Op>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Case {
    id: String,
    input: Script,
}
struct Receipt {
    paid: bool,
    _capability: Box<dyn Fn()>,
}
struct Cause {
    _capability: Box<dyn Fn()>,
}
struct Command<'a> {
    invoice: &'a str,
    _capability: Box<dyn Fn() + 'a>,
}
struct Model {
    poll: Rc<PollerState<Receipt, Cause>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "invoice"
    }
}
struct Msg {
    op: Op,
    receipt: Rc<Receipt>,
    cause: Rc<Cause>,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        self.op.name()
    }
}
impl std::fmt::Debug for Msg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.tag())
    }
}
struct Context<'a> {
    invoice: &'a str,
}
fn view(s: &Model, paid: &Rc<Receipt>, unpaid: &Rc<Receipt>, cause: &Rc<Cause>) -> Value {
    let (result, identity) = match &s.poll.last_result {
        QueueField::Value(r) => (
            if r.paid { "paid" } else { "unpaid" },
            Rc::ptr_eq(r, paid) || Rc::ptr_eq(r, unpaid),
        ),
        _ => ("absent", true),
    };
    json!({"phase":s.poll.phase.as_str(),"tick":s.poll.tick.number(),"nextAt":match &s.poll.phase{PollerPhase::Polling{next_at_ms}=>next_at_ms.number(),_=>None},"result":result,"resultIdentity":identity,"attempt":s.poll.retry.attempt.number(),"errorIdentity":s.poll.retry.last_error.value().is_none_or(|e|Rc::ptr_eq(e,cause))})
}
pub(super) fn execute(case: Case) -> Value {
    let Script {
        kind: Kind::Invoice,
        check,
        loaded,
        rule,
        runs,
        events,
    } = case.input;
    let mut calls = vec![];
    let invoice = String::from("invoice-42");
    let paid = Rc::new(Receipt {
        paid: true,
        _capability: Box::new(|| {}),
    });
    let unpaid = Rc::new(Receipt {
        paid: false,
        _capability: Box::new(|| {}),
    });
    let cause = Rc::new(Cause {
        _capability: Box::new(|| {}),
    });
    let command = Rc::new(Command {
        invoice: &invoice,
        _capability: Box::new(|| {}),
    });
    let until_calls = Cell::new(0);
    let poller = create_poller::<Model, Receipt, Command<'_>, Cause, _>(
        PollerConfig::new(
            10.0,
            |_: &Model| {
                until_calls.set(until_calls.get() + 1);
                false
            },
            || Rc::clone(&command),
        )
        .with_retry(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 1.0,
                factor: 1.0,
                cap_ms: 1.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 1.0 },
        }),
    )
    .with_rng(|| 0.5);
    let seed = match loaded {
        Seed::Fresh => None,
        Seed::Done => Some(
            poller
                .tick_result(&poller.init(), Rc::clone(&paid), 0.0, true)
                .unwrap()
                .state,
        ),
        Seed::GaveUp => Some(
            poller
                .tick_err(&poller.init(), Rc::clone(&cause), 0.0)
                .state,
        ),
    }
    .map(|poll| Arc::new(Model { poll }));
    let expected = events
        .iter()
        .map(|op| {
            Arc::new(Msg {
                op: *op,
                receipt: if matches!(op, Op::Paid) {
                    Rc::clone(&paid)
                } else {
                    Rc::clone(&unpaid)
                },
                cause: Rc::clone(&cause),
            })
        })
        .collect::<Vec<_>>();
    let log = RefCell::new(Vec::new());
    let checks = RefCell::new(Vec::new());
    let inits = Cell::new(0);
    let updates = Cell::new(0);
    let boot = RefCell::new(None::<Arc<Model>>);
    let context = Context { invoice: &invoice };
    let mut row = Row::new();
    for op in [
        Op::Start,
        Op::Tick,
        Op::Unpaid,
        Op::Paid,
        Op::Error,
        Op::Noop,
    ] {
        row.insert(
            op.name().into(),
            Box::new(|s: &Arc<Model>, m: &Msg| {
                log.borrow_mut()
                    .push(json!(["update", s.poll.phase.as_str(), m.tag()]));
                updates.set(updates.get() + 1);
                let step = match m.op {
                    Op::Start => poller.start(&s.poll, 0.0),
                    Op::Tick => poller.tick(&s.poll),
                    Op::Paid | Op::Unpaid => poller
                        .tick_result(&s.poll, Rc::clone(&m.receipt), 1.0, m.receipt.paid)
                        .unwrap(),
                    Op::Error => poller.tick_err(&s.poll, Rc::clone(&m.cause), 1.0),
                    Op::Noop => Step::new(Rc::clone(&s.poll), vec![]),
                    Op::Unknown => unreachable!(),
                };
                Step::new(
                    if Rc::ptr_eq(&s.poll, &step.state) {
                        Arc::clone(s)
                    } else {
                        Arc::new(Model { poll: step.state })
                    },
                    step.commands,
                )
            }) as demlik_tea::core::Cell<'_, Arc<Model>, Msg, Rc<Command<'_>>>,
        );
    }
    let machine: Machine<'_, Arc<Model>, Msg, Rc<Command<'_>>, DeadlinesSub, Context<'_>> =
        Machine {
            init: Box::new(|loaded, ctx| {
                assert_eq!(ctx.invoice, command.invoice);
                inits.set(inits.get() + 1);
                log.borrow_mut().push(json!([
                    "init",
                    loaded.as_ref().map(|s| view(s, &paid, &unpaid, &cause))
                ]));
                let s = loaded.unwrap_or_else(|| {
                    Arc::new(Model {
                        poll: poller.init(),
                    })
                });
                boot.replace(Some(Arc::clone(&s)));
                Step::new(s, vec![Rc::clone(&command)])
            }),
            update: Update::raw_reducer(row),
            subscriptions: demlik_tea::core::subscriptions(|s: &Arc<Model>| {
                let list = poller.subs(&s.poll);
                log.borrow_mut()
                    .push(json!(["subs", s.poll.phase.as_str(), list.len()]));
                deadlines_sub(|_: &Arc<Model>| poller.subs(&s.poll))(s)
                    .unwrap()
                    .into_iter()
                    .collect()
            }),
        };
    let final_view = |s: &Arc<Model>| json!({"state":view(s,&paid,&unpaid,&cause),"sameBoot":boot.borrow().as_ref().is_some_and(|b|Arc::ptr_eq(b,s)),"fullFoldComplete":updates.get()==inits.get()*expected.len()});
    let predicate = |s: &Arc<Model>, provenance: bool| match rule {
        Rule::Done => Ok(matches!(s.poll.phase, PollerPhase::Done)),
        Rule::GaveUp => Ok(matches!(s.poll.phase, PollerPhase::GaveUp)),
        Rule::Provenance => Ok(provenance),
        Rule::False => Ok(false),
        Rule::Error => Err(Rc::clone(&cause)),
    };
    let strategy = Just(expected.clone());
    let options = PropertyOptions {
        num_runs: runs,
        seed: Some(42),
    };
    let result = match check {
        Check::Terminates => {
            observe!(
                calls,
                pbt::property_terminates,
                &machine,
                &context,
                &strategy,
                || seed.clone(),
                |s| {
                    log.borrow_mut().push(json!(["terminal"]));
                    checks.borrow_mut().push(final_view(s));
                    predicate(s, true)
                },
                options,
            )
        }
        Check::Trace => {
            observe!(
                calls,
                pbt::property_trace,
                &machine,
                &context,
                &strategy,
                || seed.clone(),
                |steps, s| {
                    log.borrow_mut().push(json!(["trace"]));
                    checks.borrow_mut().push(json!({"steps":steps.iter().enumerate().map(|(i,step)|json!({"msg":step.msg.tag(),"prev":view(&step.prev,&paid,&unpaid,&cause),"next":view(&step.next,&paid,&unpaid,&cause),"commands":step.commands.iter().map(|c|json!({"invoice":c.invoice,"sameCommand":Rc::ptr_eq(c,&command)})).collect::<Vec<_>>(),"sameState":Arc::ptr_eq(step.prev.as_ref(),step.next.as_ref()),"sameInput":Arc::ptr_eq(&step.msg,&expected[i])})).collect::<Vec<_>>(),"final":final_view(s),"links":steps.windows(2).all(|w|Arc::ptr_eq(&w[0].next,&w[1].prev)),"finalIsLast":steps.last().is_none_or(|last|std::ptr::eq(last.next.as_ref(),s))}));
                    let start = steps
                        .iter()
                        .rposition(|step| matches!(step.msg.op, Op::Start));
                    let provenance = !matches!(s.poll.phase, PollerPhase::Done)
                        || (matches!(loaded, Seed::Done) && start.is_none())
                        || steps
                            .iter()
                            .skip(start.map_or(0, |i| i + 1))
                            .any(|step| matches!(step.msg.op, Op::Paid));
                    predicate(s, provenance)
                },
                options,
            )
        }
    };
    let mut diagnostics = json!(null);
    let (status, failure) = match result {
        Ok(()) => ("ok", json!(null)),
        Err(PropertyFailure::Case { reason, evaluated }) => {
            diagnostics["reason"] = json!(reason);
            match evaluated.failure {
                FailedCase::Terminates { trace, failure }
                | FailedCase::Trace { trace, failure } => {
                    diagnostics["traceLinksOriginal"] = json!(
                        trace
                            .steps
                            .iter()
                            .zip(&evaluated.messages)
                            .all(|(s, m)| Arc::ptr_eq(&s.msg, m))
                    );
                    let status = match failure {
                        PredicateFailure::False => "false",
                        PredicateFailure::Error(error) => {
                            diagnostics["originalErrorIdentity"] =
                                json!(Rc::ptr_eq(&error, &cause));
                            "callback"
                        }
                        PredicateFailure::Panic(_) => panic!("not scripted"),
                    };
                    (status, json!({"phase":"predicate"}))
                }
                FailedCase::FoldRefused(error) => (
                    "refusal",
                    json!({"phase":"fold","msg":error.msg_type,"state":error.state_name}),
                ),
                _ => panic!("not scripted"),
            }
        }
        Err(error) => panic!("unexpected {error:?}"),
    };
    json!({"id":case.id,"comparison":{"status":status,"runs":inits.get(),"updates":updates.get(),"log":log.borrow().clone(),"checks":checks.borrow().clone(),"failure":failure,"untilCalls":until_calls.get()},"diagnostics":diagnostics,"observedRustCalls":calls})
}
