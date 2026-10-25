use crate::storage::PanicCause;
use futures::{FutureExt, future::LocalBoxFuture, task::noop_waker_ref};
use std::{
    cell::RefCell,
    convert::Infallible,
    fmt,
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll},
};
use tokio::sync::oneshot;

#[derive(Debug)]
pub enum JournalError<E, F = Infallible> {
    Backend(E),
    Effect(F),
    Panic(PanicCause),
    HostClosed,
}
impl<E: fmt::Display, F: fmt::Display> fmt::Display for JournalError<E, F> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Backend(error) => error.fmt(f),
            Self::Effect(error) => error.fmt(f),
            Self::Panic(error) => f.write_str(&error.summary),
            Self::HostClosed => f.write_str("journal host closed before the operation settled"),
        }
    }
}
impl<E: fmt::Debug + fmt::Display, F: fmt::Debug + fmt::Display> std::error::Error
    for JournalError<E, F>
{
}

/// An owned local-host receipt. Dropping it does not cancel submitted work.
pub struct JournalTask<T, E, F = Infallible> {
    receiver: oneshot::Receiver<Result<T, JournalError<E, F>>>,
    first: bool,
}
impl<T, E, F> Future for JournalTask<T, E, F> {
    type Output = Result<T, JournalError<E, F>>;
    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if this.first {
            this.first = false;
            context.waker().wake_by_ref();
            return Poll::Pending;
        }
        match Pin::new(&mut this.receiver).poll(context) {
            Poll::Ready(Ok(result)) => Poll::Ready(result),
            Poll::Ready(Err(_)) => Poll::Ready(Err(JournalError::HostClosed)),
            Poll::Pending => Poll::Pending,
        }
    }
}
pub(crate) fn start<T: 'static, E: 'static, F: 'static>(
    effect: impl Future<Output = Result<T, JournalError<E, F>>> + 'static,
    prefix: bool,
) -> JournalTask<T, E, F> {
    let (sender, receiver) = oneshot::channel();
    let completion = Rc::new(RefCell::new(Some(sender)));
    let completed = Rc::clone(&completion);
    let mut work: LocalBoxFuture<'static, ()> = async move {
        let result = AssertUnwindSafe(effect)
            .catch_unwind()
            .await
            .unwrap_or_else(|cause| Err(JournalError::Panic(PanicCause::new(cause))));
        if let Some(sender) = completed.borrow_mut().take() {
            let _ = sender.send(result);
        }
    }
    .boxed_local();
    let finished = prefix
        && work
            .as_mut()
            .poll(&mut Context::from_waker(noop_waker_ref()))
            .is_ready();
    if !finished
        && let Err(cause) =
            std::panic::catch_unwind(AssertUnwindSafe(|| tokio::task::spawn_local(work)))
        && let Some(sender) = completion.borrow_mut().take()
    {
        let _ = sender.send(Err(JournalError::Panic(PanicCause::new(cause))));
    }
    JournalTask {
        receiver,
        first: true,
    }
}
