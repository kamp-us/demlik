use super::{Producer, Profile, SubscriptionWork};
use crate::timing::{Timer, TimerCallback, TimerError};
use crate::{Tagged, TimerDeps};
use std::{cell::RefCell, rc::Rc};

type CancelTimer = Box<dyn FnOnce()>;
type Arm = dyn Fn(f64, TimerCallback) -> Result<CancelTimer, TimerError>;
/// Erases only the host's timer token. Scheduling remains owned by `timing::Timer`.
#[derive(Clone)]
pub struct RuntimeTimer(Rc<Arm>);
impl RuntimeTimer {
    pub fn new<T: Timer + 'static>(timer: Rc<T>) -> Self {
        Self(Rc::new(move |ms, callback| {
            let handle = timer.set_timeout(ms, callback)?;
            let timer = Rc::clone(&timer);
            Ok(Box::new(move || timer.clear_timeout(&handle)))
        }))
    }
    pub(crate) fn start<M: Tagged + 'static, HE: 'static>(
        &self,
        deps: TimerDeps<M>,
        profile: Profile,
        producer: Producer<M>,
        report: Rc<dyn Fn(TimerError)>,
    ) -> Result<SubscriptionWork<HE>, TimerError> {
        if profile == Profile::Promise {
            let cancel = (self.0)(
                deps.ms,
                Box::new(move || {
                    let _ = producer.emit(deps.msg);
                    Ok(())
                }),
            )?;
            return Ok(SubscriptionWork::new(move || {
                cancel();
                async { Ok(()) }
            }));
        }
        // Duration.millis maps NaN to zero and rounds fractional milliseconds
        // to nanoseconds before Clock.sleep selects yield/never/chunked timeouts.
        let ms = if deps.ms.is_nan() {
            0.0
        } else if deps.ms.is_finite() && deps.ms.fract() != 0.0 {
            // Preserve Duration's floating arithmetic before BigInt conversion;
            // round() differs when the +0.5 rounds a large odd integer upward.
            let nanos = deps.ms * 1_000_000.0;
            let rounded = if nanos < 0.0 {
                (nanos - 0.5).ceil()
            } else {
                (nanos + 0.5).floor()
            };
            rounded / 1_000_000.0
        } else {
            deps.ms
        };
        let slot: Rc<RefCell<Option<CancelTimer>>> = Rc::new(RefCell::new(None));
        let first = if ms > 0.0 && ms.is_finite() {
            Some(self.arm_chunk(ms, &slot)?)
        } else {
            None
        };
        let cleanup = Rc::clone(&slot);
        let timer = self.clone();
        Ok(SubscriptionWork::new(move || {
            if let Some(cancel) = cleanup.borrow_mut().take() {
                cancel();
            }
            async { Ok(()) }
        })
        .with_source(async move {
            if ms <= 0.0 {
                tokio::task::yield_now().await;
            } else if !ms.is_finite() {
                futures::future::pending::<()>().await;
            } else {
                let mut remaining = ms;
                let mut wake = first.expect("positive finite timer has a first chunk");
                loop {
                    if wake.await.is_err() {
                        // An externally cleared host timer never fires. Keep the
                        // source parked until its subscription is interrupted.
                        futures::future::pending::<()>().await;
                    }
                    // Effect's callback canceller is released on successful
                    // completion; it runs only while a sleep is interrupted.
                    slot.borrow_mut().take();
                    remaining -= remaining.min(2_147_483_647.0);
                    if remaining <= 0.0 {
                        break;
                    }
                    // Later host-arm failures are reported by the runtime's timer
                    // reporter, without imposing From<TimerError> on handler errors.
                    wake = match timer.arm_chunk(remaining, &slot) {
                        Ok(wake) => wake,
                        Err(error) => {
                            report(error);
                            return Ok(());
                        }
                    };
                }
            }
            let _ = producer.emit(deps.msg);
            Ok(())
        }))
    }
    fn arm_chunk(
        &self,
        ms: f64,
        slot: &Rc<RefCell<Option<CancelTimer>>>,
    ) -> Result<tokio::sync::oneshot::Receiver<()>, TimerError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        *slot.borrow_mut() = Some((self.0)(
            ms.min(2_147_483_647.0),
            Box::new(move || {
                let _ = tx.send(());
                Ok(())
            }),
        )?);
        Ok(rx)
    }
}

#[cfg(target_arch = "wasm32")]
struct DeadlineCancel {
    slot: Rc<RefCell<Option<CancelTimer>>>,
    report: Rc<dyn Fn(TimerError)>,
}
#[cfg(target_arch = "wasm32")]
impl DeadlineCancel {
    fn cancel(&self) -> Result<(), TimerError> {
        let cancel = self.slot.borrow_mut().take();
        if let Some(cancel) = cancel {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(cancel))
                .map_err(TimerError::callback_panic)?;
        }
        Ok(())
    }
}
#[cfg(target_arch = "wasm32")]
impl Drop for DeadlineCancel {
    fn drop(&mut self) {
        if let Err(error) = self.cancel() {
            (self.report)(error);
        }
    }
}
#[cfg(target_arch = "wasm32")]
impl RuntimeTimer {
    pub(super) async fn deadline<F: std::future::Future>(
        &self,
        duration: std::time::Duration,
        work: F,
        report: Rc<dyn Fn(TimerError)>,
    ) -> Result<F::Output, super::platform::DeadlineError> {
        use super::platform::DeadlineError;
        use futures::{
            FutureExt,
            future::{Either, select},
        };
        let mut work = Box::pin(work);
        if let Some(value) = work.as_mut().now_or_never() {
            return Ok(value);
        }
        let slot = Rc::new(RefCell::new(None));
        let cancel = DeadlineCancel {
            slot: Rc::clone(&slot),
            report,
        };
        let elapsed = async {
            let mut remaining = duration.as_secs_f64() * 1000.0;
            loop {
                let wake = self
                    .arm_chunk(remaining, &slot)
                    .map_err(DeadlineError::Timer)?;
                wake.await.map_err(|_| {
                    DeadlineError::Timer(TimerError::new(
                        "runtime deadline timer closed before firing",
                    ))
                })?;
                slot.borrow_mut().take();
                remaining -= remaining.min(2_147_483_647.0);
                if remaining <= 0.0 {
                    return Err(DeadlineError::Elapsed);
                }
            }
        };
        let result = match select(work, Box::pin(elapsed)).await {
            Either::Left((value, _)) => Ok(value),
            Either::Right((error, _)) => error,
        };
        cancel.cancel().map_err(DeadlineError::Timer)?;
        result
    }
}
