use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fmt;
use std::panic::AssertUnwindSafe;
use std::rc::Rc;
use std::sync::Arc;

use futures::{FutureExt, future::LocalBoxFuture};
use indexmap::IndexMap;
use tokio::sync::{Notify, oneshot};

use crate::command::{CommandEdge, CommandFamily};
use crate::storage::PanicCause;
use crate::{Machine, Step, SubId, Subscription, Tagged};

use super::persistence::Backend;
use super::queue::{Job, Mailbox, Notice, Origin};
use super::types::*;
use super::work::{Cancel, Cleanup, WorkFailure, perform};
use super::{CommandContext, Interpreter, Producer, SubscriptionWork, Subscriptions};

type Answer<SE, HE> = Result<(), Failure<SE, HE>>;
type Receipt<SE, HE> = oneshot::Sender<Answer<SE, HE>>;
type DoneReceipt<S, SE, HE> = oneshot::Sender<Result<Arc<S>, Failure<SE, HE>>>;
enum SaveStatus<SE, HE> {
    Pending,
    Saved,
    Failed(Failure<SE, HE>),
}
struct View<S, SE, HE> {
    state: Option<Arc<S>>,
    saved: SaveStatus<SE, HE>,
}
type Observer<S, M> = Rc<dyn Fn(&M, &S)>;
type Boot<S> = Rc<dyn Fn(&S)>;
struct Core<S, M, SE, HE> {
    view: RefCell<View<S, SE, HE>>,
    ready: RefCell<Option<Answer<SE, HE>>>,
    ready_changed: Notify,
    receipts: RefCell<HashMap<u64, Receipt<SE, HE>>>,
    done: RefCell<Vec<DoneReceipt<S, SE, HE>>>,
    stop_started: Cell<bool>,
    stop_done: Cell<bool>,
    stop_changed: Notify,
    reports: RefCell<Vec<Report<SE, HE>>>,
    sink: Option<ErrorSink<SE, HE>>,
    terminal: Option<Terminal<S>>,
    commits: Vec<Commit<S, M>>,
    listeners: RefCell<IndexMap<u64, Rc<dyn Fn()>>>,
    observers: RefCell<IndexMap<u64, Observer<S, M>>>,
    boots: RefCell<IndexMap<u64, Boot<S>>>,
    booted: Cell<bool>,
    next_listener: Cell<u64>,
}
impl<S, M, SE, HE> Core<S, M, SE, HE> {
    fn state(&self) -> Option<Arc<S>> {
        self.view.borrow().state.clone()
    }
    fn report(&self, error: Failure<SE, HE>, phase: ErrorPhase) {
        self.reports.borrow_mut().push(Report {
            phase,
            error: Rc::clone(&error),
        });
        if let Some(sink) = &self.sink {
            if let Err(payload) = std::panic::catch_unwind(AssertUnwindSafe(|| sink(&error, phase)))
            {
                self.reports.borrow_mut().push(Report {
                    phase,
                    error: Rc::new(RuntimeError::Panic(PanicCause::new(payload))),
                });
            }
        } else {
            eprintln!("@demlik/tea: {:?}: {}", phase, error.name());
        }
    }
    fn fanout<T>(&self, items: impl IntoIterator<Item = T>, phase: ErrorPhase, call: impl Fn(T)) {
        for item in items {
            if let Err(payload) = std::panic::catch_unwind(AssertUnwindSafe(|| call(item))) {
                self.report(
                    Rc::new(RuntimeError::Panic(PanicCause::new(payload))),
                    phase,
                );
            }
        }
    }
    fn holds(&self, state: &S) -> bool {
        self.terminal
            .as_ref()
            .is_some_and(|terminal| terminal(state))
    }
    fn result(&self) -> Option<Arc<S>> {
        let view = self.view.borrow();
        if !matches!(view.saved, SaveStatus::Saved) {
            return None;
        }
        let state = view.state.clone()?;
        drop(view);
        self.holds(&state).then_some(state)
    }
    fn done_receiver(&self) -> oneshot::Receiver<Result<Arc<S>, Failure<SE, HE>>> {
        let (tx, rx) = oneshot::channel();
        if let Some(state) = self.state() {
            if self.holds(&state) {
                let view = self.view.borrow();
                match &view.saved {
                    SaveStatus::Saved => {
                        let _ = tx.send(Ok(state));
                        return rx;
                    }
                    SaveStatus::Failed(error) => {
                        let _ = tx.send(Err(Rc::clone(error)));
                        return rx;
                    }
                    SaveStatus::Pending => {}
                }
            }
        }
        self.done.borrow_mut().push(tx);
        rx
    }
    fn save_failed(&self, error: Failure<SE, HE>) {
        self.view.borrow_mut().saved = SaveStatus::Failed(Rc::clone(&error));
        if self.done.borrow().is_empty() {
            return;
        }
        if self.state().is_some_and(|state| self.holds(&state)) {
            for waiter in self.done.borrow_mut().drain(..) {
                let _ = waiter.send(Err(Rc::clone(&error)));
            }
        }
    }
    fn committed(&self, message: Option<&M>, state: &S) {
        self.fanout(
            self.listeners
                .borrow()
                .values()
                .cloned()
                .collect::<Vec<_>>(),
            ErrorPhase::Listener,
            |listener| listener(),
        );
        if let Some(message) = message {
            self.fanout(
                self.observers
                    .borrow()
                    .values()
                    .cloned()
                    .collect::<Vec<_>>(),
                ErrorPhase::Observer,
                |observer| observer(message, state),
            );
        } else {
            self.booted.set(true);
            self.fanout(
                self.boots.borrow().values().cloned().collect::<Vec<_>>(),
                ErrorPhase::Boot,
                |handler| handler(state),
            );
        }
        self.fanout(self.commits.iter(), ErrorPhase::Observer, |commit| {
            commit(message, state)
        });
        if self.done.borrow().is_empty() {
            return;
        }
        let saved = matches!(self.view.borrow().saved, SaveStatus::Saved);
        if saved && self.holds(state) {
            let current = self.state().expect("committed state is installed");
            for waiter in self.done.borrow_mut().drain(..) {
                let _ = waiter.send(Ok(Arc::clone(&current)));
            }
        }
    }
    fn finish_receipt(&self, seq: u64, result: Answer<SE, HE>) {
        if let Some(sender) = self.receipts.borrow_mut().remove(&seq) {
            let _ = sender.send(result);
        }
    }
    fn listener_id(&self) -> u64 {
        let id = self.next_listener.get();
        self.next_listener.set(id + 1);
        id
    }
}

/// Local runtime facade. Its narrow [`Producer`] can cross threads without its callbacks.
pub struct Runtime<S, M, SE, HE> {
    core: Rc<Core<S, M, SE, HE>>,
    producer: Producer<M>,
    stopper: Rc<dyn Fn()>,
    profile: Profile,
    idle_cap: usize,
}
impl<S, M, SE, HE> Clone for Runtime<S, M, SE, HE> {
    fn clone(&self) -> Self {
        Self {
            core: Rc::clone(&self.core),
            producer: self.producer.clone(),
            stopper: Rc::clone(&self.stopper),
            profile: self.profile,
            idle_cap: self.idle_cap,
        }
    }
}
impl<S: 'static, M: Tagged + 'static, SE: 'static, HE: 'static> Runtime<S, M, SE, HE> {
    pub fn producer(&self) -> Producer<M> {
        self.producer.clone()
    }
    pub fn get_state(&self) -> Option<Arc<S>> {
        self.core.state()
    }
    pub fn result(&self) -> Option<Arc<S>> {
        self.core.result()
    }
    pub fn reports(&self) -> Vec<Report<SE, HE>> {
        let notices = self
            .producer
            .mailbox
            .with(|queue| queue.notices.drain(..).collect::<Vec<_>>());
        for Notice::Refused(error) in notices {
            let phase = match &error {
                super::DispatchRefused::Contract(_) => ErrorPhase::Interpret,
                super::DispatchRefused::Stopping { .. } => ErrorPhase::Discard,
                super::DispatchRefused::Stopped { .. } => ErrorPhase::FollowUp,
            };
            self.core.report(refusal(error), phase);
        }
        self.core.reports.borrow().clone()
    }
    pub fn gate(&self) -> Gate {
        self.producer.mailbox.gate()
    }
    pub fn ready(&self) -> impl std::future::Future<Output = Result<Self, Failure<SE, HE>>> {
        let runtime = self.clone();
        async move {
            loop {
                let changed = runtime.core.ready_changed.notified();
                if let Some(result) = runtime.core.ready.borrow().clone() {
                    return result.map(|()| runtime.clone());
                }
                changed.await;
            }
        }
    }
    fn enqueue(&self, message: M) -> Result<oneshot::Receiver<Answer<SE, HE>>, Failure<SE, HE>> {
        let (tx, rx) = oneshot::channel();
        // The actor is local, so it cannot pop the synchronously enqueued job
        // before this receipt is registered; cross-thread producers hold no core.
        let seq = self
            .producer
            .mailbox
            .enqueue(message, Origin::Caller)
            .map_err(refusal)?;
        self.core.receipts.borrow_mut().insert(seq, tx);
        Ok(rx)
    }
    fn dispatch_with(
        &self,
        message: M,
        once: bool,
    ) -> impl std::future::Future<Output = Answer<SE, HE>> {
        let runtime = self.clone();
        let mut pending = Some(message);
        let eager = if self.profile == Profile::Promise {
            Some(self.enqueue(pending.take().expect("message present")))
        } else {
            None
        };
        async move {
            let receipt = match eager {
                Some(receipt) => receipt,
                None => runtime.enqueue(pending.take().expect("lazy message present")),
            }?;
            receipt
                .await
                .expect("runtime retains every accepted receipt")?;
            if !once {
                runtime.idle().await?;
            }
            Ok(())
        }
    }
    pub fn dispatch(&self, message: M) -> impl std::future::Future<Output = Answer<SE, HE>> {
        self.dispatch_with(message, false)
    }
    pub fn dispatch_once(&self, message: M) -> impl std::future::Future<Output = Answer<SE, HE>> {
        self.dispatch_with(message, true)
    }
    pub fn idle(&self) -> impl std::future::Future<Output = Answer<SE, HE>> {
        let mailbox = Arc::clone(&self.producer.mailbox);
        let cap = self.idle_cap;
        async move {
            for _ in 0..cap {
                let target = mailbox.with(|queue| queue.tail);
                wait_tail(&mailbox, target).await;
                if mailbox.with(|queue| queue.tail == target) {
                    return Ok(());
                }
            }
            Err(Rc::new(RuntimeError::QuiescenceTimeout { cap }))
        }
    }
    pub fn done(&self) -> impl std::future::Future<Output = Result<Arc<S>, Failure<SE, HE>>> {
        let core = Rc::clone(&self.core);
        let eager = if self.profile == Profile::Promise {
            Some(core.done_receiver())
        } else {
            None
        };
        async move {
            let receiver = eager.unwrap_or_else(|| core.done_receiver());
            receiver
                .await
                .expect("done waiter is retained until terminal completion")
        }
    }
    pub fn stop(&self) -> impl std::future::Future<Output = ()> {
        let core = Rc::clone(&self.core);
        let stopper = Rc::clone(&self.stopper);
        let eager = self.profile == Profile::Promise;
        if eager {
            (stopper)();
        }
        async move {
            if !eager {
                (stopper)();
            }
            loop {
                let changed = core.stop_changed.notified();
                if core.stop_done.get() {
                    return;
                }
                changed.await;
            }
        }
    }
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Box<dyn FnOnce()> {
        let id = self.core.listener_id();
        self.core
            .listeners
            .borrow_mut()
            .insert(id, Rc::new(listener));
        let core = Rc::clone(&self.core);
        Box::new(move || {
            core.listeners.borrow_mut().shift_remove(&id);
        })
    }
    pub fn observe(&self, observer: impl Fn(&M, &S) + 'static) -> Box<dyn FnOnce()> {
        let id = self.core.listener_id();
        self.core
            .observers
            .borrow_mut()
            .insert(id, Rc::new(observer));
        let core = Rc::clone(&self.core);
        Box::new(move || {
            core.observers.borrow_mut().shift_remove(&id);
        })
    }
    pub fn on_boot(&self, handler: impl Fn(&S) + 'static) -> Box<dyn FnOnce()> {
        if self.core.booted.get() {
            if let Some(state) = self.core.state() {
                self.core
                    .fanout([handler], ErrorPhase::Boot, |handler| handler(&state));
            }
            return Box::new(|| {});
        }
        let id = self.core.listener_id();
        self.core.boots.borrow_mut().insert(id, Rc::new(handler));
        let core = Rc::clone(&self.core);
        Box::new(move || {
            core.boots.borrow_mut().shift_remove(&id);
        })
    }
}
fn refusal<SE, HE>(error: super::DispatchRefused) -> Failure<SE, HE> {
    Rc::new(match error {
        super::DispatchRefused::Stopping { msg_type } => RuntimeError::Discarded { msg_type },
        super::DispatchRefused::Stopped { msg_type } => RuntimeError::Stopped { msg_type },
        super::DispatchRefused::Contract(error) => RuntimeError::Contract(error),
    })
}
fn work_error<SE, HE>(error: WorkFailure<HE>) -> Failure<SE, HE> {
    Rc::new(match error {
        WorkFailure::Failed(error) => RuntimeError::Handler(error),
        WorkFailure::Panic(panic) => RuntimeError::Panic(panic),
        WorkFailure::Cleanup { prior, cause } => RuntimeError::Cleanup {
            prior: prior.map(|prior| work_error(*prior)),
            cause: work_error(*cause),
        },
    })
}
async fn wait_tail<M>(mailbox: &Mailbox<M>, target: u64) {
    loop {
        let changed = mailbox.changed.notified();
        if mailbox.with(|queue| queue.completed >= target) {
            return;
        }
        changed.await;
    }
}

struct Initial<S, C> {
    state: Arc<S>,
    commands: Vec<C>,
}
struct Running<HE> {
    cancel: Arc<Cancel>,
    cleanup: Cleanup<'static, HE>,
    source_done: Option<oneshot::Receiver<()>>,
}
struct Signals<SE, HE> {
    parent: Option<Receipt<SE, HE>>,
    barrier: Option<Receipt<SE, HE>>,
}
struct Env<S, M, C, U, X, SE, HE, I, R> {
    machine: Machine<'static, S, M, C, U, X>,
    input: X,
    interpreter: I,
    subscriptions: R,
    store: Option<Rc<dyn Backend<S, SE>>>,
    core: Rc<Core<S, M, SE, HE>>,
    producer: Producer<M>,
    edge: CommandEdge,
    profile: Profile,
    timeout: std::time::Duration,
    supervision: Supervision<S, M, SE, HE>,
    cancel: Arc<Cancel>,
    running: RefCell<IndexMap<SubId, Running<HE>>>,
    in_flight: RefCell<IndexMap<u64, Option<String>>>,
    next_work: Cell<u64>,
    disposals: RefCell<IndexMap<u64, ()>>,
    disposal_changed: Notify,
    barriers: RefCell<HashMap<u64, oneshot::Receiver<Answer<SE, HE>>>>,
}
impl<
    S: Tagged + 'static,
    M: Tagged + 'static,
    C: CommandFamily<Msg = M> + 'static,
    U: Subscription + 'static,
    X: 'static,
    SE: fmt::Display + fmt::Debug + 'static,
    HE: fmt::Debug + 'static,
    I: Interpreter<C, Error = HE> + 'static,
    R: Subscriptions<U, M, Error = HE> + 'static,
> Env<S, M, C, U, X, SE, HE, I, R>
{
    fn token(&self) -> u64 {
        let token = self.next_work.get();
        self.next_work.set(token + 1);
        token
    }
    fn notice(&self) {
        let notices = self
            .producer
            .mailbox
            .with(|queue| queue.notices.drain(..).collect::<Vec<_>>());
        for notice in notices {
            match notice {
                Notice::Refused(super::DispatchRefused::Contract(error)) => {
                    self.core.report(
                        Rc::new(RuntimeError::Contract(error)),
                        ErrorPhase::Interpret,
                    );
                }
                Notice::Refused(error) => {
                    let error = refusal(error);
                    let phase = if error.discarded() {
                        ErrorPhase::Discard
                    } else {
                        ErrorPhase::FollowUp
                    };
                    self.core.report(error, phase);
                }
            }
        }
    }
    async fn boot(self: Rc<Self>, initial: Option<Initial<S, C>>) -> Answer<SE, HE> {
        let initial = match initial {
            Some(initial) => initial,
            None => {
                let store = self.store.as_ref().expect("stored boot has a store");
                let loaded = store
                    .restore()
                    .await
                    .map_err(|error| Rc::new(RuntimeError::Restore(error)))?;
                let Step { state, commands } = (self.machine.init)(loaded, &self.input);
                Initial {
                    state: Arc::new(state),
                    commands,
                }
            }
        };
        self.commit(initial.state, None, initial.commands).await
    }
    async fn worker(self: Rc<Self>, initial: Option<Initial<S, C>>) {
        let boot = AssertUnwindSafe(self.clone().boot(initial))
            .catch_unwind()
            .await
            .unwrap_or_else(|payload| Err(Rc::new(RuntimeError::Panic(PanicCause::new(payload)))));
        *self.core.ready.borrow_mut() = Some(boot.clone());
        self.core.ready_changed.notify_waiters();
        self.producer.mailbox.completed(1);
        loop {
            let changed = self.producer.mailbox.changed.notified();
            self.notice();
            let job = self.producer.mailbox.with(|queue| queue.jobs.pop_front());
            let Some(job) = job else {
                if self.core.stop_done.get() && self.in_flight.borrow().is_empty() {
                    return;
                }
                changed.await;
                continue;
            };
            let seq = job.seq();
            match job {
                Job::Message {
                    message, origin, ..
                } => {
                    let result = if self.producer.mailbox.gate() == Gate::Abandoned {
                        Err(Rc::new(RuntimeError::Discarded {
                            msg_type: message.tag().into(),
                        }))
                    } else if let Err(error) = &boot {
                        Err(Rc::clone(error))
                    } else {
                        AssertUnwindSafe(self.clone().step(Arc::new(message)))
                            .catch_unwind()
                            .await
                            .unwrap_or_else(|payload| {
                                Err(Rc::new(RuntimeError::Panic(PanicCause::new(payload))))
                            })
                    };
                    if matches!(origin, Origin::Producer) {
                        if let Err(error) = &result {
                            let phase = if error.discarded() {
                                ErrorPhase::Discard
                            } else {
                                ErrorPhase::FollowUp
                            };
                            self.core.report(Rc::clone(error), phase);
                        }
                    }
                    self.core.finish_receipt(seq, result);
                }
                Job::Barrier { .. } => {
                    let barrier = self.barriers.borrow_mut().remove(&seq);
                    if let Some(barrier) = barrier {
                        let _ = barrier.await;
                    }
                }
            }
            self.producer.mailbox.completed(seq);
            tokio::task::yield_now().await;
        }
    }
    async fn step(self: Rc<Self>, message: Arc<M>) -> Answer<SE, HE> {
        let state = self.core.state().expect("dispatch waits for boot");
        let transition = match std::panic::catch_unwind(AssertUnwindSafe(|| {
            self.machine.update.apply(&state, &message)
        })) {
            Ok(result) => result.map_err(|error| Rc::new(RuntimeError::NoCell(error)))?,
            Err(payload) => {
                let error = Rc::new(RuntimeError::Panic(PanicCause::new(payload)));
                self.core.report(Rc::clone(&error), ErrorPhase::Reduce);
                match &self.supervision {
                    Supervision::Stop => {
                        self.producer.mailbox.with(|queue| {
                            if queue.gate != Gate::Abandoned {
                                queue.gate = Gate::Closed
                            }
                        });
                        return Err(error);
                    }
                    Supervision::Escalate => return Err(error),
                    Supervision::Restart(rehydrate) => {
                        Step::new(rehydrate(&state, &message, &error), vec![])
                    }
                }
            }
        };
        self.commit(
            Arc::new(transition.state),
            Some(message),
            transition.commands,
        )
        .await
    }
    async fn commit(
        self: &Rc<Self>,
        state: Arc<S>,
        message: Option<Arc<M>>,
        commands: Vec<C>,
    ) -> Answer<SE, HE> {
        *self.core.view.borrow_mut() = View {
            state: Some(Arc::clone(&state)),
            saved: if self.store.is_some() {
                SaveStatus::Pending
            } else {
                SaveStatus::Saved
            },
        };
        if let Some(store) = &self.store {
            if self.producer.mailbox.gate() != Gate::Abandoned {
                let saved = AssertUnwindSafe(async { store.save(&state).await })
                    .catch_unwind()
                    .await;
                match saved {
                    Ok(Ok(())) => self.core.view.borrow_mut().saved = SaveStatus::Saved,
                    Ok(Err(error)) => {
                        let error = Rc::new(RuntimeError::Save(error));
                        self.core.save_failed(Rc::clone(&error));
                        return Err(error);
                    }
                    Err(payload) => {
                        let error = Rc::new(RuntimeError::Panic(PanicCause::new(payload)));
                        self.core.save_failed(Rc::clone(&error));
                        return Err(error);
                    }
                }
            }
        }
        self.reconcile(&state)?;
        let result = self.run_commands(commands).await;
        self.core.committed(message.as_deref(), &state);
        result
    }
    async fn run_commands(self: &Rc<Self>, commands: Vec<C>) -> Answer<SE, HE> {
        for command in commands {
            if self.producer.mailbox.gate() == Gate::Abandoned {
                return Ok(());
            }
            let (tx, rx) = oneshot::channel();
            let signals = Rc::new(RefCell::new(Signals {
                parent: Some(tx),
                barrier: None,
            }));
            let env = Rc::clone(self);
            tokio::task::spawn_local(async move {
                let defined = command.is_defined();
                let result = AssertUnwindSafe(env.clone().command(command, Rc::clone(&signals)))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|payload| {
                        Err(Rc::new(RuntimeError::Panic(PanicCause::new(payload))))
                    });
                let mut signals = signals.borrow_mut();
                let result = if defined {
                    if let Err(error) = result {
                        env.core.report(error, ErrorPhase::Interpret);
                    }
                    Ok(())
                } else {
                    result
                };
                if let Some(tx) = signals.parent.take() {
                    let _ = tx.send(result.clone());
                } else if let Err(error) = &result {
                    let phase = if error.discarded() {
                        ErrorPhase::Discard
                    } else {
                        ErrorPhase::FollowUp
                    };
                    env.core.report(Rc::clone(error), phase);
                }
                if let Some(tx) = signals.barrier.take() {
                    let _ = tx.send(result);
                }
            });
            rx.await.expect("command task always settles its parent")?;
        }
        Ok(())
    }
    async fn command(
        self: Rc<Self>,
        command: C,
        signals: Rc<RefCell<Signals<SE, HE>>>,
    ) -> Answer<SE, HE> {
        let guard = command.dispatch_guard(&self.edge);
        let reporter = Rc::clone(&self);
        let detached = Rc::clone(&self);
        let context = CommandContext {
            producer: self.producer.clone(),
            edge: self.edge.clone(),
            guard,
            report: Rc::new(move |error| {
                reporter.core.report(
                    Rc::new(RuntimeError::Contract(error)),
                    ErrorPhase::Interpret,
                )
            }),
            detach: Rc::new(move |work| detached.extra(work)),
        };
        let completed = {
            let Some(work) = self.interpreter.interpret(&command, context) else {
                return Ok(());
            };
            let token = self.token();
            self.in_flight
                .borrow_mut()
                .insert(token, Some(command.tag().into()));
            let detached = work.detached;
            let mut running = Box::pin(
                AssertUnwindSafe(perform(work, &self.cancel, self.profile == Profile::Effect))
                    .catch_unwind(),
            );
            let result = if detached {
                let first = futures::poll!(running.as_mut());
                let (tx, rx) = oneshot::channel();
                let seq = self.producer.mailbox.barrier();
                self.barriers.borrow_mut().insert(seq, rx);
                signals.borrow_mut().barrier = Some(tx);
                if let Some(parent) = signals.borrow_mut().parent.take() {
                    let _ = parent.send(Ok(()));
                }
                match first {
                    std::task::Poll::Ready(result) => result,
                    std::task::Poll::Pending => running.await,
                }
            } else {
                running.await
            };
            self.in_flight.borrow_mut().shift_remove(&token);
            self.producer.mailbox.changed.notify_waiters();
            match result {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => return Err(work_error(error)),
                Err(payload) => return Err(Rc::new(RuntimeError::Panic(PanicCause::new(payload)))),
            }
        };
        let Some(completed) = completed else {
            return Ok(());
        };
        let messages = if command.is_defined() {
            command.settle_in(completed, &self.edge)
        } else {
            command.settle(completed, 0.0)
        }
        .map_err(|error| Rc::new(RuntimeError::Contract(Arc::new(error))))?;
        for message in messages {
            let _ = self.producer.emit(message);
        }
        Ok(())
    }
    fn extra(self: &Rc<Self>, work: LocalBoxFuture<'static, Result<(), HE>>) {
        let token = self.token();
        self.in_flight.borrow_mut().insert(token, None);
        let (tx, rx) = oneshot::channel();
        let seq = self.producer.mailbox.barrier();
        self.barriers.borrow_mut().insert(seq, rx);
        let env = Rc::clone(self);
        tokio::task::spawn_local(async move {
            let result = AssertUnwindSafe(work).catch_unwind().await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => env
                    .core
                    .report(Rc::new(RuntimeError::Handler(error)), ErrorPhase::FollowUp),
                Err(payload) => env.core.report(
                    Rc::new(RuntimeError::Panic(PanicCause::new(payload))),
                    ErrorPhase::FollowUp,
                ),
            }
            env.in_flight.borrow_mut().shift_remove(&token);
            let _ = tx.send(Ok(()));
            env.producer.mailbox.changed.notify_waiters();
        });
    }
    fn reconcile(self: &Rc<Self>, state: &S) -> Answer<SE, HE> {
        let desired =
            std::panic::catch_unwind(AssertUnwindSafe(|| (self.machine.subscriptions)(state)))
                .map_err(|payload| Rc::new(RuntimeError::Panic(PanicCause::new(payload))))?;
        let mut wanted = IndexMap::new();
        for sub in desired {
            wanted.insert(sub.id().clone(), sub);
        }
        let removed = self
            .running
            .borrow()
            .keys()
            .filter(|id| !wanted.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        self.stop_subs(removed);
        let starting = self.producer.mailbox.gate() == Gate::Open;
        let mut first = None;
        if starting {
            for (id, sub) in wanted {
                if self.running.borrow().contains_key(&id) {
                    continue;
                }
                let kind = sub.kind().to_owned();
                let work = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    self.subscriptions.start(sub, self.producer.clone())
                }));
                let work = match work {
                    Ok(Ok(Some(work))) => work,
                    Ok(Ok(None)) => {
                        first.get_or_insert_with(|| {
                            Rc::new(RuntimeError::MissingSubscription { kind })
                        });
                        continue;
                    }
                    Ok(Err(error)) => {
                        let error = Rc::new(RuntimeError::Handler(error));
                        self.core.report(Rc::clone(&error), ErrorPhase::Sub);
                        first.get_or_insert(error);
                        self.start_stop();
                        continue;
                    }
                    Err(payload) => {
                        let error = Rc::new(RuntimeError::Panic(PanicCause::new(payload)));
                        self.core.report(Rc::clone(&error), ErrorPhase::Sub);
                        first.get_or_insert(error);
                        self.start_stop();
                        continue;
                    }
                };
                self.start_sub(id, work);
            }
        }
        first.map_or(Ok(()), Err)
    }
    fn start_sub(self: &Rc<Self>, id: SubId, work: SubscriptionWork<HE>) {
        let cancel = Arc::new(Cancel::new());
        let mut running = Running {
            cancel: Arc::clone(&cancel),
            cleanup: work.cleanup,
            source_done: None,
        };
        if let Some(source) = work.source {
            let (tx, rx) = oneshot::channel();
            running.source_done = Some(rx);
            let env = Rc::clone(self);
            let sub_id = id.clone();
            tokio::task::spawn_local(async move {
                let result = AssertUnwindSafe(async {
                    tokio::select! {biased;_ =cancel.cancelled()=>Ok(()),result=source=>result}
                })
                .catch_unwind()
                .await;
                let failure = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(Rc::new(RuntimeError::Handler(error))),
                    Err(payload) => Some(Rc::new(RuntimeError::Panic(PanicCause::new(payload)))),
                };
                if let Some(error) = failure {
                    env.core.report(error, ErrorPhase::Sub);
                    env.stop_subs([sub_id]);
                    env.start_stop();
                }
                let _ = tx.send(());
            });
        }
        self.running.borrow_mut().insert(id, running);
    }
    fn stop_subs(self: &Rc<Self>, ids: impl IntoIterator<Item = SubId>) {
        for id in ids {
            let running = self.running.borrow_mut().shift_remove(&id);
            let Some(running) = running else {
                continue;
            };
            running.cancel.cancel();
            let token = self.token();
            self.disposals.borrow_mut().insert(token, ());
            let env = Rc::clone(self);
            let cleanup = std::panic::catch_unwind(AssertUnwindSafe(running.cleanup));
            tokio::task::spawn_local(async move {
                if let Some(done) = running.source_done {
                    let _ = done.await;
                }
                match cleanup {
                    Ok(cleanup) => match AssertUnwindSafe(cleanup).catch_unwind().await {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => env.core.report(
                            Rc::new(RuntimeError::Handler(error)),
                            ErrorPhase::SubCleanup,
                        ),
                        Err(payload) => env.core.report(
                            Rc::new(RuntimeError::Panic(PanicCause::new(payload))),
                            ErrorPhase::SubCleanup,
                        ),
                    },
                    Err(payload) => env.core.report(
                        Rc::new(RuntimeError::Panic(PanicCause::new(payload))),
                        ErrorPhase::SubCleanup,
                    ),
                }
                env.disposals.borrow_mut().shift_remove(&token);
                env.disposal_changed.notify_waiters();
            });
        }
    }
    fn start_stop(self: &Rc<Self>) {
        if self.core.stop_started.replace(true) {
            return;
        }
        self.producer.mailbox.with(|queue| {
            if queue.gate == Gate::Open {
                queue.gate = Gate::Draining
            }
        });
        let target = self.producer.mailbox.with(|queue| queue.tail);
        let pending = self.in_flight.borrow().len();
        if pending > 0 {
            self.core.report(
                Rc::new(RuntimeError::RuntimeDiscarded { pending }),
                ErrorPhase::Discard,
            );
        }
        if self.profile == Profile::Effect {
            self.cancel.cancel();
        }
        let env = Rc::clone(self);
        tokio::task::spawn_local(async move {
            env.teardown(target).await;
        });
    }
    async fn teardown(self: Rc<Self>, target: u64) {
        if tokio::time::timeout(self.timeout, wait_tail(&self.producer.mailbox, target))
            .await
            .is_err()
        {
            let flight = self.in_flight.borrow();
            let cmd_types = flight.values().filter_map(Clone::clone).collect();
            let pending = flight.len();
            drop(flight);
            self.core.report(
                Rc::new(RuntimeError::DrainTimeout {
                    cmd_types,
                    pending,
                    timeout: self.timeout,
                }),
                ErrorPhase::Discard,
            );
            self.producer
                .mailbox
                .with(|queue| queue.gate = Gate::Abandoned);
        } else {
            self.producer
                .mailbox
                .with(|queue| queue.gate = Gate::Closed);
        }
        let ids = self.running.borrow().keys().cloned().collect::<Vec<_>>();
        self.stop_subs(ids);
        let outstanding = self.disposals.borrow().keys().copied().collect::<Vec<_>>();
        if !outstanding.is_empty() {
            let settled = async {
                loop {
                    let changed = self.disposal_changed.notified();
                    if outstanding
                        .iter()
                        .all(|id| !self.disposals.borrow().contains_key(id))
                    {
                        return;
                    }
                    changed.await;
                }
            };
            if tokio::time::timeout(self.timeout, settled).await.is_err() {
                self.core.report(
                    Rc::new(RuntimeError::DisposeTimeout {
                        pending: outstanding.len(),
                        timeout: self.timeout,
                    }),
                    ErrorPhase::Discard,
                );
            }
        }
        let boot_failed = self
            .core
            .ready
            .borrow()
            .as_ref()
            .is_some_and(Result::is_err);
        if !boot_failed {
            if let (Some(store), Some(state)) = (&self.store, self.core.state()) {
                match AssertUnwindSafe(async { store.save(&state).await })
                    .catch_unwind()
                    .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => self
                        .core
                        .report(Rc::new(RuntimeError::Save(error)), ErrorPhase::StopSave),
                    Err(payload) => self.core.report(
                        Rc::new(RuntimeError::Panic(PanicCause::new(payload))),
                        ErrorPhase::StopSave,
                    ),
                }
            }
        }
        self.core.stop_done.set(true);
        self.core.stop_changed.notify_waiters();
        self.producer.mailbox.changed.notify_waiters();
    }
}

/// Eager launch. The host must drive a Tokio LocalSet for the actor's lifetime.
pub fn launch<
    S: Tagged + 'static,
    M: Tagged + 'static,
    C: CommandFamily<Msg = M> + 'static,
    U: Subscription + 'static,
    X: 'static,
    SE: fmt::Display + fmt::Debug + 'static,
    HE: fmt::Debug + 'static,
    I: Interpreter<C, Error = HE> + 'static,
    R: Subscriptions<U, M, Error = HE> + 'static,
>(
    machine: Machine<'static, S, M, C, U, X>,
    input: X,
    interpreter: I,
    subscriptions: R,
    options: Options<S, M, SE, HE>,
) -> Runtime<S, M, SE, HE> {
    let Options {
        profile,
        store,
        terminal,
        on_commit,
        on_error,
        clock,
        dispose_timeout,
        idle_cap,
        supervision,
    } = options;
    let store = store.map(|store| store.open());
    let initial = if store.is_none() {
        let Step { state, commands } = (machine.init)(None, &input);
        Some(Initial {
            state: Arc::new(state),
            commands,
        })
    } else {
        None
    };
    let core = Rc::new(Core {
        view: RefCell::new(View {
            state: initial.as_ref().map(|initial| Arc::clone(&initial.state)),
            saved: if store.is_none() {
                SaveStatus::Saved
            } else {
                SaveStatus::Pending
            },
        }),
        ready: RefCell::new(None),
        ready_changed: Notify::new(),
        receipts: RefCell::new(HashMap::new()),
        done: RefCell::new(vec![]),
        stop_started: Cell::new(false),
        stop_done: Cell::new(false),
        stop_changed: Notify::new(),
        reports: RefCell::new(vec![]),
        sink: on_error,
        terminal,
        commits: on_commit,
        listeners: RefCell::new(IndexMap::new()),
        observers: RefCell::new(IndexMap::new()),
        boots: RefCell::new(IndexMap::new()),
        booted: Cell::new(false),
        next_listener: Cell::new(0),
    });
    let producer = Producer {
        mailbox: Arc::new(Mailbox::new()),
        guard: None,
    };
    let edge = CommandEdge::new(move || clock());
    let env = Rc::new(Env {
        machine,
        input,
        interpreter,
        subscriptions,
        store,
        core: Rc::clone(&core),
        producer: producer.clone(),
        edge,
        profile,
        timeout: dispose_timeout,
        supervision,
        cancel: Arc::new(Cancel::new()),
        running: RefCell::new(IndexMap::new()),
        in_flight: RefCell::new(IndexMap::new()),
        next_work: Cell::new(0),
        disposals: RefCell::new(IndexMap::new()),
        disposal_changed: Notify::new(),
        barriers: RefCell::new(HashMap::new()),
    });
    let worker = Rc::clone(&env);
    tokio::task::spawn_local(async move {
        worker.worker(initial).await;
    });
    Runtime {
        core,
        producer,
        stopper: Rc::new(move || env.start_stop()),
        profile,
        idle_cap,
    }
}
/// Lazy launch seam, suitable for the Effect profile's cold program construction.
pub async fn run<
    S: Tagged + 'static,
    M: Tagged + 'static,
    C: CommandFamily<Msg = M> + 'static,
    U: Subscription + 'static,
    X: 'static,
    SE: fmt::Display + fmt::Debug + 'static,
    HE: fmt::Debug + 'static,
    I: Interpreter<C, Error = HE> + 'static,
    R: Subscriptions<U, M, Error = HE> + 'static,
>(
    machine: Machine<'static, S, M, C, U, X>,
    input: X,
    interpreter: I,
    subscriptions: R,
    options: Options<S, M, SE, HE>,
) -> Runtime<S, M, SE, HE> {
    launch(machine, input, interpreter, subscriptions, options)
}
