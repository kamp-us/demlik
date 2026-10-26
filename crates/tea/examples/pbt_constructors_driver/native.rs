use super::Calls;
use demlik_tea::{
    Machine, Step, Sub, Tagged, Update,
    pbt::{FailedCase, PredicateFailure, PropertyFailure, PropertyOptions, SequenceOptions},
};
use proptest::{
    strategy::{Strategy, ValueTree},
    test_runner::{Config, RngAlgorithm, RngSeed, TestRunner, noop_result_cache},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    rc::Rc,
    sync::Arc,
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Law {
    Constant,
    SeedReplay,
    FieldShrink,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Script {
    law: Law,
}
struct Opaque<'a> {
    invoice: &'a str,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
enum Msg<'a> {
    Noop {
        owner: Rc<Opaque<'a>>,
    },
    Observed {
        value: u8,
        owner: Rc<Opaque<'a>>,
        _seal: Box<dyn Fn() + 'a>,
    },
}
impl Msg<'_> {
    fn owner(&self) -> &Rc<Opaque<'_>> {
        match self {
            Self::Noop { owner } | Self::Observed { owner, .. } => owner,
        }
    }
    fn value(&self) -> Option<u8> {
        match self {
            Self::Noop { .. } => None,
            Self::Observed { value, .. } => Some(*value),
        }
    }
}
impl Tagged for Msg<'_> {
    fn tag(&self) -> &str {
        match self {
            Self::Noop { .. } => "noop",
            Self::Observed { .. } => "observed",
        }
    }
}
impl demlik_tea::core::Message for Msg<'_> {
    const TYPES: &'static [&'static str] = &["noop", "observed"];
}
impl fmt::Debug for Msg<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.tag())
    }
}
struct Model<'a> {
    value: u8,
    owner: Rc<Opaque<'a>>,
}
impl Tagged for Model<'_> {
    fn tag(&self) -> &str {
        "observation"
    }
}
struct Command<'a> {
    owner: Rc<Opaque<'a>>,
    _seal: Box<dyn Fn() + 'a>,
}
struct AppError<'a> {
    cause: Rc<Opaque<'a>>,
    snapshot: Arc<Model<'a>>,
    capability: Box<dyn Fn() -> u8 + 'a>,
}
struct Captured<'a> {
    messages: Vec<Arc<Msg<'a>>>,
    state: Arc<Model<'a>>,
    error: Rc<AppError<'a>>,
    commands: Vec<Rc<Command<'a>>>,
}
fn runner(seed: u64) -> TestRunner {
    TestRunner::new(Config {
        rng_seed: RngSeed::Fixed(seed),
        rng_algorithm: RngAlgorithm::ChaCha,
        failure_persistence: None,
        result_cache: noop_result_cache,
        ..Config::default()
    })
}
pub(super) fn execute(id: &str, input: &Script) -> Value {
    let invoice = String::from("invoice-42");
    let owner = Rc::new(Opaque {
        invoice: &invoice,
        capability: Box::new(|| 31),
    });
    let calls: Calls = RefCell::new(vec![]);
    let comparison = match input.law {
        Law::Constant => {
            let strategy = observe!(
                &calls,
                demlik_tea::pbt::constant_msg,
                Msg::Noop {
                    owner: Rc::clone(&owner)
                }
            );
            let mut random = runner(731);
            let mut tree = strategy.new_tree(&mut random).unwrap();
            let first = tree.current();
            let again = tree.current();
            let no_shrink = !tree.simplify();
            let across = (0..8)
                .map(|_| strategy.new_tree(&mut random).unwrap().current())
                .collect::<Vec<_>>();
            json!({"status":"ok","sameCurrent":Arc::ptr_eq(&first,&again),"sameAcrossTrees":across.iter().all(|m|Arc::ptr_eq(m,&first)),"noShrink":no_shrink,"originalPayload":Rc::ptr_eq(first.owner(),&owner),"borrowedInvoice":first.owner().invoice,"capability":(first.owner().capability)()})
        }
        Law::SeedReplay => {
            let generate = |seed| {
                let prefix_strategy = observe!(
                    &calls,
                    demlik_tea::pbt::constant_msg,
                    Msg::Noop {
                        owner: Rc::clone(&owner)
                    }
                );
                let mut random = runner(seed);
                let prefix = prefix_strategy.new_tree(&mut random).unwrap().current();
                let constant = observe!(
                    &calls,
                    demlik_tea::pbt::constant_msg,
                    Msg::Noop {
                        owner: Rc::clone(&owner)
                    }
                );
                let record = observe!(&calls, demlik_tea::pbt::record_msg, 0u8..=255, |value| {
                    Msg::Observed {
                        value,
                        owner: Rc::clone(&owner),
                        _seal: Box::new(|| {}),
                    }
                });
                let variants = proptest::prop_oneof![2=>constant,5=>record];
                let sequence = observe!(
                    &calls,
                    demlik_tea::pbt::msg_sequence,
                    variants,
                    SequenceOptions {
                        tail: (2usize..=4).into(),
                        prefix: vec![Arc::clone(&prefix)]
                    }
                );
                let mut samples = vec![];
                let mut prefixes = true;
                let mut payloads = true;
                let mut bounded = true;
                for _ in 0..16 {
                    let messages = sequence.new_tree(&mut random).unwrap().current();
                    prefixes &= Arc::ptr_eq(&messages[0], &prefix);
                    payloads &= messages.iter().all(|m| Rc::ptr_eq(m.owner(), &owner));
                    bounded &= (3..=5).contains(&messages.len());
                    samples.push(
                        messages
                            .iter()
                            .map(|m| (m.tag().to_owned(), m.value()))
                            .collect::<Vec<_>>(),
                    );
                }
                (samples, prefixes, payloads, bounded)
            };
            let (a, ap, ao, ab) = generate(731);
            let (b, bp, bo, bb) = generate(731);
            let (c, cp, co, cb) = generate(732);
            json!({"status":"ok","sameSeedLogical":a==b,"differentSeedLogical":a!=c,"prefixHandles":ap&&bp&&cp,"originalPayloads":ao&&bo&&co,"boundedTail":ab&&bb&&cb,"histories":48,"first":a,"replay":b,"otherSeed":c})
        }
        Law::FieldShrink => {
            let record = observe!(&calls, demlik_tea::pbt::record_msg, 0u8..=255, |value| {
                Msg::Observed {
                    value,
                    owner: Rc::clone(&owner),
                    _seal: Box::new(|| {}),
                }
            });
            let sequence = observe!(
                &calls,
                demlik_tea::pbt::msg_sequence,
                record,
                SequenceOptions {
                    tail: (1usize..=1).into(),
                    prefix: vec![]
                }
            );
            let machine: Machine<
                '_,
                Arc<Model<'_>>,
                Msg<'_>,
                Rc<Command<'_>>,
                Sub,
                Rc<Opaque<'_>>,
            > = Machine {
                init: Box::new(|loaded, ctx| {
                    Step::new(
                        loaded.unwrap_or_else(|| {
                            Arc::new(Model {
                                value: 0,
                                owner: Rc::clone(ctx),
                            })
                        }),
                        vec![],
                    )
                }),
                update: Update::reducer(|state: &Arc<Model<'_>>, msg: &Msg<'_>| match msg {
                    Msg::Noop { .. } => Step::new(Arc::clone(state), vec![]),
                    Msg::Observed {
                        value,
                        owner: actual,
                        ..
                    } => Step::new(
                        Arc::new(Model {
                            value: *value,
                            owner: Rc::clone(actual),
                        }),
                        vec![Rc::new(Command {
                            owner: Rc::clone(actual),
                            _seal: Box::new(|| {}),
                        })],
                    ),
                }),
                subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
            };
            let evaluations = Cell::new(0usize);
            let first_failure = Cell::new(None::<u8>);
            let last = RefCell::new(None::<Captured<'_>>);
            let result = observe!(
                &calls,
                demlik_tea::pbt::property_trace,
                &machine,
                &owner,
                &sequence,
                || None,
                |steps, state| {
                    evaluations.set(evaluations.get() + 1);
                    if state.value < 13 {
                        return Ok(true);
                    }
                    if first_failure.get().is_none() {
                        first_failure.set(Some(state.value));
                    }
                    let error = Rc::new(AppError {
                        cause: Rc::clone(&owner),
                        snapshot: Arc::clone(state),
                        capability: Box::new(|| 37),
                    });
                    let captured = Captured {
                        messages: steps.iter().map(|s| Arc::clone(&s.msg)).collect(),
                        state: Arc::clone(state),
                        error: Rc::clone(&error),
                        commands: steps
                            .iter()
                            .flat_map(|s| s.commands.iter().map(Rc::clone))
                            .collect(),
                    };
                    let old = last.replace(Some(captured));
                    drop(old);
                    Err(error)
                },
                PropertyOptions {
                    num_runs: 64,
                    seed: Some(731)
                }
            );
            match result {
                Err(PropertyFailure::Case { reason, evaluated }) => {
                    let captured = last
                        .into_inner()
                        .expect("a failing callback was actually observed");
                    match evaluated.failure {
                        FailedCase::Trace {
                            trace,
                            failure: PredicateFailure::Error(error),
                        } => {
                            let original_messages = evaluated.messages.len()
                                == captured.messages.len()
                                && evaluated
                                    .messages
                                    .iter()
                                    .zip(&captured.messages)
                                    .all(|(a, b)| Arc::ptr_eq(a, b));
                            let original_trace = trace.steps.len() == captured.messages.len()
                                && trace
                                    .steps
                                    .iter()
                                    .zip(&captured.messages)
                                    .all(|(s, m)| Arc::ptr_eq(&s.msg, m))
                                && Arc::ptr_eq(trace.final_state.as_ref(), &captured.state);
                            let commands = trace
                                .steps
                                .iter()
                                .flat_map(|s| s.commands.iter())
                                .collect::<Vec<_>>();
                            json!({"status":"case","minimum":evaluated.messages.first().and_then(|m|m.value()),"firstFailure":first_failure.get(),"evaluations":evaluations.get(),"originalMessages":original_messages,"originalTrace":original_trace,"originalError":Rc::ptr_eq(&error,&captured.error),"originalCause":Rc::ptr_eq(&error.cause,&owner),"originalSnapshot":Arc::ptr_eq(&error.snapshot,trace.final_state.as_ref()),"originalCommands":commands.len()==captured.commands.len()&&commands.iter().zip(&captured.commands).all(|(a,b)|Rc::ptr_eq(a,b)),"commandPayloads":commands.iter().all(|c|Rc::ptr_eq(&c.owner,&owner)),"modelOwner":Rc::ptr_eq(&trace.final_state.owner,&owner),"capability":(error.capability)(),"invoice":error.cause.invoice,"reason":reason})
                        }
                        _ => json!({"status":"unexpected-case-phase"}),
                    }
                }
                Ok(()) => json!({"status":"unexpected-success"}),
                Err(other) => {
                    json!({"status":"unexpected-backend-failure","details":format!("{other:?}")})
                }
            }
        }
    };
    json!({"id":id,"comparison":comparison,"diagnostics":{},"observedRustCalls":calls.borrow().clone()})
}
