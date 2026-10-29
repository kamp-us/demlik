use std::cell::{Cell, RefCell};
use std::future::Future;
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use futures::{FutureExt, future::LocalBoxFuture};
use tokio::sync::Notify;

use super::{DispatchRefused, Producer};
use crate::Tagged;
use crate::command::{CommandContractError, CommandEdge, CommandFamily, DispatchGuard};

pub(crate) struct Cancel {
    set: AtomicBool,
    changed: Notify,
}
impl Cancel {
    pub fn new() -> Self {
        Self {
            set: AtomicBool::new(false),
            changed: Notify::new(),
        }
    }
    pub(crate) fn is_cancelled(&self) -> bool {
        self.set.load(Ordering::SeqCst)
    }
    pub fn cancel(&self) {
        self.set.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
    pub async fn cancelled(&self) {
        loop {
            let changed = self.changed.notified();
            if self.set.load(Ordering::SeqCst) {
                return;
            }
            changed.await;
        }
    }
}
pub(crate) type Cleanup<'a, E> = Box<dyn FnOnce() -> LocalBoxFuture<'a, Result<(), E>> + 'a>;
/// A local command's cancellation signal. This is not an EventTarget adapter.
/// A completed operation closes registration even if it was never aborted.
#[derive(Clone)]
pub struct CommandSignal<'a> {
    state: Rc<SignalState<'a>>,
}
struct SignalState<'a> {
    aborted: Cell<bool>,
    closed: Cell<bool>,
    listeners: RefCell<Vec<Box<dyn FnOnce() + 'a>>>,
}
impl<'a> CommandSignal<'a> {
    fn new() -> Self {
        Self {
            state: Rc::new(SignalState {
                aborted: Cell::new(false),
                closed: Cell::new(false),
                listeners: RefCell::new(Vec::new()),
            }),
        }
    }
    pub fn aborted(&self) -> bool {
        self.state.aborted.get()
    }
    /// Registers before interruption. Returns false once the operation is closed;
    /// the rejected capture is dropped without calling it.
    #[must_use]
    pub fn on_abort(&self, listener: impl FnOnce() + 'a) -> bool {
        if self.state.closed.get() {
            return false;
        }
        self.state.listeners.borrow_mut().push(Box::new(listener));
        true
    }
    fn take_listeners(&self) -> Vec<Box<dyn FnOnce() + 'a>> {
        self.state.closed.set(true);
        std::mem::take(&mut *self.state.listeners.borrow_mut())
    }
}
// Owned outside the caught operation, so factory unwind and future destruction
// cannot strand a self-capturing listener cycle.
struct SignalOwner<'a>(CommandSignal<'a>);
impl SignalOwner<'_> {
    fn abort(&self) {
        self.0.state.aborted.set(true);
        let listeners = self.0.take_listeners();
        for listener in listeners {
            listener();
        }
    }
    fn close(&self) {
        drop(self.0.take_listeners());
    }
}
impl Drop for SignalOwner<'_> {
    fn drop(&mut self) {
        self.close();
    }
}
type PromiseFactory<'a, T, E> =
    Box<dyn FnOnce(CommandSignal<'a>) -> LocalBoxFuture<'a, Result<T, E>> + 'a>;
enum CommandOperation<'a, T, E> {
    Native(LocalBoxFuture<'a, Result<T, E>>),
    Effect(LocalBoxFuture<'a, Result<T, E>>),
    Promise(PromiseFactory<'a, T, E>),
}
/// A release chain orders detached settlements without changing their operations.
#[derive(Default)]
pub(crate) struct SettlementChain(std::cell::RefCell<Option<tokio::sync::oneshot::Receiver<()>>>);
pub(crate) struct SettlementOrder {
    prior: Option<tokio::sync::oneshot::Receiver<()>>,
    // Dropping the sender releases the next edge on success, error, or cancellation.
    _release: tokio::sync::oneshot::Sender<()>,
}
impl SettlementOrder {
    pub(crate) async fn wait(&mut self) {
        if let Some(prior) = self.prior.take() {
            let _ = prior.await;
        }
    }
}
impl SettlementChain {
    fn next(&self) -> SettlementOrder {
        let (release, next) = tokio::sync::oneshot::channel();
        SettlementOrder {
            prior: self.0.replace(Some(next)),
            _release: release,
        }
    }
}
pub struct CommandWork<'a, T, E> {
    operation: CommandOperation<'a, T, E>,
    pub(crate) cleanup: Option<Cleanup<'a, E>>,
    pub(crate) detached: bool,
    pub(crate) settlement_order: Option<SettlementOrder>,
    pub(crate) uninterruptible: bool,
}
impl<'a, T, E> CommandWork<'a, T, E> {
    pub(super) fn is_promise(&self) -> bool {
        matches!(&self.operation, CommandOperation::Promise(_))
    }
    /// Native futures retain the existing cancellation-before-poll behavior.
    pub fn new(future: impl Future<Output = Result<T, E>> + 'a) -> Self {
        Self::operation(CommandOperation::Native(future.boxed_local()))
    }
    /// Offers a ready operation before observing Effect-profile cancellation.
    pub fn effect(future: impl Future<Output = Result<T, E>> + 'a) -> Self {
        Self::operation(CommandOperation::Effect(future.boxed_local()))
    }
    /// Defers the factory until execution inside the cleanup boundary.
    /// Effect-profile interruption releases the logical waiter after cleanup;
    /// the original borrowed operation remains owned until its tail finishes.
    pub fn promise<F, G>(factory: F) -> Self
    where
        F: FnOnce(CommandSignal<'a>) -> G + 'a,
        G: Future<Output = Result<T, E>> + 'a,
    {
        Self::operation(CommandOperation::Promise(Box::new(move |signal| {
            factory(signal).boxed_local()
        })))
    }
    fn operation(operation: CommandOperation<'a, T, E>) -> Self {
        Self {
            operation,
            cleanup: None,
            detached: false,
            settlement_order: None,
            uninterruptible: false,
        }
    }
    pub(crate) fn map<O>(self, map: impl FnOnce(T) -> O + 'a) -> CommandWork<'a, O, E>
    where
        T: 'a,
        E: 'a,
        O: 'a,
    {
        let operation = match self.operation {
            CommandOperation::Native(future) => {
                CommandOperation::Native(async move { future.await.map(map) }.boxed_local())
            }
            CommandOperation::Effect(future) => {
                CommandOperation::Effect(async move { future.await.map(map) }.boxed_local())
            }
            CommandOperation::Promise(factory) => {
                CommandOperation::Promise(Box::new(move |signal| {
                    let future = factory(signal);
                    async move { future.await.map(map) }.boxed_local()
                }))
            }
        };
        CommandWork {
            operation,
            cleanup: self.cleanup,
            detached: self.detached,
            settlement_order: self.settlement_order,
            uninterruptible: self.uninterruptible,
        }
    }
    pub(crate) fn ordered_detached(mut self, chain: &SettlementChain) -> Self {
        self.detached = true;
        self.settlement_order = Some(chain.next());
        self
    }
    pub fn detached(mut self) -> Self {
        self.detached = true;
        self
    }
    pub(crate) fn and_then<F, G>(self, then: F) -> Self
    where
        T: 'a,
        E: 'a,
        F: FnOnce(T) -> G + 'a,
        G: Future<Output = Result<T, E>> + 'a,
    {
        let operation = match self.operation {
            CommandOperation::Native(work) => {
                CommandOperation::Native(async move { then(work.await?).await }.boxed_local())
            }
            CommandOperation::Effect(work) => {
                CommandOperation::Effect(async move { then(work.await?).await }.boxed_local())
            }
            CommandOperation::Promise(factory) => {
                CommandOperation::Promise(Box::new(move |signal| {
                    let work = factory(signal);
                    async move { then(work.await?).await }.boxed_local()
                }))
            }
        };
        Self {
            operation,
            cleanup: self.cleanup,
            detached: self.detached,
            settlement_order: self.settlement_order,
            uninterruptible: self.uninterruptible,
        }
    }
    pub fn uninterruptible(mut self) -> Self {
        self.uninterruptible = true;
        self
    }
    pub fn with_cleanup<F, G>(mut self, cleanup: F) -> Self
    where
        F: FnOnce() -> G + 'a,
        G: Future<Output = Result<(), E>> + 'a,
    {
        self.cleanup = Some(Box::new(move || cleanup().boxed_local()));
        self
    }
}
type DetachWork<E> = Rc<dyn Fn(LocalBoxFuture<'static, Result<(), E>>)>;
pub struct CommandContext<M, E> {
    pub(crate) ports: super::ports::PortEmitter,
    pub(crate) producer: Producer<M>,
    pub(crate) edge: CommandEdge,
    pub(crate) guard: DispatchGuard<M>,
    pub(crate) report: Rc<dyn Fn(Arc<CommandContractError>)>,
    pub(crate) detach: DetachWork<E>,
}
impl<M, E> Clone for CommandContext<M, E> {
    fn clone(&self) -> Self {
        Self {
            ports: self.ports.clone(),
            producer: self.producer.clone(),
            edge: self.edge.clone(),
            guard: self.guard.clone(),
            report: Rc::clone(&self.report),
            detach: Rc::clone(&self.detach),
        }
    }
}
impl<M: Tagged, E> CommandContext<M, E> {
    pub fn emit<T: 'static>(&self, port: &crate::ports::Port<T>, value: T) {
        self.ports.emit(port, &value);
    }
    pub fn dispatch(&self, message: M) -> Result<(), DispatchRefused> {
        if let Err(error) = self.guard.check(&message) {
            let error = Arc::new(error);
            (self.report)(Arc::clone(&error));
            return Err(DispatchRefused::Contract(error));
        }
        self.producer.emit(message)
    }
    pub fn producer(&self) -> Producer<M> {
        let mut producer = self.producer.clone();
        producer.guard = Some(self.guard.clone());
        producer
    }
    pub fn edge(&self) -> &CommandEdge {
        &self.edge
    }
    /// Starts the future's synchronous prefix now, then retains it on the tail.
    /// This external work survives Effect handler interruption, like the tracked Promise.
    pub fn wait_until(&self, work: impl Future<Output = Result<(), E>> + 'static) {
        (self.detach)(work.boxed_local());
    }
}
pub trait Interpreter<C: CommandFamily, M = <C as CommandFamily>::Msg> {
    type Error;
    fn interpret<'a>(
        &'a self,
        command: &'a C,
        context: CommandContext<M, Self::Error>,
    ) -> Option<CommandWork<'a, C::Completion, Self::Error>>;
}
pub struct NoInterpreter<E>(PhantomData<fn() -> E>);
impl<E> NoInterpreter<E> {
    pub fn new() -> Self {
        Self(PhantomData)
    }
}
impl<E> Default for NoInterpreter<E> {
    fn default() -> Self {
        Self::new()
    }
}
impl<C: CommandFamily, M, E> Interpreter<C, M> for NoInterpreter<E> {
    type Error = E;
    fn interpret<'a>(
        &'a self,
        _: &'a C,
        _: CommandContext<M, E>,
    ) -> Option<CommandWork<'a, C::Completion, E>> {
        None
    }
}

pub struct SubscriptionWork<E> {
    pub(crate) source: Option<LocalBoxFuture<'static, Result<(), E>>>,
    pub(crate) cleanup: Cleanup<'static, E>,
}
impl<E: 'static> SubscriptionWork<E> {
    pub fn new<F, G>(cleanup: F) -> Self
    where
        F: FnOnce() -> G + 'static,
        G: Future<Output = Result<(), E>> + 'static,
    {
        Self {
            source: None,
            cleanup: Box::new(move || cleanup().boxed_local()),
        }
    }
    pub fn with_source(mut self, source: impl Future<Output = Result<(), E>> + 'static) -> Self {
        self.source = Some(source.boxed_local());
        self
    }
}
pub trait Subscriptions<U, M> {
    type Error;
    /// Runner-table presence, before transferring owned subscription data.
    /// Return false for absent entries so the runtime can select a built-in.
    fn has_runner(&self, _kind: &str) -> bool {
        true
    }
    fn start(
        &self,
        sub: U,
        producer: Producer<M>,
    ) -> Result<Option<SubscriptionWork<Self::Error>>, Self::Error>;
}
pub struct NoSubscriptions<E>(PhantomData<fn() -> E>);
impl<E> NoSubscriptions<E> {
    pub fn new() -> Self {
        Self(PhantomData)
    }
}
impl<E> Default for NoSubscriptions<E> {
    fn default() -> Self {
        Self::new()
    }
}
impl<U, M, E> Subscriptions<U, M> for NoSubscriptions<E> {
    type Error = E;
    fn has_runner(&self, _: &str) -> bool {
        false
    }
    fn start(&self, _: U, _: Producer<M>) -> Result<Option<SubscriptionWork<E>>, E> {
        Ok(None)
    }
}

pub(crate) enum WorkFailure<E> {
    Failed(E),
    Panic(crate::storage::PanicCause),
    Cleanup {
        prior: Option<Box<Self>>,
        cause: Box<Self>,
    },
}
pub(crate) struct Performed<'a, T, E> {
    pub result: Result<Option<T>, WorkFailure<E>>,
    pub tail: Option<LocalBoxFuture<'a, Result<T, E>>>,
}
pub(crate) async fn perform<'a, T, E>(
    work: CommandWork<'a, T, E>,
    cancel: &Arc<Cancel>,
    interrupt: bool,
) -> Performed<'a, T, E> {
    let signal_owner = matches!(&work.operation, CommandOperation::Promise(_))
        .then(|| SignalOwner(CommandSignal::new()));
    let interrupt = interrupt && !work.uninterruptible;
    let mut tail = None;
    let body = std::panic::AssertUnwindSafe(async {
        match work.operation {
            CommandOperation::Native(mut future) => {
                if interrupt {
                    tokio::select! { biased;
                        _ = cancel.cancelled() => Ok(None),
                        value = &mut future => value.map(Some),
                    }
                } else {
                    future.await.map(Some)
                }
            }
            CommandOperation::Effect(mut future) => {
                if interrupt {
                    tokio::select! { biased;
                        value = &mut future => value.map(Some),
                        _ = cancel.cancelled() => Ok(None),
                    }
                } else {
                    future.await.map(Some)
                }
            }
            CommandOperation::Promise(factory) => {
                let owner = signal_owner.as_ref().expect("Promise owns its signal");
                let mut future = factory(owner.0.clone());
                if interrupt {
                    tokio::select! { biased;
                        _ = cancel.cancelled() => {
                            tail = Some(future);
                            owner.abort();
                            Ok(None)
                        },
                        value = &mut future => value.map(Some),
                    }
                } else {
                    future.await.map(Some)
                }
            }
        }
    })
    .catch_unwind()
    .await;
    let mut result = match body {
        Ok(value) => value.map_err(WorkFailure::Failed),
        Err(payload) => Err(WorkFailure::Panic(crate::storage::PanicCause::new(payload))),
    };
    // Release captures before user cleanup; keep the guard alive for every exit,
    // including cancellation by dropping this future.
    let closed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if let Some(owner) = &signal_owner {
            owner.close();
        }
    }));
    if let Err(payload) = closed {
        result = Err(WorkFailure::Cleanup {
            prior: result.err().map(Box::new),
            cause: Box::new(WorkFailure::Panic(crate::storage::PanicCause::new(payload))),
        });
    }
    if let Some(cleanup) = work.cleanup {
        let closed = std::panic::AssertUnwindSafe(async { cleanup().await })
            .catch_unwind()
            .await;
        let failure = match closed {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(WorkFailure::Failed(error)),
            Err(payload) => Some(WorkFailure::Panic(crate::storage::PanicCause::new(payload))),
        };
        if let Some(cause) = failure {
            result = Err(WorkFailure::Cleanup {
                prior: result.err().map(Box::new),
                cause: Box::new(cause),
            });
        }
    }
    Performed { result, tail }
}
