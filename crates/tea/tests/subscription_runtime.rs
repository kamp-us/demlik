use demlik_tea::{
    Machine, Step, Sub, Tagged, TryUpdate,
    command::{CommandContractError, CommandFamily},
    core::{ProjectionError, SubEntry, SubscriptionEntries, try_subscriptions},
    runtime::{
        self, CommandContext, CommandWork, EffectScope, ErrorPhase, Gate, Interpreter, NoEvent,
        Options, Persistence, Profile, RuntimeError, SubscriptionWork, Subscriptions, Supervision,
    },
    storage::{self, MemoryStore, Store},
};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    fmt,
    rc::Rc,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Notify;
struct Opaque {
    value: Cell<u8>,
}
struct Model {
    n: u8,
    original: Rc<Opaque>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
demlik_tea::messages! {enum Msg { Next, Recover }}
struct Cmd;
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "effect"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, v: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(v)
    }
}
struct Host(Rc<Cell<usize>>);
impl Interpreter<Cmd> for Host {
    type Error = HostFailure;
    fn interpret<'a>(
        &'a self,
        _: &'a Cmd,
        _: CommandContext<Msg, HostFailure>,
    ) -> Option<CommandWork<'a, Vec<Msg>, HostFailure>> {
        Some(CommandWork::new(async {
            self.0.set(self.0.get() + 1);
            Ok(vec![])
        }))
    }
}
struct HostFailure(Rc<Opaque>);
impl fmt::Debug for HostFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HostFailure(..)")
    }
}
#[derive(Default)]
struct Sources {
    live: Cell<usize>,
    closed: Cell<usize>,
    fail: RefCell<Option<Rc<Opaque>>>,
    hold: Cell<bool>,
    release: Notify,
    entered: Notify,
}
struct Runner(Rc<Sources>);
impl Subscriptions<Sub<u8>, Msg> for Runner {
    type Error = HostFailure;
    fn start(
        &self,
        _: Sub<u8>,
        _: runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<HostFailure>>, HostFailure> {
        if let Some(cause) = self.0.fail.borrow_mut().take() {
            return Err(HostFailure(cause));
        }
        self.0.live.set(self.0.live.get() + 1);
        let s = Rc::clone(&self.0);
        Ok(Some(SubscriptionWork::new(move || async move {
            s.entered.notify_one();
            if s.hold.get() {
                s.release.notified().await;
            }
            s.live.set(s.live.get() - 1);
            s.closed.set(s.closed.get() + 1);
            Ok(())
        })))
    }
}
type Error = RuntimeError<storage::MemoryStoreError, HostFailure, Rc<Opaque>>;
type Run =
    runtime::Runtime<Arc<Model>, Msg, storage::MemoryStoreError, HostFailure, NoEvent, Rc<Opaque>>;
struct Fixture {
    live: Run,
    store: MemoryStore<Arc<Model>>,
    original: Rc<Opaque>,
    loaded: Arc<Model>,
    effects: Rc<Cell<usize>>,
    observed: Rc<Cell<usize>>,
    sources: Rc<Sources>,
    policy_calls: Rc<Cell<usize>>,
}
#[expect(
    clippy::arc_with_non_send_sync,
    reason = "The real local actor and memory store share opaque non-Send model owners without cloning models."
)]
fn fixture(profile: Profile, boot_refusal: bool, whole: bool) -> Fixture {
    let original = Rc::new(Opaque {
        value: Cell::new(73),
    });
    let loaded = Arc::new(Model {
        n: if boot_refusal { 1 } else { 0 },
        original: Rc::clone(&original),
    });
    let store = storage::memory_store(Some(Arc::clone(&loaded)));
    let effects = Rc::new(Cell::new(0));
    let observed = Rc::new(Cell::new(0));
    let sources = Rc::new(Sources::default());
    let policy_calls = Rc::new(Cell::new(0));
    let cause = Rc::clone(&original);
    let subscriptions = if whole {
        try_subscriptions(move |s: &Arc<Model>| {
            if s.n == 1 {
                Err(Rc::clone(&cause))
            } else {
                Ok(vec![
                    Sub::new("a", s.n).unwrap(),
                    Sub::new("b", s.n).unwrap(),
                ])
            }
        })
    } else {
        Box::new(SubscriptionEntries::new(vec![
            SubEntry::try_new("a", move |s: &Arc<Model>| {
                if s.n == 1 {
                    Err(Rc::clone(&cause))
                } else {
                    Ok(Some(s.n))
                }
            }),
            SubEntry::try_new("b", |s: &Arc<Model>| Ok(Some(s.n))),
        ])) as demlik_tea::core::Subscriptions<'static, Arc<Model>, Sub<u8>, Rc<Opaque>>
    };
    let machine = Machine {
        init: Box::new(|loaded: Option<Arc<Model>>, _: &()| Step::new(loaded.unwrap(), vec![Cmd])),
        update: TryUpdate::try_reducer(|s: &Arc<Model>, m: &Msg| {
            Ok(Step::new(
                Arc::new(Model {
                    n: match m {
                        Msg::Next => 1,
                        Msg::Recover => 2,
                    },
                    original: Rc::clone(&s.original),
                }),
                vec![Cmd],
            ))
        }),
        subscriptions,
    };
    let mut options: Options<
        Arc<Model>,
        Msg,
        storage::MemoryStoreError,
        HostFailure,
        NoEvent,
        Rc<Opaque>,
    > = Options::new(profile);
    options.store = Some(Persistence::new(store.clone()));
    options.dispose_timeout = Duration::ZERO;
    let policy = Rc::clone(&policy_calls);
    options.supervision = Supervision::Restart(Rc::new(move |s, _, _| {
        policy.set(policy.get() + 1);
        Arc::clone(s)
    }));
    let live = runtime::try_launch(
        machine,
        (),
        Host(Rc::clone(&effects)),
        Runner(Rc::clone(&sources)),
        options,
    );
    let observed_count = Rc::clone(&observed);
    let _off = live.observe(move |_, _| observed_count.set(observed_count.get() + 1));
    Fixture {
        live,
        store,
        original,
        loaded,
        effects,
        observed,
        sources,
        policy_calls,
    }
}
fn projection(error: &Error) -> &Rc<Opaque> {
    let RuntimeError::Projection { failures } = error else {
        panic!("projection lost its category")
    };
    let ProjectionError::Declared(cause) = &failures[0].cause else {
        panic!("declared cause erased")
    };
    cause
}
async fn local(check: impl Future<Output = ()>) {
    tokio::task::LocalSet::new().run_until(check).await;
}
#[tokio::test(flavor = "current_thread")]
async fn post_save_refusal_preserves_real_state_and_opaque_cause_after_runtime_drop() {
    local(async {
        for profile in [Profile::Promise, Profile::Effect] {
            let f = fixture(profile, false, false);
            assert!(f.live.ready().await.is_ok());
            let boot = f.live.get_state().unwrap();
            assert!(Arc::ptr_eq(boot.as_ref(), &f.loaded));
            assert_eq!(f.effects.get(), 1);
            let Err(error) = f.live.dispatch(Msg::Next).await else {
                panic!("refusal vanished")
            };
            assert!(Rc::ptr_eq(projection(&error), &f.original));
            let installed = f.live.get_state().unwrap();
            let saved = f.store.load().await.unwrap().unwrap();
            assert!(Arc::ptr_eq(installed.as_ref(), &saved));
            assert_eq!(saved.n, 1);
            assert_eq!(f.effects.get(), 1);
            assert_eq!(f.observed.get(), 0);
            assert_eq!(f.policy_calls.get(), 0);
            assert!(f.live.reports().is_empty());
            assert_eq!(f.live.gate(), Gate::Open);
            assert_eq!(f.sources.live.get(), 2);
            assert!(f.live.dispatch(Msg::Recover).await.is_ok());
            assert_eq!(f.effects.get(), 2);
            assert_eq!(f.observed.get(), 1);
            f.live.stop().await;
            drop(f.live);
            drop(installed);
            drop(saved);
            assert_eq!(projection(&error).value.get(), 73);
            assert!(Rc::ptr_eq(projection(&error), &f.original));
        }
    })
    .await;
}
#[tokio::test(flavor = "current_thread")]
async fn cached_boot_refusal_reuses_outer_and_inner_allocations_without_final_save() {
    local(async {
        for profile in [Profile::Promise, Profile::Effect] {
            let f = fixture(profile, true, false);
            let Err(first) = f.live.ready().await else {
                panic!("boot accepted")
            };
            let Err(again) = f.live.ready().await else {
                panic!("boot accepted")
            };
            let Err(dispatch) = f.live.dispatch(Msg::Recover).await else {
                panic!("cached failure ignored")
            };
            assert!(Rc::ptr_eq(&first, &again) && Rc::ptr_eq(&first, &dispatch));
            assert!(Rc::ptr_eq(projection(&first), &f.original));
            assert!(Arc::ptr_eq(f.live.get_state().unwrap().as_ref(), &f.loaded));
            assert_eq!(f.effects.get(), 0);
            assert_eq!(f.observed.get(), 0);
            assert_eq!(f.policy_calls.get(), 0);
            f.live.stop().await;
            assert_eq!(f.sources.live.get(), 0);
            assert_eq!(projection(&first).value.get(), 73);
        }
    })
    .await;
}
#[tokio::test(flavor = "current_thread")]
async fn whole_projection_refusal_keeps_all_existing_kinds_until_real_recovery() {
    local(async {
        for profile in [Profile::Promise, Profile::Effect] {
            let f = fixture(profile, false, true);
            assert!(f.live.ready().await.is_ok());
            let Err(error) = f.live.dispatch(Msg::Next).await else {
                panic!("refusal vanished")
            };
            let RuntimeError::Projection { failures } = &*error else {
                panic!("category")
            };
            assert!(failures[0].kind.is_none());
            assert!(Rc::ptr_eq(projection(&error), &f.original));
            assert_eq!(f.sources.live.get(), 2);
            assert_eq!(f.sources.closed.get(), 0);
            assert!(f.live.dispatch(Msg::Recover).await.is_ok());
            assert_eq!(f.sources.closed.get(), 2);
            assert_eq!(f.sources.live.get(), 2);
            f.live.stop().await;
            assert_eq!(f.sources.closed.get(), 4);
        }
    })
    .await;
}
#[tokio::test(flavor = "current_thread")]
async fn projection_does_not_fail_effect_scope_but_runner_failure_retains_its_own_cause() {
    local(async {
        let f = fixture(Profile::Effect, false, false);
        let scope = EffectScope::new();
        scope.attach(&f.live).await.unwrap();
        assert!(f.live.ready().await.is_ok());
        let runner = Rc::new(Opaque {
            value: Cell::new(91),
        });
        f.sources.fail.replace(Some(Rc::clone(&runner)));
        let Err(first) = f.live.dispatch(Msg::Next).await else {
            panic!("projection lost")
        };
        assert!(Rc::ptr_eq(projection(&first), &f.original));
        scope.close().await;
        let scoped = scope.failure().expect("actual runner must fail the scope");
        let Some(Error::Handler(cause)) = scoped.downcast_ref::<Error>() else {
            panic!("runner cause erased")
        };
        assert!(Rc::ptr_eq(&cause.0, &runner));
        let reports = f.live.reports();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].phase, ErrorPhase::Sub);
        let Error::Handler(cause) = reports[0].error.as_ref() else {
            panic!("runner reclassified")
        };
        assert!(Rc::ptr_eq(&cause.0, &runner));
        assert!(std::ptr::eq(
            scoped.downcast_ref::<Error>().unwrap(),
            reports[0].error.as_ref()
        ));
        assert_eq!(f.policy_calls.get(), 0);
        assert!(scope.is_closed());
    })
    .await;
}
#[tokio::test(flavor = "current_thread")]
async fn pure_projection_refusal_leaves_attached_scope_live_until_explicit_owner_close() {
    local(async {
        let f = fixture(Profile::Effect, false, false);
        let scope = EffectScope::new();
        scope.attach(&f.live).await.unwrap();
        assert!(f.live.ready().await.is_ok());
        let Err(error) = f.live.dispatch(Msg::Next).await else {
            panic!("lost")
        };
        assert!(Rc::ptr_eq(projection(&error), &f.original));
        assert!(scope.failure().is_none());
        assert!(!scope.is_closing());
        assert!(f.live.reports().is_empty());
        let task = scope.spawn(std::future::pending::<Result<(), Infallible>>());
        let outcome = task.interrupt().await;
        assert!(matches!(outcome, runtime::ScopeExit::Interrupted));
        assert!(scope.is_closed());
        assert_eq!(f.sources.live.get(), 0);
        assert_eq!(f.sources.closed.get(), 3);
        assert_eq!(projection(&error).value.get(), 73);
    })
    .await;
}
#[tokio::test(flavor = "current_thread")]
async fn bounded_stop_preserves_in_progress_cleanup_until_its_original_owner_finishes() {
    local(async {
        for profile in [Profile::Promise, Profile::Effect] {
            let f = fixture(profile, false, true);
            assert!(f.live.ready().await.is_ok());
            f.sources.hold.set(true);
            let Err(error) = f.live.dispatch(Msg::Next).await else {
                panic!("lost")
            };
            f.live.stop().await;
            assert_eq!(f.live.gate(), Gate::Closed);
            assert_eq!(f.sources.live.get(), 2);
            assert!(
                f.live
                    .reports()
                    .iter()
                    .any(|r| matches!(*r.error, RuntimeError::DisposeTimeout { .. }))
            );
            assert!(Rc::ptr_eq(projection(&error), &f.original));
            f.sources.release.notify_waiters();
            for _ in 0..50 {
                if f.sources.live.get() == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
            assert_eq!(f.sources.live.get(), 0);
            assert_eq!(f.sources.closed.get(), 2);
        }
    })
    .await;
}

#[test]
fn opaque_borrowed_cause_needs_no_actor_or_formatting_bound() {
    struct Borrowed<'a>(&'a Cell<u8>);
    let marker = Cell::new(73);
    let cause = Rc::new(Borrowed(&marker));
    let owner = Rc::clone(&cause);
    let projection = try_subscriptions(move |_: &&str| -> Result<Vec<Sub<()>>, Rc<Borrowed<'_>>> {
        Err(Rc::clone(&owner))
    });
    let result =
        demlik_tea::core::SubscriptionProjection::evaluate(projection.as_ref(), &"borrowed");
    let failure: RuntimeError<Infallible, Infallible, Rc<Borrowed<'_>>> =
        RuntimeError::Projection {
            failures: result.failures,
        };
    let RuntimeError::Projection { failures } = failure else {
        unreachable!()
    };
    let ProjectionError::Declared(retained) = &failures[0].cause else {
        panic!("cause erased")
    };
    assert!(Rc::ptr_eq(retained, &cause));
    retained.0.set(74);
    assert_eq!(marker.get(), 74);
}

#[test]
fn restored_canonical_agent_state_is_not_admitted_early_or_copied_by_projection() {
    use demlik_tea::agent::{
        self, AgentConfig, AgentError, OptionalProfile,
        types::{AgentField, AgentTurn, Conversation},
    };
    use demlik_tea::llm_call::{self, LlmCall, Schema};
    use demlik_tea::resilience::resilient_call::CallValue;
    struct Parser;
    impl Schema for Parser {
        type Raw = Rc<AgentTurn>;
        type Output = Rc<AgentTurn>;
        type Error = Infallible;
        fn parse(&self, v: Self::Raw) -> Result<Self::Output, CallValue<Infallible>> {
            Ok(v)
        }
    }
    struct Tool;
    impl Tagged for Tool {
        fn tag(&self) -> &str {
            "tool"
        }
    }
    struct Stage<'a>(&'a Cell<u8>);
    let marker = Cell::new(73);
    let stage = Rc::new(Stage(&marker));
    let schema = Rc::new(Parser);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schema)),
        |_: &Infallible| Ok("unreachable".into()),
    ));
    let agent = agent::create_agent(
        AgentConfig::new(
            llm,
            vec![Rc::clone(&stage)],
            |_| "audit",
            |_| Tool,
            |_, _: &Rc<Conversation<Stage<'_>, AgentTurn, Stage<'_>>>, _| (),
            |turn: &AgentTurn| turn,
        )
        .deadline_ms(25.0),
    );
    let active = agent.start(&agent.init(), "run", 0.0).unwrap().state;
    let mut malformed = active.as_ref().clone();
    malformed.compaction = AgentField::Absent;
    let malformed = Rc::new(malformed);
    let run = Rc::clone(&malformed.run);
    let tools = Rc::clone(&malformed.tools);
    let store = storage::memory_store(Some(Rc::clone(&malformed)));
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let restored = rt.block_on(storage::restore(&store)).unwrap().unwrap();
    assert!(Rc::ptr_eq(&restored, &malformed));
    let caught = RefCell::new(None);
    let projection = SubscriptionEntries::new(vec![SubEntry::try_new("deadline", |state| {
        agent.subs(state).map(Some).map_err(|cause| {
            let cause = Rc::new(cause);
            caught.replace(Some(Rc::clone(&cause)));
            cause
        })
    })]);
    let evaluation =
        demlik_tea::core::SubscriptionProjection::evaluate(&projection, restored.as_ref());
    let ProjectionError::Declared(cause) = &evaluation.failures[0].cause else {
        panic!("agent refusal erased")
    };
    assert!(Rc::ptr_eq(cause, caught.borrow().as_ref().unwrap()));
    assert!(matches!(
        cause.as_ref(),
        AgentError::UnsupportedRestoredProfile {
            profile: OptionalProfile::MissingCompaction,
            ..
        }
    ));
    assert!(Rc::ptr_eq(&restored.run, &run) && Rc::ptr_eq(&restored.tools, &tools));
    assert!(Rc::ptr_eq(&restored.current_stage().unwrap(), &stage));
    stage.0.set(74);
    assert_eq!(marker.get(), 74);
}
