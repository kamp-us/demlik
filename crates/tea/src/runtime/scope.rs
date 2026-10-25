use super::{Failure, Profile, Runtime, Unsubscribe, work::Cancel};
use crate::{Tagged, storage::PanicCause};
use futures::{FutureExt, future::LocalBoxFuture};
use std::{
    any::Any,
    cell::{Cell, RefCell},
    fmt,
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    rc::Rc,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::sync::{Notify, oneshot};

/// Retains the original typed runtime failure, including its handler/store data.
#[derive(Clone)]
pub struct ScopeFailure {
    name: &'static str,
    cause: Rc<dyn Any>,
}
impl ScopeFailure {
    pub fn name(&self) -> &'static str {
        self.name
    }
    pub fn downcast_ref<T: Any>(&self) -> Option<&T> {
        self.cause.downcast_ref()
    }
    fn new<SE: 'static, HE: 'static>(error: Failure<SE, HE>) -> Self {
        Self {
            name: error.name(),
            cause: error,
        }
    }
}
impl fmt::Debug for ScopeFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ScopeFailure")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}
#[derive(Debug)]
pub struct ScopeProfileError {
    pub profile: Profile,
}
impl fmt::Display for ScopeProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "EffectScope requires the Effect profile, received {:?}",
            self.profile
        )
    }
}
impl std::error::Error for ScopeProfileError {}
struct Member {
    stop: Box<dyn FnOnce() -> LocalBoxFuture<'static, ()>>,
    unwatch: Unsubscribe,
}
struct Scope {
    closing: Cell<bool>,
    closed: Cell<bool>,
    changed: Notify,
    members: RefCell<Vec<Member>>,
    failure: RefCell<Option<ScopeFailure>>,
}
/// An explicit native Effect host owner. `close().await` is the cleanup receipt;
/// dropping a task requests interruption but does not claim to await finalizers.
#[derive(Clone)]
pub struct EffectScope(Rc<Scope>);
impl Default for EffectScope {
    fn default() -> Self {
        Self::new()
    }
}
impl EffectScope {
    pub fn new() -> Self {
        Self(Rc::new(Scope {
            closing: Cell::new(false),
            closed: Cell::new(false),
            changed: Notify::new(),
            members: RefCell::new(vec![]),
            failure: RefCell::new(None),
        }))
    }
    pub fn is_closing(&self) -> bool {
        self.0.closing.get()
    }
    pub fn is_closed(&self) -> bool {
        self.0.closed.get()
    }
    pub fn failure(&self) -> Option<ScopeFailure> {
        self.0.failure.borrow().clone()
    }
    pub async fn attach<
        S: 'static,
        M: Tagged + 'static,
        SE: 'static,
        HE: 'static,
        E: Tagged + 'static,
    >(
        &self,
        runtime: &Runtime<S, M, SE, HE, E>,
    ) -> Result<(), ScopeProfileError> {
        if runtime.profile() != Profile::Effect {
            return Err(ScopeProfileError {
                profile: runtime.profile(),
            });
        }
        if self.is_closing() {
            runtime.stop().await;
            return Ok(());
        }
        let weak = Rc::downgrade(&self.0);
        let unwatch = runtime.watch_scope(Rc::new(move |error| {
            if let Some(scope) = weak.upgrade() {
                EffectScope(scope).start_close(Some(ScopeFailure::new(error)));
            }
        }));
        let run = runtime.clone();
        self.0.members.borrow_mut().push(Member {
            stop: Box::new(move || async move { run.stop().await }.boxed_local()),
            unwatch,
        });
        if let Some(error) = runtime.scope_failure() {
            self.start_close(Some(ScopeFailure::new(error)));
        }
        Ok(())
    }
    fn start_close(&self, failure: Option<ScopeFailure>) {
        if let Some(failure) = failure {
            if self.0.failure.borrow().is_none() {
                *self.0.failure.borrow_mut() = Some(failure);
            }
        }
        if self.0.closing.replace(true) {
            return;
        }
        self.0.changed.notify_waiters();
        let members = self
            .0
            .members
            .borrow_mut()
            .drain(..)
            .rev()
            .collect::<Vec<_>>();
        let owner = self.clone();
        tokio::task::spawn_local(async move {
            for member in members {
                (member.unwatch)();
                (member.stop)().await;
            }
            owner.0.closed.set(true);
            owner.0.changed.notify_waiters();
        });
    }
    pub async fn close(&self) {
        self.start_close(None);
        loop {
            let changed = self.0.changed.notified();
            if self.is_closed() {
                return;
            }
            changed.await;
        }
    }
    async fn closing(&self) {
        loop {
            let changed = self.0.changed.notified();
            if self.is_closing() {
                return;
            }
            changed.await;
        }
    }
    /// Eagerly transfers program ownership to the LocalSet. A dropped waiter
    /// signals cancellation; the retained driver still closes this scope.
    pub fn spawn<T: 'static, E: 'static>(
        &self,
        program: impl Future<Output = Result<T, E>> + 'static,
    ) -> ScopeTask<T, E> {
        let (tx, rx) = oneshot::channel();
        let cancel = Arc::new(Cancel::new());
        let signal = Arc::clone(&cancel);
        let scope = self.clone();
        tokio::task::spawn_local(async move {
            let result = tokio::select! {biased;
                _=signal.cancelled()=>ScopeExit::Interrupted,
                _=scope.closing()=>match scope.failure(){Some(cause)=>ScopeExit::RuntimeFailure(cause),None=>ScopeExit::Interrupted},
                result=AssertUnwindSafe(program).catch_unwind()=>match result{Ok(Ok(value))=>ScopeExit::Success(value),Ok(Err(error))=>ScopeExit::Failure(error),Err(payload)=>ScopeExit::Defect(PanicCause::new(payload))},
            };
            scope.close().await;
            let _ = tx.send(result);
        });
        ScopeTask {
            receiver: rx,
            cancel,
            completed: false,
        }
    }
    pub async fn run<T: 'static, E: 'static>(
        &self,
        program: impl Future<Output = Result<T, E>> + 'static,
    ) -> ScopeExit<T, E> {
        self.spawn(program).await
    }
}
#[derive(Debug)]
pub enum ScopeExit<T, E> {
    Success(T),
    Failure(E),
    Defect(PanicCause),
    RuntimeFailure(ScopeFailure),
    Interrupted,
}
#[must_use = "await the task, or await EffectScope::close after requesting interruption"]
pub struct ScopeTask<T, E> {
    receiver: oneshot::Receiver<ScopeExit<T, E>>,
    cancel: Arc<Cancel>,
    completed: bool,
}
impl<T, E> ScopeTask<T, E> {
    pub fn request_interrupt(&self) {
        self.cancel.cancel();
    }
    pub async fn interrupt(self) -> ScopeExit<T, E> {
        self.request_interrupt();
        self.await
    }
}
impl<T, E> Future for ScopeTask<T, E> {
    type Output = ScopeExit<T, E>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        match Pin::new(&mut this.receiver).poll(cx) {
            Poll::Ready(result) => {
                this.completed = true;
                Poll::Ready(
                    result.expect("scope driver retains its receipt until cleanup finishes"),
                )
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
impl<T, E> Drop for ScopeTask<T, E> {
    fn drop(&mut self) {
        if !self.completed {
            self.cancel.cancel();
        }
    }
}
