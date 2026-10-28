use std::cell::{Cell, RefCell};
use std::convert::Infallible;
use std::rc::{Rc, Weak};

use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile, RuntimeError,
    launch,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use tokio::sync::{Notify, oneshot};

struct Opaque<'a> {
    borrowed: &'a str,
    local: Rc<()>,
}
struct Failure(Rc<Opaque<'static>>);
impl std::fmt::Debug for Failure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("Failure")
            .field(&Rc::as_ptr(&self.0))
            .finish()
    }
}
struct State(u8);
messages! { enum Msg { Go, Done } }
struct Cmd {
    input: Rc<Opaque<'static>>,
    settled: Rc<Cell<usize>>,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "work"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, output: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        self.settled.set(self.settled.get() + 1);
        Ok(output)
    }
}
struct Guard(Rc<Cell<usize>>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.set(self.0.get() + 1);
    }
}
#[derive(Clone, Copy)]
enum Mode {
    Normal,
    FactoryPanic,
    Pending,
}
struct Data {
    input: Rc<Opaque<'static>>,
    failure: Rc<Opaque<'static>>,
    drops: Rc<Cell<usize>>,
    weak: RefCell<Option<Weak<Guard>>>,
    entered: Notify,
    tail_done: Notify,
    receiver: RefCell<Option<oneshot::Receiver<()>>>,
    cleanup: Cell<usize>,
    aborts: Cell<usize>,
    settled: Rc<Cell<usize>>,
    continued: Cell<bool>,
    borrowed_input_same: Cell<bool>,
    late_registration_refused: Cell<bool>,
}
impl Data {
    fn new() -> Rc<Self> {
        Rc::new(Self {
            input: Rc::new(Opaque {
                borrowed: "original input",
                local: Rc::new(()),
            }),
            failure: Rc::new(Opaque {
                borrowed: "original failure",
                local: Rc::new(()),
            }),
            drops: Rc::new(Cell::new(0)),
            weak: RefCell::new(None),
            entered: Notify::new(),
            tail_done: Notify::new(),
            receiver: RefCell::new(None),
            cleanup: Cell::new(0),
            aborts: Cell::new(0),
            settled: Rc::new(Cell::new(0)),
            continued: Cell::new(false),
            borrowed_input_same: Cell::new(false),
            late_registration_refused: Cell::new(false),
        })
    }
}
struct Handler {
    data: Rc<Data>,
    mode: Mode,
}
impl Interpreter<Cmd> for Handler {
    type Error = Failure;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Failure>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Failure>> {
        Some(
            CommandWork::promise(move |signal| {
                assert!(!signal.aborted());
                let guard = Rc::new(Guard(Rc::clone(&self.data.drops)));
                *self.data.weak.borrow_mut() = Some(Rc::downgrade(&guard));
                let retained_signal = signal.clone();
                assert!(signal.on_abort(move || {
                    assert!(retained_signal.aborted());
                    self.data.aborts.set(self.data.aborts.get() + 1);
                    assert!(!retained_signal.on_abort(|| panic!("closed registration reopened")));
                    drop(guard);
                }));
                if matches!(self.mode, Mode::FactoryPanic) {
                    panic!("factory failure witness");
                }
                let receiver = self.data.receiver.borrow_mut().take();
                self.data.entered.notify_one();
                async move {
                    if let Some(receiver) = receiver {
                        receiver.await.expect("controller owns release");
                    }
                    self.data
                        .borrowed_input_same
                        .set(Rc::ptr_eq(&command.input, &self.data.input));
                    assert_eq!(command.input.borrowed, "original input");
                    assert!(Rc::ptr_eq(&command.input.local, &self.data.input.local));
                    if matches!(self.mode, Mode::Pending) {
                        assert!(signal.aborted());
                        self.data
                            .late_registration_refused
                            .set(!signal.on_abort(|| panic!("late callback ran")));
                        self.data.continued.set(true);
                        self.data.tail_done.notify_one();
                        Err(Failure(Rc::clone(&self.data.failure)))
                    } else {
                        Ok(vec![Msg::Done])
                    }
                }
            })
            .with_cleanup(|| async {
                // Native scope teardown releases callback captures before user cleanup.
                assert_eq!(self.data.drops.get(), 1);
                self.data.cleanup.set(self.data.cleanup.get() + 1);
                Ok(())
            }),
        )
    }
}
fn machine(data: Rc<Data>) -> Machine<'static, State, Msg, Cmd, Sub, ()> {
    Machine {
        init: Box::new(|_, _| Step::new(State(0), vec![])),
        update: Update::reducer(move |_: &State, msg: &Msg| match msg {
            Msg::Go => Step::new(
                State(1),
                vec![Cmd {
                    input: Rc::clone(&data.input),
                    settled: Rc::clone(&data.settled),
                }],
            ),
            Msg::Done => Step::new(State(2), vec![]),
        }),
        subscriptions: demlik_tea::core::subscriptions(|_: &State| vec![]),
    }
}
fn options() -> Options<State, Msg, Infallible, Failure> {
    Options::new(Profile::Effect)
}

#[tokio::test(flavor = "current_thread")]
async fn normal_completion_releases_self_capturing_listener() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let data = Data::new();
            let runtime = launch(
                machine(Rc::clone(&data)),
                (),
                Handler {
                    data: Rc::clone(&data),
                    mode: Mode::Normal,
                },
                NoSubscriptions::new(),
                options(),
            );
            runtime.ready().await.unwrap();
            runtime.dispatch_once(Msg::Go).await.unwrap();
            runtime.idle().await.unwrap();
            assert_eq!(runtime.get_state().unwrap().0, 2);
            assert_eq!(data.cleanup.get(), 1);
            assert_eq!(data.drops.get(), 1);
            assert_eq!(data.aborts.get(), 0);
            assert_eq!(data.settled.get(), 1);
            assert!(data.borrowed_input_same.get());
            assert!(data.weak.borrow().as_ref().unwrap().upgrade().is_none());
            runtime.stop().await;
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn factory_panic_releases_listener_before_cleanup() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let data = Data::new();
            let runtime = launch(
                machine(Rc::clone(&data)),
                (),
                Handler {
                    data: Rc::clone(&data),
                    mode: Mode::FactoryPanic,
                },
                NoSubscriptions::new(),
                options(),
            );
            runtime.ready().await.unwrap();
            let error = runtime.dispatch_once(Msg::Go).await.unwrap_err();
            assert!(matches!(&*error, RuntimeError::Panic(_)));
            assert_eq!(data.cleanup.get(), 1);
            assert_eq!(data.drops.get(), 1);
            assert_eq!(data.aborts.get(), 0);
            assert_eq!(data.settled.get(), 0);
            assert!(data.weak.borrow().as_ref().unwrap().upgrade().is_none());
            runtime.stop().await;
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn interrupted_original_borrowed_tail_observes_closed_aborted_signal() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let data = Data::new();
            let (release, receiver) = oneshot::channel();
            *data.receiver.borrow_mut() = Some(receiver);
            let runtime = launch(
                machine(Rc::clone(&data)),
                (),
                Handler {
                    data: Rc::clone(&data),
                    mode: Mode::Pending,
                },
                NoSubscriptions::new(),
                options(),
            );
            runtime.ready().await.unwrap();
            let dispatch = {
                let runtime = runtime.clone();
                tokio::task::spawn_local(async move { runtime.dispatch_once(Msg::Go).await })
            };
            data.entered.notified().await;
            runtime.stop().await;
            dispatch.await.unwrap().unwrap();
            assert_eq!(data.cleanup.get(), 1);
            assert_eq!(data.drops.get(), 1);
            assert_eq!(data.aborts.get(), 1);
            assert!(!data.continued.get());
            assert_eq!(runtime.get_state().unwrap().0, 1);
            let before = runtime.reports().len();
            release.send(()).expect("original operation remains alive");
            data.tail_done.notified().await;
            runtime.idle().await.unwrap();
            assert!(data.continued.get());
            assert!(data.borrowed_input_same.get());
            assert!(data.late_registration_refused.get());
            assert_eq!(data.settled.get(), 0);
            assert_eq!(runtime.get_state().unwrap().0, 1);
            assert_eq!(runtime.reports().len(), before);
            // The late error is the original Rc in the future's declared error lane;
            // it is intentionally not routed as a new runtime handler report.
            assert_eq!(Rc::strong_count(&data.failure), 1);
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn dropping_in_progress_operation_releases_listener_captures() {
    let data = Data::new();
    let (_release, receiver) = oneshot::channel();
    *data.receiver.borrow_mut() = Some(receiver);
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async {
            let runtime = launch(
                machine(Rc::clone(&data)),
                (),
                Handler {
                    data: Rc::clone(&data),
                    mode: Mode::Pending,
                },
                NoSubscriptions::new(),
                options(),
            );
            runtime.ready().await.unwrap();
            tokio::task::spawn_local(async move {
                let _ = runtime.dispatch_once(Msg::Go).await;
            });
            data.entered.notified().await;
            assert_eq!(data.drops.get(), 0);
        })
        .await;
    drop(local);
    assert_eq!(data.drops.get(), 1);
    assert!(data.weak.borrow().as_ref().unwrap().upgrade().is_none());
    // Dropping a Rust task is not an awaited asynchronous-finalizer contract.
    assert_eq!(data.cleanup.get(), 0);
}
#[test]
fn borrowed_opaque_constructor_and_drop_never_invoke_factory() {
    let text = String::from("caller owned");
    let input = Opaque {
        borrowed: &text,
        local: Rc::new(()),
    };
    let result = Rc::new(Opaque {
        borrowed: &text,
        local: Rc::new(()),
    });
    let error = Rc::new(Opaque {
        borrowed: &text,
        local: Rc::new(()),
    });
    let calls = Cell::new(0);
    let work = CommandWork::promise(|signal| {
        calls.set(calls.get() + 1);
        assert!(!signal.aborted());
        async {
            let _original = &input;
            Ok::<_, &Rc<Opaque<'_>>>(&result)
        }
    });
    assert_eq!(calls.get(), 0);
    drop(work);
    assert_eq!(calls.get(), 0);
    assert_eq!(error.borrowed, "caller owned");
}
