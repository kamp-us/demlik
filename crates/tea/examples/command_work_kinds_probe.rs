use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::ports::{Port, define_port};
use demlik_tea::runtime::{
    CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence, Profile,
    RuntimeError, launch,
};
use demlik_tea::storage::{Migrated, Store};
use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use futures::future::pending;
use serde::Serialize;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;
use tokio::sync::{Notify, oneshot};

type Log = Rc<RefCell<Vec<Value>>>;
type PendingReply = Rc<RefCell<Option<oneshot::Receiver<Result<usize, Cause>>>>>;
struct Original {
    _not_clone_debug: String,
    _not_send: Rc<()>,
}
type Cause = Rc<Original>;
struct HandlerError(Cause);
impl std::fmt::Debug for HandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HandlerError(original Rc)")
    }
}
#[derive(Serialize)]
struct State {
    applied: usize,
    completed: usize,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
enum Msg {
    Go,
    Completed,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Go => "go",
            Self::Completed => "completed",
        }
    }
}
impl demlik_tea::core::Message for Msg {
    const TYPES: &'static [&'static str] = &["go", "completed"];
}
enum Cmd {
    Gate,
    Probe,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Gate => "gate",
            Self::Probe => "probe",
        }
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, completion: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(completion)
    }
}
#[derive(Clone, Copy)]
enum Kind {
    Lazy,
    ReadySuccess,
    ReadyFailure,
    PendingSuccess,
    PendingFailure,
    Sync,
    Fail,
    Gen,
}
impl Kind {
    fn promise(self) -> bool {
        matches!(
            self,
            Self::ReadySuccess | Self::ReadyFailure | Self::PendingSuccess | Self::PendingFailure
        )
    }
    fn pending(self) -> bool {
        matches!(self, Self::PendingSuccess | Self::PendingFailure)
    }
    fn failure(self) -> bool {
        matches!(self, Self::ReadyFailure | Self::PendingFailure | Self::Fail)
    }
}
#[derive(Clone)]
struct Shared {
    log: Log,
    entered: Rc<Notify>,
    gate: Rc<Notify>,
    tail_done: Rc<Notify>,
    factory: Rc<Cell<usize>>,
    body: Rc<Cell<usize>>,
    continuation: Rc<Cell<usize>>,
    cleanup: Rc<Cell<usize>>,
    made: Rc<Cell<usize>>,
    stopped: Rc<Cell<bool>>,
    resolved: Rc<Cell<bool>>,
    cause_same: Rc<Cell<bool>>,
    marker: Rc<()>,
    receiver: PendingReply,
    cause: Cause,
    port: Port<(String, Rc<()>)>,
    kind: Kind,
}
impl Shared {
    fn record(&self, row: Value) {
        self.log.borrow_mut().push(row);
    }
    fn emit(&self, ctx: &CommandContext<Msg, HandlerError>, phase: &str) {
        self.record(json!(["port:attempt", phase, self.stopped.get()]));
        ctx.emit(&self.port, (phase.to_owned(), Rc::clone(&self.marker)));
    }
    fn finish(
        &self,
        result: Result<usize, Cause>,
        ctx: &CommandContext<Msg, HandlerError>,
    ) -> Result<Vec<Msg>, HandlerError> {
        self.continuation.set(self.continuation.get() + 1);
        self.resolved.set(true);
        match result {
            Ok(value) => {
                self.record(json!(["promise:success", value, self.stopped.get()]));
                self.emit(ctx, "promise-success");
                self.tail_done.notify_one();
                Ok(vec![Msg::Completed])
            }
            Err(cause) => {
                self.cause_same.set(Rc::ptr_eq(&cause, &self.cause));
                self.record(json!([
                    "promise:failure",
                    self.cause_same.get(),
                    self.stopped.get()
                ]));
                self.emit(ctx, "promise-failure");
                self.tail_done.notify_one();
                Err(HandlerError(cause))
            }
        }
    }
}
impl Interpreter<Cmd> for Shared {
    type Error = HandlerError;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Cmd,
        ctx: CommandContext<Msg, HandlerError>,
    ) -> Option<CommandWork<'a, Vec<Msg>, HandlerError>> {
        if matches!(cmd, Cmd::Gate) {
            return Some(
                CommandWork::new(async {
                    self.record(json!(["gate:body"]));
                    self.gate.notify_one();
                    pending().await
                })
                .with_cleanup(|| async {
                    self.record(json!(["gate:cleanup"]));
                    Ok(())
                }),
            );
        }
        self.made.set(self.made.get() + 1);
        self.record(json!(["probe:constructed", self.stopped.get()]));
        let work = if self.kind.promise() {
            CommandWork::promise(move |signal| {
                self.factory.set(self.factory.get() + 1);
                self.record(json!(["promise:signal-at-factory", signal.aborted()]));
                assert!(signal.on_abort(|| {
                    self.record(json!(["promise:signal-abort", self.stopped.get()]))
                }));
                self.record(json!(["promise:factory", self.stopped.get()]));
                self.emit(&ctx, "promise-factory");
                self.entered.notify_one();
                let receiver = if self.kind.pending() {
                    self.receiver.borrow_mut().take()
                } else {
                    None
                };
                async move {
                    // This future borrows the interpreter for its entire late tail.
                    let result = if let Some(receiver) = receiver {
                        receiver.await.expect("controller owns sender")
                    } else if self.kind.failure() {
                        Err(Rc::clone(&self.cause))
                    } else {
                        Ok(17)
                    };
                    self.finish(result, &ctx)
                }
            })
        } else {
            CommandWork::effect(async move {
                if matches!(self.kind, Kind::Fail) {
                    return Err(HandlerError(Rc::clone(&self.cause)));
                }
                self.body.set(self.body.get() + 1);
                self.record(json!(["effect:body", self.stopped.get()]));
                self.emit(&ctx, "effect-body");
                self.entered.notify_one();
                if matches!(self.kind, Kind::Lazy) {
                    pending().await
                } else {
                    Ok(vec![Msg::Completed])
                }
            })
        };
        Some(work.with_cleanup(|| async {
            self.cleanup.set(self.cleanup.get() + 1);
            self.record(json!(["probe:cleanup", self.stopped.get()]));
            Ok(())
        }))
    }
}
#[derive(Clone)]
struct Saved {
    log: Log,
    states: Rc<RefCell<Vec<Value>>>,
}
impl Store<State> for Saved {
    type Raw = ();
    type Error = std::convert::Infallible;
    async fn load(&self) -> Result<(), std::convert::Infallible> {
        self.log.borrow_mut().push(json!(["store:load"]));
        Ok(())
    }
    fn migrate(&self, _: ()) -> Migrated<State> {
        Migrated::Fresh
    }
    async fn save(&self, state: &State) -> Result<(), std::convert::Infallible> {
        self.log
            .borrow_mut()
            .push(json!(["store:save", state.applied, state.completed]));
        self.states.borrow_mut().push(json!(state));
        Ok(())
    }
}
fn snapshot(state: &State, shared: &Shared, store: &Saved) -> Value {
    json!({"state":state,"saves":store.states.borrow().len(),"factory":shared.factory.get(),"body":shared.body.get(),"continuation":shared.continuation.get(),"cleanups":shared.cleanup.get(),"externalResolved":shared.resolved.get()})
}
async fn one(id: &str, kind: Kind, pre: bool) -> Value {
    let log = Rc::new(RefCell::new(vec![]));
    let (sender, receiver) = oneshot::channel();
    let shared = Shared {
        log: Rc::clone(&log),
        entered: Rc::new(Notify::new()),
        gate: Rc::new(Notify::new()),
        tail_done: Rc::new(Notify::new()),
        factory: Rc::new(Cell::new(0)),
        body: Rc::new(Cell::new(0)),
        continuation: Rc::new(Cell::new(0)),
        cleanup: Rc::new(Cell::new(0)),
        made: Rc::new(Cell::new(0)),
        stopped: Rc::new(Cell::new(false)),
        resolved: Rc::new(Cell::new(false)),
        cause_same: Rc::new(Cell::new(false)),
        marker: Rc::new(()),
        receiver: Rc::new(RefCell::new(Some(receiver))),
        cause: Rc::new(Original {
            _not_clone_debug: id.to_owned(),
            _not_send: Rc::new(()),
        }),
        port: define_port(format!("work-kinds-{id}")).unwrap_or_else(|_| panic!("unique port")),
        kind,
    };
    let store = Saved {
        log: Rc::clone(&log),
        states: Rc::new(RefCell::new(vec![])),
    };
    let machine: Machine<'static, State, Msg, Cmd, Sub, ()> = Machine {
        init: Box::new(|_, _| {
            Step::new(
                State {
                    applied: 0,
                    completed: 0,
                },
                vec![],
            )
        }),
        update: Update::reducer(move |state: &State, msg: &Msg| match msg {
            Msg::Go => Step::new(
                State {
                    applied: state.applied + 1,
                    completed: state.completed,
                },
                if pre {
                    vec![Cmd::Gate, Cmd::Probe]
                } else {
                    vec![Cmd::Probe]
                },
            ),
            Msg::Completed => Step::new(
                State {
                    applied: state.applied + 1,
                    completed: state.completed + 1,
                },
                vec![],
            ),
        }),
        subscriptions: demlik_tea::core::subscriptions(|_: &State| vec![]),
    };
    let mut options: Options<State, Msg, std::convert::Infallible, HandlerError> =
        Options::new(Profile::Effect);
    options.store = Some(Persistence::new(store.clone()));
    options.dispose_timeout = Duration::from_millis(100);
    let committed = Rc::new(RefCell::new(vec![]));
    let reports = Rc::new(RefCell::new(vec![]));
    let report_log = Rc::clone(&log);
    let report_rows = Rc::clone(&reports);
    let cause = Rc::clone(&shared.cause);
    options.on_error = Some(Rc::new(move |error, phase| {
        let same = matches!(error, RuntimeError::Handler(value) if Rc::ptr_eq(&value.0,&cause));
        let phase = serde_json::to_value(phase).expect("phase wire");
        report_log.borrow_mut().push(json!(["report", phase, same]));
        report_rows
            .borrow_mut()
            .push(json!({"phase":phase,"name":error.name(),"originalSame":same}));
    }));
    let runtime = launch(machine, (), shared.clone(), NoSubscriptions::new(), options);
    if runtime.ready().await.is_err() {
        panic!("fresh ready");
    }
    let marker = Rc::clone(&shared.marker);
    let port_log = Rc::clone(&log);
    let stopped = Rc::clone(&shared.stopped);
    let _unsub = runtime.subscribe_port(
        &shared.port,
        Rc::new(move |value| {
            port_log.borrow_mut().push(json!([
                "port:received",
                value.0,
                Rc::ptr_eq(&value.1, &marker),
                stopped.get()
            ]))
        }),
    );
    let observer_log = Rc::clone(&log);
    let commits = Rc::clone(&committed);
    let stopped = Rc::clone(&shared.stopped);
    let _observe = runtime.observe(move |msg, _| {
        commits.borrow_mut().push(msg.tag().to_owned());
        observer_log
            .borrow_mut()
            .push(json!(["commit", msg.tag(), stopped.get()]));
    });
    assert_eq!(shared.factory.get(), 0);
    assert_eq!(shared.body.get(), 0);
    assert_eq!(shared.made.get(), 0);
    let pending = {
        let rt = runtime.clone();
        tokio::task::spawn_local(async move { rt.dispatch_once(Msg::Go).await })
    };
    if pre {
        shared.gate.notified().await;
    } else {
        shared.entered.notified().await;
    }
    shared.record(json!(["stop:called"]));
    runtime.stop().await;
    shared.stopped.set(true);
    shared.record(json!(["stop:returned"]));
    let answer = pending.await.expect("dispatch task not panicked");
    let dispatch = json!({"kind":if answer.is_ok(){"Success"}else{"Failure"},"originalSame":matches!(&answer,Err(error) if matches!(&**error, RuntimeError::Handler(cause) if Rc::ptr_eq(&cause.0,&shared.cause)))});
    shared.record(json!(["dispatch:exit", dispatch]));
    let after_stop = snapshot(&runtime.get_state().expect("state"), &shared, &store);
    let mut sender_accepted = None;
    if kind.pending() {
        shared.record(json!(["controller:settle-after-stop"]));
        let result = if kind.failure() {
            Err(Rc::clone(&shared.cause))
        } else {
            Ok(17)
        };
        let accepted = sender.send(result).is_ok();
        sender_accepted = Some(accepted);
        if accepted && shared.factory.get() > 0 {
            shared.tail_done.notified().await;
        }
    }
    if runtime.idle().await.is_err() {
        panic!("idle");
    }
    shared.record(json!(["idle:returned"]));
    let final_state = snapshot(&runtime.get_state().expect("state"), &shared, &store);
    json!({"id":id,"afterStop":after_stop,"final":final_state,"constructed":shared.made.get(),"dispatch":dispatch,"commits":committed.borrow().as_slice(),"reports":reports.borrow().as_slice(),"savedStates":store.states.borrow().as_slice(),"trace":log.borrow().as_slice(),"senderAcceptedAfterStop":sender_accepted,"originalCauseRetained":if kind.failure(){Some(shared.cause_same.get())}else{None},"nativeSignalAPI":"explicit local CommandSignal"})
}
fn borrowed_constructor<'a>(
    calls: &'a Cell<usize>,
    input: &'a Original,
    result: &'a Rc<Original>,
    error: &'a Rc<Original>,
) -> CommandWork<'a, &'a Rc<Original>, &'a Rc<Original>> {
    CommandWork::promise(move |signal| {
        calls.set(calls.get() + 1);
        assert!(!signal.aborted());
        let _input = input;
        async move {
            if Rc::ptr_eq(result, error) {
                Err(error)
            } else {
                Ok(result)
            }
        }
    })
    .with_cleanup(|| async { Ok(()) })
}
fn borrowed_construction_is_lazy() {
    let calls = Cell::new(0);
    let input = Original {
        _not_clone_debug: String::from("borrowed"),
        _not_send: Rc::new(()),
    };
    let result = Rc::new(Original {
        _not_clone_debug: String::from("result"),
        _not_send: Rc::new(()),
    });
    let error = Rc::new(Original {
        _not_clone_debug: String::from("error"),
        _not_send: Rc::new(()),
    });
    let work = borrowed_constructor(&calls, &input, &result, &error);
    assert_eq!(calls.get(), 0);
    drop(work);
    assert_eq!(calls.get(), 0);
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    borrowed_construction_is_lazy();
    tokio::task::LocalSet::new()
        .run_until(async {
            for (id, kind, pre) in [
                ("lazy-effect.pre", Kind::Lazy, true),
                ("promise-ready-success.pre", Kind::ReadySuccess, true),
                ("promise-ready-failure.pre", Kind::ReadyFailure, true),
                ("promise-pending-success.pre", Kind::PendingSuccess, true),
                ("promise-pending-success.mid", Kind::PendingSuccess, false),
                ("promise-pending-failure.mid", Kind::PendingFailure, false),
                ("ready-effect-sync.pre", Kind::Sync, true),
                ("ready-effect-fail.pre", Kind::Fail, true),
                ("ready-effect-generator.pre", Kind::Gen, true),
            ] {
                println!("{}", one(id, kind, pre).await);
            }
        })
        .await;
}
