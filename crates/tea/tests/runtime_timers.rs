use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{NoInterpreter, NoSubscriptions, Options, Profile, RuntimeTimer, launch};
use demlik_tea::timing::{Timer, TimerCallback, TimerError};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use std::{cell::RefCell, convert::Infallible, rc::Rc, sync::Arc, time::Duration};
messages! {#[derive(serde::Serialize)] #[serde(tag="type")] enum Msg { Tick, Cancel }}
struct State(u32);
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
enum Cmd {}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, _: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        match self {}
    }
}
fn machine(ms: f64) -> Machine<'static, State, Msg, Cmd, Sub<demlik_tea::TimerDeps<Msg>>> {
    Machine {
        init: Box::new(|_, _| Step::new(State(0), vec![])),
        update: Update::reducer(|_: &State, msg: &Msg| {
            Step::new(State(if matches!(msg, Msg::Tick) { 1 } else { 2 }), vec![])
        }),
        subscriptions: demlik_tea::core::subscriptions(move |state: &State| {
            if state.0 == 0 {
                vec![Sub::timer(ms, Msg::Tick).unwrap()]
            } else {
                vec![]
            }
        }),
    }
}
#[derive(Default)]
struct Host {
    log: RefCell<Vec<String>>,
    pending: RefCell<Option<TimerCallback>>,
}
impl Timer for Host {
    type Handle = ();
    fn now_ms(&self) -> f64 {
        17.25
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<(), TimerError> {
        self.log.borrow_mut().push(format!("arm:{ms}"));
        *self.pending.borrow_mut() = Some(callback);
        Ok(())
    }
    fn clear_timeout(&self, _: &()) {
        self.log.borrow_mut().push("clear".into());
        self.pending.borrow_mut().take();
    }
}
#[tokio::test(flavor = "current_thread")]
async fn missing_authored_runner_uses_typed_builtin_and_reconciliation_explicitly_clears_it() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let host = Rc::new(Host::default());
                let mut options: Options<State, Msg, Infallible, Infallible> =
                    Options::new(profile);
                options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
                options.terminal = Some(Rc::new(|s: &State| s.0 == 1));
                let runtime = launch(
                    machine(15.5),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                assert_eq!(&*host.log.borrow(), &["arm:15.5"]);
                let callback = host.pending.borrow_mut().take().unwrap();
                callback().unwrap();
                runtime.done().await.unwrap();
                assert_eq!(runtime.get_state().unwrap().0, 1);
                runtime.stop().await;
                assert_eq!(
                    &*host.log.borrow(),
                    if profile == Profile::Promise {
                        &["arm:15.5", "clear"][..]
                    } else {
                        &["arm:15.5"][..]
                    }
                );
                let host = Rc::new(Host::default());
                let mut options: Options<State, Msg, Infallible, Infallible> =
                    Options::new(profile);
                options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
                let runtime = launch(
                    machine(99.0),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                runtime.stop().await;
                assert!(host.pending.borrow().is_none());
                assert_eq!(&*host.log.borrow(), &["arm:99", "clear"]);
            }
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn default_timer_fires_without_message_clone_or_deserialization() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let mut options: Options<State, Msg, Infallible, Infallible> =
                    Options::new(profile);
                options.terminal = Some(Rc::new(|s: &State| s.0 == 1));
                let runtime = launch(
                    machine(1.0),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                let state = tokio::time::timeout(Duration::from_secs(1), runtime.done())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(state.0, 1);
                assert!(Arc::ptr_eq(&state, &runtime.get_state().unwrap()));
                runtime.stop().await;
            }
        })
        .await;
}

struct Override;
impl demlik_tea::runtime::Subscriptions<Sub<demlik_tea::TimerDeps<Msg>>, Msg> for Override {
    type Error = Infallible;
    fn start(
        &self,
        _: Sub<demlik_tea::TimerDeps<Msg>>,
        producer: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<demlik_tea::runtime::SubscriptionWork<Infallible>>, Infallible> {
        producer.emit(Msg::Cancel).unwrap();
        Ok(Some(demlik_tea::runtime::SubscriptionWork::new(|| async {
            Ok(())
        })))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn an_authored_timer_runner_overrides_the_builtin_and_exceptional_effect_delays_keep_the_source_profile()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let host = Rc::new(Host::default());
                let mut options: Options<State, Msg, Infallible, Infallible> =
                    Options::new(profile);
                options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
                let runtime = launch(machine(15.0), (), NoInterpreter::new(), Override, options);
                runtime.ready().await.unwrap();
                runtime.idle().await.unwrap();
                assert_eq!(runtime.get_state().unwrap().0, 2);
                assert!(host.log.borrow().is_empty());
                runtime.stop().await;
            }
            for ms in [0.0, -1.0, f64::NAN, f64::NEG_INFINITY, 0.0000001] {
                let host = Rc::new(Host::default());
                let mut options: Options<State, Msg, Infallible, Infallible> =
                    Options::new(Profile::Effect);
                options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
                options.terminal = Some(Rc::new(|s: &State| s.0 == 1));
                let runtime = launch(
                    machine(ms),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                tokio::time::timeout(Duration::from_secs(1), runtime.done())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    host.log.borrow().is_empty(),
                    "Effect yields without a host timer for {ms}"
                );
                runtime.stop().await;
            }
            let host = Rc::new(Host::default());
            let mut options: Options<State, Msg, Infallible, Infallible> =
                Options::new(Profile::Effect);
            options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
            let runtime = launch(
                machine(f64::INFINITY),
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            runtime.idle().await.unwrap();
            assert_eq!(runtime.get_state().unwrap().0, 0);
            assert!(host.log.borrow().is_empty());
            runtime.stop().await;
            let host = Rc::new(Host::default());
            let mut options: Options<State, Msg, Infallible, Infallible> =
                Options::new(Profile::Effect);
            options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
            let runtime = launch(
                machine(2_147_483_649.5),
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            assert_eq!(&*host.log.borrow(), &["arm:2147483647"]);
            host.pending.borrow_mut().take().unwrap()().unwrap();
            tokio::task::yield_now().await;
            assert_eq!(&*host.log.borrow(), &["arm:2147483647", "arm:2.5"]);
            runtime.stop().await;
            assert!(host.pending.borrow().is_none());
        })
        .await;
}

#[derive(serde::Serialize)]
struct CustomDeps {
    label: String,
}
type Mixed = demlik_tea::EitherSub<Sub<CustomDeps>, Sub<demlik_tea::TimerDeps<Msg>>>;
struct Custom {
    log: Rc<RefCell<Vec<String>>>,
}
impl demlik_tea::runtime::Subscriptions<Mixed, Msg> for Custom {
    type Error = Infallible;
    fn has_runner(&self, kind: &str) -> bool {
        kind == "custom"
    }
    fn start(
        &self,
        sub: Mixed,
        _: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<demlik_tea::runtime::SubscriptionWork<Infallible>>, Infallible> {
        let demlik_tea::EitherSub::Left(sub) = sub else {
            panic!("timer must use builtin")
        };
        let label = sub.into_parts().2.label;
        self.log.borrow_mut().push(format!("start:{label}"));
        let log = Rc::clone(&self.log);
        Ok(Some(demlik_tea::runtime::SubscriptionWork::new(
            move || {
                log.borrow_mut().push(format!("close:{label}"));
                async { Ok(()) }
            },
        )))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn one_machine_mixes_owned_custom_deps_and_builtin_timer_without_erasing_message_types() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let log = Rc::new(RefCell::new(vec![]));
                let host = Rc::new(Host::default());
                let machine: Machine<'static, State, Msg, Cmd, Mixed> = Machine {
                    init: Box::new(|_, _| Step::new(State(0), vec![])),
                    update: Update::reducer(|_: &State, _: &Msg| Step::new(State(1), vec![])),
                    subscriptions: demlik_tea::core::subscriptions(|s: &State| {
                        if s.0 == 0 {
                            vec![
                                demlik_tea::EitherSub::Left(
                                    Sub::new(
                                        "custom",
                                        CustomDeps {
                                            label: "owned source".into(),
                                        },
                                    )
                                    .unwrap(),
                                ),
                                demlik_tea::EitherSub::Right(Sub::timer(20.0, Msg::Tick).unwrap()),
                            ]
                        } else {
                            vec![]
                        }
                    }),
                };
                let mut options: Options<State, Msg, Infallible, Infallible> =
                    Options::new(profile);
                options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
                options.terminal = Some(Rc::new(|s: &State| s.0 == 1));
                let runtime = launch(
                    machine,
                    (),
                    NoInterpreter::new(),
                    Custom {
                        log: Rc::clone(&log),
                    },
                    options,
                );
                runtime.ready().await.unwrap();
                host.pending.borrow_mut().take().unwrap()().unwrap();
                runtime.done().await.unwrap();
                runtime.stop().await;
                assert_eq!(
                    &*log.borrow(),
                    &["start:owned source", "close:owned source"]
                );
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn external_host_cancellation_of_a_pending_timer_never_becomes_a_completion_message() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let host = Rc::new(Host::default());
                let mut options: Options<State, Msg, Infallible, Infallible> =
                    Options::new(profile);
                options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
                let runtime = launch(
                    machine(99.0),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                host.clear_timeout(&());
                for _ in 0..24 {
                    tokio::task::yield_now().await;
                }
                assert_eq!(
                    runtime.get_state().unwrap().0,
                    0,
                    "clearing a host callback does not fire its message"
                );
                runtime.stop().await;
                assert_eq!(&*host.log.borrow(), &["arm:99", "clear", "clear"]);
            }
        })
        .await;
}
