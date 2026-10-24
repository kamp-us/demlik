//! Host call transformers and pure, durable input gates.

mod debounce;
#[cfg(not(target_arch = "wasm32"))]
mod native;
mod throttle;
pub mod throttled_input;
pub use debounce::{Debounced, debounce};
#[cfg(not(target_arch = "wasm32"))]
pub use native::{TokioTimer, TokioTimerHandle, native_timeout_ms};
pub use throttle::{Throttled, throttle};

use crate::storage::PanicCause;
use std::fmt;

#[derive(Clone, Copy, Debug, Default)]
pub struct Edges {
    pub leading: Option<bool>,
    pub trailing: Option<bool>,
}

#[derive(Debug)]
pub struct TimerError {
    pub message: String,
    pub cause: Option<PanicCause>,
}
impl TimerError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cause: None,
        }
    }
    pub fn callback_panic(payload: Box<dyn std::any::Any + Send>) -> Self {
        let cause = PanicCause::new(payload);
        Self {
            message: cause.summary.clone(),
            cause: Some(cause),
        }
    }
}
impl fmt::Display for TimerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for TimerError {}

pub type TimerCallback = Box<dyn FnOnce() -> Result<(), TimerError>>;
/// An asynchronous, one-shot host timer. `set_timeout` must not invoke inline.
/// The adapter owns how callback errors/panics become observable to its host.
pub trait Timer {
    type Handle;
    fn now_ms(&self) -> f64;
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<Self::Handle, TimerError>;
    fn clear_timeout(&self, handle: &Self::Handle);
}
