use super::types::Terminal;
use super::{Failure, Profile, Runtime, Unsubscribe, work::Cancel};
use crate::{Tagged, storage::PanicCause};
use futures::{FutureExt, future::LocalBoxFuture};
use std::{
    cell::RefCell,
    convert::Infallible,
    fmt,
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    rc::Rc,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::sync::oneshot;

pub enum DriveStart<S, M> {
    Msg(M),
    Select(Box<dyn FnOnce(&S) -> M>),
}
impl<S, M> DriveStart<S, M> {
    pub fn select(choose: impl FnOnce(&S) -> M + 'static) -> Self {
        Self::Select(Box::new(choose))
    }
    fn message(self, state: &S) -> M {
        match self {
            Self::Msg(message) => message,
            Self::Select(choose) => choose(state),
        }
    }
}
impl<S, M> From<M> for DriveStart<S, M> {
    fn from(message: M) -> Self {
        Self::Msg(message)
    }
}
#[derive(Clone)]
pub struct DriveSignal(Arc<Cancel>);
impl Default for DriveSignal {
    fn default() -> Self {
        Self::new()
    }
}
impl DriveSignal {
    pub fn new() -> Self {
        Self(Arc::new(Cancel::new()))
    }
    pub fn abort(&self) {
        self.0.cancel();
    }
    pub fn is_aborted(&self) -> bool {
        self.0.is_cancelled()
    }
}
pub struct DriveCancellation<S, M> {
    signal: DriveSignal,
    cancel: Rc<dyn Fn(&S) -> M>,
}
impl<S, M> DriveCancellation<S, M> {
    pub fn new(signal: DriveSignal, cancel: impl Fn(&S) -> M + 'static) -> Self {
        Self {
            signal,
            cancel: Rc::new(cancel),
        }
    }
}
pub struct DriveOptions<S, M> {
    pub failed: Option<Terminal<S>>,
    pub cancellation: Option<DriveCancellation<S, M>>,
}
impl<S, M> Default for DriveOptions<S, M> {
    fn default() -> Self {
        Self {
            failed: None,
            cancellation: None,
        }
    }
}
pub enum DriveError<S, SE, HE, RE = Infallible> {
    Failed { state: Arc<S> },
    Stalled { state: Arc<S> },
    Runtime(Failure<SE, HE, RE>),
    Panic(PanicCause),
    Interrupted,
}
impl<S, SE, HE, RE> DriveError<S, SE, HE, RE> {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Failed { .. } => "DriveFailedError",
            Self::Stalled { .. } => "DriveStalledError",
            Self::Runtime(error) => error.name(),
            Self::Panic(_) => "Panic",
            Self::Interrupted => "Interrupted",
        }
    }
    pub fn state(&self) -> Option<&Arc<S>> {
        match self {
            Self::Failed { state } | Self::Stalled { state } => Some(state),
            _ => None,
        }
    }
}
impl<S, SE, HE, RE> fmt::Debug for DriveError<S, SE, HE, RE> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed { .. } => f.write_str("DriveFailedError"),
            Self::Stalled { .. } => f.write_str("DriveStalledError"),
            Self::Runtime(error) => f.debug_tuple("Runtime").field(&error.name()).finish(),
            Self::Panic(cause) => f.debug_tuple("Panic").field(cause).finish(),
            Self::Interrupted => f.write_str("Interrupted"),
        }
    }
}
impl<S, SE, HE, RE> fmt::Display for DriveError<S, SE, HE, RE> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl<S, SE, HE, RE> std::error::Error for DriveError<S, SE, HE, RE> {}
type Outcome<S, SE, HE, RE> = Result<Arc<S>, DriveError<S, SE, HE, RE>>;
type Receipt<S, SE, HE, RE> = oneshot::Receiver<Outcome<S, SE, HE, RE>>;
type Starter<S, SE, HE, RE> = Box<dyn FnOnce() -> Receipt<S, SE, HE, RE>>;
/// Promise drives start eagerly and retain ownership after their waiter drops.
/// Effect drives start on first poll; dropping a started waiter requests an
/// interrupt. The owned driver always awaits stop before settling its receipt.
#[must_use = "await the drive to observe the terminal state and awaited teardown"]
pub struct DriveTask<S, SE, HE, RE = Infallible> {
    starter: Option<Starter<S, SE, HE, RE>>,
    receiver: Option<Receipt<S, SE, HE, RE>>,
    cancel: Arc<Cancel>,
    profile: Profile,
    completed: bool,
}
impl<S, SE, HE, RE> DriveTask<S, SE, HE, RE> {
    pub fn request_interrupt(&self) {
        self.cancel.cancel();
    }
    pub async fn interrupt(self) -> Outcome<S, SE, HE, RE> {
        self.request_interrupt();
        self.await
    }
}
impl<S, SE, HE, RE> Future for DriveTask<S, SE, HE, RE> {
    type Output = Outcome<S, SE, HE, RE>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if let Some(start) = this.starter.take() {
            this.receiver = Some(start());
        }
        match Pin::new(this.receiver.as_mut().expect("drive is started")).poll(cx) {
            Poll::Ready(answer) => {
                this.completed = true;
                Poll::Ready(answer.expect("owned drive settles after cleanup"))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
impl<S, SE, HE, RE> Drop for DriveTask<S, SE, HE, RE> {
    fn drop(&mut self) {
        if self.profile == Profile::Effect && !self.completed && self.receiver.is_some() {
            self.cancel.cancel();
        }
    }
}

pub fn drive_to_done<
    S: 'static,
    M: Tagged + 'static,
    SE: 'static,
    HE: 'static,
    E: Tagged + 'static,
    RE: 'static,
>(
    runtime: &Runtime<S, M, SE, HE, E, RE>,
    start: impl Into<DriveStart<S, M>>,
    is_terminal: impl Fn(&S) -> bool + 'static,
    options: DriveOptions<S, M>,
) -> DriveTask<S, SE, HE, RE> {
    let profile = runtime.profile();
    let cancel = Arc::new(Cancel::new());
    let signal = Arc::clone(&cancel);
    let runtime = runtime.clone();
    let start = start.into();
    let is_terminal: Terminal<S> = Rc::new(is_terminal);
    let launch: Starter<S, SE, HE, RE> = Box::new(move || {
        let (tx, rx) = oneshot::channel();
        super::platform::spawn_owned(async move {
            let detach = Rc::new(RefCell::new(None::<Unsubscribe>));
            let attached = Rc::clone(&detach);
            let work = drive(&runtime, start, is_terminal, options, attached);
            let answer = tokio::select! {biased;_=signal.cancelled()=>Err(DriveError::Interrupted),result=AssertUnwindSafe(work).catch_unwind()=>result.unwrap_or_else(|payload|Err(DriveError::Panic(PanicCause::new(payload))))};
            if let Some(detach) = detach.borrow_mut().take() {
                detach();
            }
            runtime.stop().await;
            let _ = tx.send(answer);
        });
        rx
    });
    let (mut starter, mut receiver) = (Some(launch), None);
    if profile == Profile::Promise {
        receiver = Some(starter.take().expect("starter present")());
    }
    DriveTask {
        starter,
        receiver,
        cancel,
        profile,
        completed: false,
    }
}
async fn drive<
    S: 'static,
    M: Tagged + 'static,
    SE: 'static,
    HE: 'static,
    E: Tagged + 'static,
    RE: 'static,
>(
    runtime: &Runtime<S, M, SE, HE, E, RE>,
    start: DriveStart<S, M>,
    terminal: Terminal<S>,
    options: DriveOptions<S, M>,
    detach: Rc<RefCell<Option<Unsubscribe>>>,
) -> Outcome<S, SE, HE, RE> {
    runtime.ready().await.map_err(DriveError::Runtime)?;
    let booted = runtime.get_state().expect("ready runtime has state");
    let failed = options.failed.unwrap_or_else(|| Rc::new(|_| false));
    let settles = {
        let terminal = Rc::clone(&terminal);
        let failed = Rc::clone(&failed);
        move |s: &S| terminal(s) || failed(s)
    };
    let outcome = |state: Arc<S>| {
        if failed(&state) {
            Err(DriveError::Failed { state })
        } else {
            Ok(state)
        }
    };
    if settles(&booted) {
        return outcome(booted);
    }
    let (tx, mut terminal_rx) = oneshot::channel();
    let tx = RefCell::new(Some(tx));
    let terminal_observe = Rc::clone(&terminal);
    let failed_observe = Rc::clone(&failed);
    *detach.borrow_mut() = Some(runtime.observe_snapshot(move |_, state| {
        if (terminal_observe(&state) || failed_observe(&state))
            && let Some(tx) = tx.borrow_mut().take()
        {
            let _ = tx.send(state);
        }
    }));
    if let Some(cancellation) = options
        .cancellation
        .as_ref()
        .filter(|cancellation| cancellation.signal.is_aborted())
    {
        let message = (cancellation.cancel)(&booted);
        let dispatch = runtime.dispatch_once(message);
        tokio::pin!(dispatch);
        return tokio::select! {biased;
            state=&mut terminal_rx=>outcome(state.expect("observer retains terminal receipt")),
            answer=&mut dispatch=>{answer.map_err(DriveError::Runtime)?;outcome(terminal_rx.await.expect("observer retains terminal receipt"))},
        };
    }
    let mut cancel_failed: LocalBoxFuture<'_, Outcome<S, SE, HE, RE>> =
        if let Some(cancellation) = options.cancellation {
            async move {
                cancellation.signal.0.cancelled().await;
                let state = runtime.get_state().expect("ready runtime has state");
                let message = (cancellation.cancel)(&state);
                runtime
                    .dispatch_once(message)
                    .await
                    .map_err(DriveError::Runtime)?;
                futures::future::pending().await
            }
            .boxed_local()
        } else {
            futures::future::pending().boxed_local()
        };
    let message = start.message(&booted);
    let started = async {
        runtime
            .dispatch(message)
            .await
            .map_err(DriveError::Runtime)?;
        let parked = runtime.get_state().expect("ready runtime has state");
        if !settles(&parked) && runtime.live_work() == (0, 0) {
            return Err(DriveError::Stalled { state: parked });
        }
        futures::future::pending::<Outcome<S, SE, HE, RE>>().await
    };
    tokio::pin!(started);
    let state = tokio::select! {biased;state=&mut terminal_rx=>Ok(state.expect("observer retains terminal receipt")),answer=&mut started=>answer,answer=&mut cancel_failed=>answer}?;
    outcome(state)
}
