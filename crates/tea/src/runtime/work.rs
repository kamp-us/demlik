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
pub struct CommandWork<'a, T, E> {
    pub(crate) future: LocalBoxFuture<'a, Result<T, E>>,
    pub(crate) cleanup: Option<Cleanup<'a, E>>,
    pub(crate) detached: bool,
    pub(crate) uninterruptible: bool,
}
impl<'a, T, E> CommandWork<'a, T, E> {
    pub fn new(future: impl Future<Output = Result<T, E>> + 'a) -> Self {
        Self {
            future: future.boxed_local(),
            cleanup: None,
            detached: false,
            uninterruptible: false,
        }
    }
    pub fn detached(mut self) -> Self {
        self.detached = true;
        self
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
    pub(crate) producer: Producer<M>,
    pub(crate) edge: CommandEdge,
    pub(crate) guard: DispatchGuard<M>,
    pub(crate) report: Rc<dyn Fn(Arc<CommandContractError>)>,
    pub(crate) detach: DetachWork<E>,
}
impl<M, E> Clone for CommandContext<M, E> {
    fn clone(&self) -> Self {
        Self {
            producer: self.producer.clone(),
            edge: self.edge.clone(),
            guard: self.guard.clone(),
            report: Rc::clone(&self.report),
            detach: Rc::clone(&self.detach),
        }
    }
}
impl<M: Tagged, E> CommandContext<M, E> {
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
    pub fn wait_until(&self, work: impl Future<Output = Result<(), E>> + 'static) {
        (self.detach)(work.boxed_local());
    }
}
pub trait Interpreter<C: CommandFamily> {
    type Error;
    fn interpret<'a>(
        &'a self,
        command: &'a C,
        context: CommandContext<C::Msg, Self::Error>,
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
impl<C: CommandFamily, E> Interpreter<C> for NoInterpreter<E> {
    type Error = E;
    fn interpret<'a>(
        &'a self,
        _: &'a C,
        _: CommandContext<C::Msg, E>,
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
pub(crate) async fn perform<'a, T, E>(
    mut work: CommandWork<'a, T, E>,
    cancel: &Arc<Cancel>,
    interrupt: bool,
) -> Result<Option<T>, WorkFailure<E>> {
    let result=std::panic::AssertUnwindSafe(async {
        if interrupt && !work.uninterruptible {
            tokio::select! {biased; _=cancel.cancelled()=>Ok(None),value=&mut work.future=>value.map(Some)}
        } else {work.future.await.map(Some)}
    }).catch_unwind().await;
    let result = match result {
        Ok(result) => result.map_err(WorkFailure::Failed),
        Err(payload) => Err(WorkFailure::Panic(crate::storage::PanicCause::new(payload))),
    };
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
            return Err(WorkFailure::Cleanup {
                prior: result.err().map(Box::new),
                cause: Box::new(cause),
            });
        }
    }
    result
}
