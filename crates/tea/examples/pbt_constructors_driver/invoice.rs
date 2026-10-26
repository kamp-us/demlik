use super::{Calls, runner, wire};
use demlik_tea::{
    Machine, Step, Tagged, Update,
    core::Row,
    flow::poller::{Poller, PollerConfig, PollerPhase, PollerState, create_poller},
    pbt::{
        FailedCase, FoldStep, PredicateFailure, PropertyFailure, PropertyOptions, SequenceOptions,
    },
    resilience::deadline::{DeadlinesSub, deadlines_sub},
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
};
use proptest::strategy::{Just, Strategy, ValueTree};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    rc::Rc,
    sync::Arc,
};
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Op {
    Start,
    Tick,
    Unpaid,
    Paid,
    Error,
    Noop,
    Unknown,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Seed {
    Fresh,
    Done,
    GaveUp,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Rule {
    Provenance,
    Done,
    GaveUp,
    False,
    Error,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Script {
    loaded: Seed,
    before: Vec<Op>,
    prefix: Vec<Op>,
    tail: Op,
    repeat: usize,
    rule: Rule,
    at: wire::Number,
}
struct Receipt<'a> {
    paid: bool,
    invoice: &'a str,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
struct Cause<'a> {
    invoice: &'a str,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
struct Command<'a> {
    invoice: &'a str,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
struct Context<'a> {
    invoice: &'a str,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
struct Model<'a> {
    poll: Rc<PollerState<Receipt<'a>, Cause<'a>>>,
}
impl Tagged for Model<'_> {
    fn tag(&self) -> &str {
        "invoice"
    }
}
enum Msg<'a> {
    Start,
    Tick,
    Noop,
    Unknown,
    Result { receipt: Rc<Receipt<'a>>, at: f64 },
    Error { cause: Rc<Cause<'a>>, at: f64 },
}
impl Tagged for Msg<'_> {
    fn tag(&self) -> &str {
        match self {
            Self::Start => "start",
            Self::Tick => "tick",
            Self::Noop => "noop",
            Self::Unknown => "unknown",
            Self::Result { .. } => "result",
            Self::Error { .. } => "error",
        }
    }
}
impl fmt::Debug for Msg<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.tag())
    }
}
#[derive(Clone)]
struct ResultFields<'a> {
    receipt: Rc<Receipt<'a>>,
    at: f64,
}
impl fmt::Debug for ResultFields<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ResultFields")
    }
}
#[derive(Clone)]
struct ErrorFields<'a> {
    cause: Rc<Cause<'a>>,
    at: f64,
}
impl fmt::Debug for ErrorFields<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ErrorFields")
    }
}
struct AppError<'a> {
    note: &'a str,
    cause: Rc<Cause<'a>>,
    snapshot: Arc<Model<'a>>,
}
fn number(n: Option<f64>) -> Value {
    n.map_or(Value::Null, wire::number)
}
fn state_view(
    s: &Model<'_>,
    paid: &Rc<Receipt<'_>>,
    unpaid: &Rc<Receipt<'_>>,
    cause: &Rc<Cause<'_>>,
) -> Value {
    json!({"phase":s.poll.phase.as_str(),"tick":number(s.poll.tick.number()),"nextAt":match &s.poll.phase{PollerPhase::Polling{next_at_ms}=>number(next_at_ms.number()),_=>Value::Null},"result":s.poll.last_result.value().map_or("absent",|r|if r.paid{"paid"}else{"unpaid"}),"resultIdentity":s.poll.last_result.value().is_none_or(|r|Rc::ptr_eq(r,paid)||Rc::ptr_eq(r,unpaid)),"attempt":number(s.poll.retry.attempt.number()),"errorIdentity":s.poll.retry.last_error.value().is_none_or(|e|Rc::ptr_eq(e,cause))})
}
fn message_view(
    m: &Msg<'_>,
    paid: &Rc<Receipt<'_>>,
    unpaid: &Rc<Receipt<'_>>,
    cause: &Rc<Cause<'_>>,
) -> Value {
    match m {
        Msg::Result { receipt, at } => {
            json!({"type":m.tag(),"receipt":if receipt.paid{"paid"}else{"unpaid"},"receiptIdentity":Rc::ptr_eq(receipt,paid)||Rc::ptr_eq(receipt,unpaid),"invoice":receipt.invoice,"capability":(receipt.capability)(),"at":wire::number(*at)})
        }
        Msg::Error { cause: actual, at } => {
            json!({"type":m.tag(),"causeIdentity":Rc::ptr_eq(actual,cause),"invoice":actual.invoice,"capability":(actual.capability)(),"at":wire::number(*at)})
        }
        _ => json!({"type":m.tag()}),
    }
}
pub(super) fn execute(id: &str, input: &Script) -> Value {
    let invoice = String::from("invoice-42");
    let paid = Rc::new(Receipt {
        paid: true,
        invoice: &invoice,
        capability: Box::new(|| 17),
    });
    let unpaid = Rc::new(Receipt {
        paid: false,
        invoice: &invoice,
        capability: Box::new(|| 18),
    });
    let cause = Rc::new(Cause {
        invoice: &invoice,
        capability: Box::new(|| 19),
    });
    let command = Rc::new(Command {
        invoice: &invoice,
        capability: Box::new(|| 20),
    });
    let context = Context {
        invoice: &invoice,
        capability: Box::new(|| 21),
    };
    let calls: Calls = RefCell::new(vec![]);
    let log = RefCell::new(Vec::<Value>::new());
    let checks = RefCell::new(Vec::<Value>::new());
    let runs = Cell::new(0usize);
    let updates = Cell::new(0usize);
    let until_calls = Cell::new(0usize);
    let poller = create_poller::<Model<'_>, Receipt<'_>, Command<'_>, Cause<'_>, _>(
        PollerConfig::new(
            10.0,
            |_: &Model<'_>| {
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
    let seed = match input.loaded {
        Seed::Fresh => None,
        Seed::Done => Some(Arc::new(Model {
            poll: poller
                .tick_result(&poller.init(), Rc::clone(&paid), 0.0, true)
                .unwrap()
                .state,
        })),
        Seed::GaveUp => Some(Arc::new(Model {
            poll: poller
                .tick_err(&poller.init(), Rc::clone(&cause), 0.0)
                .state,
        })),
    };
    let start = observe!(&calls, demlik_tea::pbt::constant_msg, Msg::Start);
    let tick = observe!(&calls, demlik_tea::pbt::constant_msg, Msg::Tick);
    let noop = observe!(&calls, demlik_tea::pbt::constant_msg, Msg::Noop);
    let unknown = observe!(&calls, demlik_tea::pbt::constant_msg, Msg::Unknown);
    let make = |op: Op, random: &mut proptest::test_runner::TestRunner| -> Arc<Msg<'_>> {
        match op {
            Op::Start => start.new_tree(random).unwrap().current(),
            Op::Tick => tick.new_tree(random).unwrap().current(),
            Op::Noop => noop.new_tree(random).unwrap().current(),
            Op::Unknown => unknown.new_tree(random).unwrap().current(),
            Op::Unpaid | Op::Paid => {
                let fields = Just(ResultFields {
                    receipt: Rc::clone(if matches!(op, Op::Paid) {
                        &paid
                    } else {
                        &unpaid
                    }),
                    at: input.at.value(),
                });
                let strategy = observe!(&calls, demlik_tea::pbt::record_msg, fields, |fields| {
                    Msg::Result {
                        receipt: fields.receipt,
                        at: fields.at,
                    }
                });
                strategy.new_tree(random).unwrap().current()
            }
            Op::Error => {
                let fields = Just(ErrorFields {
                    cause: Rc::clone(&cause),
                    at: input.at.value(),
                });
                let strategy = observe!(&calls, demlik_tea::pbt::record_msg, fields, |fields| {
                    Msg::Error {
                        cause: fields.cause,
                        at: fields.at,
                    }
                });
                strategy.new_tree(random).unwrap().current()
            }
        }
    };
    let mut random = runner();
    let before_messages = input
        .before
        .iter()
        .map(|op| make(*op, &mut random))
        .collect::<Vec<_>>();
    let prefix = input
        .prefix
        .iter()
        .map(|op| make(*op, &mut random))
        .collect::<Vec<_>>();
    let tail = make(input.tail, &mut random);
    let sequence = observe!(
        &calls,
        demlik_tea::pbt::msg_sequence,
        Just(tail),
        SequenceOptions {
            tail: (input.repeat..=input.repeat).into(),
            prefix
        }
    );
    let messages = sequence.new_tree(&mut random).unwrap().current();
    let boot = RefCell::new(None::<Arc<Model<'_>>>);
    let mut row: Row<'_, Arc<Model<'_>>, Msg<'_>, Rc<Command<'_>>> = Row::new();
    for tag in ["start", "tick", "result", "error", "noop"] {
        row.insert(
            tag.into(),
            Box::new(|s, m| {
                updates.set(updates.get() + 1);
                log.borrow_mut()
                    .push(json!(["update", s.poll.phase.as_str(), m.tag()]));
                let step = match m {
                    Msg::Start => poller.start(&s.poll, 0.0),
                    Msg::Tick => poller.tick(&s.poll),
                    Msg::Noop => Step::new(Rc::clone(&s.poll), vec![]),
                    Msg::Result { receipt, at } => poller
                        .tick_result(&s.poll, Rc::clone(receipt), *at, receipt.paid)
                        .unwrap(),
                    Msg::Error { cause, at } => poller.tick_err(&s.poll, Rc::clone(cause), *at),
                    Msg::Unknown => unreachable!("there is no unknown cell"),
                };
                let next = if Rc::ptr_eq(&s.poll, &step.state) {
                    Arc::clone(s)
                } else {
                    Arc::new(Model { poll: step.state })
                };
                Step::new(next, step.commands)
            }),
        );
    }
    let machine: Machine<'_, Arc<Model<'_>>, Msg<'_>, Rc<Command<'_>>, DeadlinesSub, Context<'_>> =
        Machine {
            init: Box::new(|loaded, ctx| {
                runs.set(runs.get() + 1);
                log.borrow_mut().push(json!([
                    "init",
                    loaded
                        .as_ref()
                        .map(|s| state_view(s, &paid, &unpaid, &cause)),
                    std::ptr::eq(ctx, &context),
                    (ctx.capability)(),
                    ctx.invoice
                ]));
                let state = loaded.unwrap_or_else(|| {
                    Arc::new(Model {
                        poll: poller.init(),
                    })
                });
                let old = boot.replace(Some(Arc::clone(&state)));
                drop(old);
                Step::new(state, vec![Rc::clone(&command)])
            }),
            update: Update::RawReducer(row),
            subscriptions: demlik_tea::core::subscriptions(|s: &Arc<Model<'_>>| {
                deadlines_sub(|actual: &Arc<Model<'_>>| {
                    let deadlines = poller.subs(&actual.poll);
                    log.borrow_mut().push(json!([
                        "subs",
                        actual.poll.phase.as_str(),
                        deadlines.len()
                    ]));
                    deadlines
                })(s)
                .unwrap()
                .into_iter()
                .collect()
            }),
        };
    let (held, before) = if before_messages.is_empty() {
        (seed, Value::Null)
    } else {
        let folded = observe!(
            &calls,
            demlik_tea::pbt::fold_events,
            &machine,
            &context,
            seed,
            before_messages.iter().cloned()
        )
        .unwrap();
        let held = Arc::clone(folded.final_state.as_ref());
        let before = json!({"state":state_view(&held,&paid,&unpaid,&cause),"messagesOriginal":folded.steps.iter().zip(&before_messages).all(|(s,m)|Arc::ptr_eq(&s.msg,m)),"steps":folded.steps.len()});
        (Some(held), before)
    };
    let baseline_updates = updates.get();
    let last_error = RefCell::new(None::<Rc<AppError<'_>>>);
    let last_final = RefCell::new(None::<Arc<Model<'_>>>);
    let result = observe!(
        &calls,
        demlik_tea::pbt::property_trace,
        &machine,
        &context,
        &Just(messages.clone()),
        || held.as_ref().map(Arc::clone),
        |steps: &[FoldStep<Arc<Model<'_>>, Msg<'_>, Rc<Command<'_>>>], state: &Arc<Model<'_>>| {
            log.borrow_mut().push(json!(["trace"]));
            let old = last_final.replace(Some(Arc::clone(state)));
            drop(old);
            let steps_view=steps.iter().enumerate().map(|(i,s)|json!({"msg":message_view(&s.msg,&paid,&unpaid,&cause),"prev":state_view(&s.prev,&paid,&unpaid,&cause),"next":state_view(&s.next,&paid,&unpaid,&cause),"sameState":Arc::ptr_eq(s.prev.as_ref(),s.next.as_ref()),"sameInput":Arc::ptr_eq(&s.msg,&messages[i]),"commands":s.commands.iter().map(|c|json!({"invoice":c.invoice,"capability":(c.capability)(),"sameCommand":Rc::ptr_eq(c,&command)})).collect::<Vec<_>>()})).collect::<Vec<_>>();
            let same_boot = boot
                .borrow()
                .as_ref()
                .is_some_and(|b| Arc::ptr_eq(b, state));
            let boot_is_held = held
                .as_ref()
                .map(|h| boot.borrow().as_ref().is_some_and(|b| Arc::ptr_eq(b, h)));
            checks.borrow_mut().push(json!({"steps":steps_view,"final":state_view(state,&paid,&unpaid,&cause),"sameBoot":same_boot,"bootIsHeld":boot_is_held,"fullFoldComplete":updates.get()==baseline_updates+messages.len(),"links":steps.windows(2).all(|s|Arc::ptr_eq(&s[0].next,&s[1].prev)),"finalIsLast":steps.last().is_none_or(|s|Arc::ptr_eq(s.next.as_ref(),state))}));
            if matches!(input.rule, Rule::Error) {
                let error = Rc::new(AppError {
                    note: &invoice,
                    cause: Rc::clone(&cause),
                    snapshot: Arc::clone(state),
                });
                let old = last_error.replace(Some(Rc::clone(&error)));
                drop(old);
                return Err(error);
            }
            Ok(match input.rule {
                Rule::Provenance => steps
                    .iter()
                    .enumerate()
                    .all(|(i, s)| Arc::ptr_eq(&s.msg, &messages[i])),
                Rule::Done => matches!(state.poll.phase, PollerPhase::Done),
                Rule::GaveUp => matches!(state.poll.phase, PollerPhase::GaveUp),
                Rule::False => false,
                Rule::Error => unreachable!(),
            })
        },
        PropertyOptions {
            num_runs: 1,
            seed: Some(731)
        }
    );
    let mut status = "ok";
    let mut failure = Value::Null;
    let mut retention = Value::Null;
    let mut diagnostics = Value::Null;
    if let Err(error) = result {
        match error {
            PropertyFailure::Case { reason, evaluated } => {
                let messages_original = evaluated
                    .messages
                    .iter()
                    .zip(&messages)
                    .all(|(a, b)| Arc::ptr_eq(a, b))
                    && evaluated.messages.len() == messages.len();
                match evaluated.failure {
                    FailedCase::Trace {
                        trace,
                        failure: problem,
                    } => {
                        let original_final = last_final
                            .borrow()
                            .as_ref()
                            .is_some_and(|s| Arc::ptr_eq(s, trace.final_state.as_ref()));
                        let trace_owners = messages_original
                            && trace
                                .steps
                                .iter()
                                .zip(&messages)
                                .all(|(s, m)| Arc::ptr_eq(&s.msg, m))
                            && original_final;
                        match problem {
                            PredicateFailure::False => {
                                status = "false";
                                failure = json!({"phase":"trace","kind":"false"});
                                retention = json!({"traceOwners":trace_owners});
                                diagnostics = json!({"category":"case","reason":reason,"phase":"trace","messagesOriginal":messages_original});
                            }
                            PredicateFailure::Error(error) => {
                                status = "callback";
                                let original_error = last_error
                                    .borrow()
                                    .as_ref()
                                    .is_some_and(|e| Rc::ptr_eq(e, &error));
                                let cause_owner = Rc::ptr_eq(&cause, &error.cause);
                                let snapshot_owner =
                                    Arc::ptr_eq(&error.snapshot, trace.final_state.as_ref());
                                failure = json!({"phase":"trace","kind":"error"});
                                retention = json!({"traceOwners":trace_owners});
                                diagnostics = json!({"category":"case","reason":reason,"phase":"trace","messagesOriginal":messages_original,"error":{"note":error.note,"causeInvoice":error.cause.invoice,"causeCapability":(error.cause.capability)(),"originalError":original_error,"originalCause":cause_owner,"originalSnapshot":snapshot_owner}});
                            }
                            PredicateFailure::Panic(cause) => {
                                panic!("unexpected native predicate panic: {cause:?}")
                            }
                        }
                    }
                    FailedCase::FoldRefused(error) => {
                        status = "refusal";
                        failure = json!({"phase":"fold","kind":"refusal"});
                        diagnostics = json!({"category":"case","reason":reason,"phase":"fold","messagesOriginal":messages_original,"error":{"name":error.name(),"message":error.message,"msgType":error.msg_type,"stateName":error.state_name,"acceptedTypes":error.accepted_types}});
                    }
                    _ => panic!("unexpected failure phase"),
                }
            }
            _ => panic!("unexpected property backend failure"),
        }
    }
    let comparison = json!({"status":status,"before":before,"messages":messages.iter().map(|m|message_view(m,&paid,&unpaid,&cause)).collect::<Vec<_>>(),"sameMessageOwners":messages.iter().map(|m|messages.iter().map(|n|Arc::ptr_eq(m,n)).collect::<Vec<_>>()).collect::<Vec<_>>(),"runs":runs.get(),"updates":updates.get(),"log":log.borrow().clone(),"checks":checks.borrow().clone(),"failure":failure,"retention":retention,"untilCalls":until_calls.get()});
    json!({"id":id,"comparison":comparison,"diagnostics":diagnostics,"observedRustCalls":calls.borrow().clone()})
}
