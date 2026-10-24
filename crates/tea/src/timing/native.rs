use super::{Timer, TimerCallback, TimerError};
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// A local Tokio timer adapter. Construct and invoke it inside the host's
/// LocalSet; asynchronous callback failures go to the supplied host sink.
pub struct TokioTimer {
    clock: Rc<dyn Fn() -> f64>,
    on_error: Rc<dyn Fn(TimerError)>,
}
impl TokioTimer {
    pub fn new(on_error: impl Fn(TimerError) + 'static) -> Self {
        Self::with_clock(
            || {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|time| time.as_millis() as f64)
                    .unwrap_or_else(|error| -(error.duration().as_millis() as f64))
            },
            on_error,
        )
    }
    pub fn with_clock(
        clock: impl Fn() -> f64 + 'static,
        on_error: impl Fn(TimerError) + 'static,
    ) -> Self {
        Self {
            clock: Rc::new(clock),
            on_error: Rc::new(on_error),
        }
    }
}
pub struct TokioTimerHandle(tokio::task::AbortHandle);
/// Node's timeout-number profile: invalid/out-of-range/sub-millisecond delays
/// become one millisecond; other fractional delays truncate.
pub fn native_timeout_ms(ms: f64) -> u64 {
    if !ms.is_finite() || !(1.0..=2_147_483_647.0).contains(&ms) {
        1
    } else {
        ms.trunc() as u64
    }
}
impl Timer for TokioTimer {
    type Handle = TokioTimerHandle;
    fn now_ms(&self) -> f64 {
        (self.clock)()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<Self::Handle, TimerError> {
        tokio::runtime::Handle::try_current().map_err(|_| {
            TimerError::new("a local Tokio executor is required to arm a native timer")
        })?;
        let on_error = Rc::clone(&self.on_error);
        let future = async move {
            tokio::time::sleep(Duration::from_millis(native_timeout_ms(ms))).await;
            match catch_unwind(AssertUnwindSafe(callback)) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => on_error(error),
                Err(payload) => on_error(TimerError::callback_panic(payload)),
            }
        };
        catch_unwind(AssertUnwindSafe(|| tokio::task::spawn_local(future)))
            .map(|task| TokioTimerHandle(task.abort_handle()))
            .map_err(TimerError::callback_panic)
    }
    fn clear_timeout(&self, handle: &Self::Handle) {
        handle.0.abort();
    }
}
