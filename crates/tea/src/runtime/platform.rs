use crate::timing::TimerError;
use std::{future::Future, rc::Rc, time::Duration};

pub(super) fn spawn_owned(work: impl Future<Output = ()> + 'static) {
    #[cfg(not(target_arch = "wasm32"))]
    tokio::task::spawn_local(work);
    #[cfg(target_arch = "wasm32")]
    wasm_bindgen_futures::spawn_local(work);
}

pub(super) fn default_clock() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64
    }
    #[cfg(target_arch = "wasm32")]
    js_sys::Date::now()
}

pub(super) enum DeadlineError {
    Elapsed,
    #[cfg(target_arch = "wasm32")]
    Timer(TimerError),
}
impl DeadlineError {
    pub(super) fn into_timer(self) -> Option<TimerError> {
        match self {
            Self::Elapsed => None,
            #[cfg(target_arch = "wasm32")]
            Self::Timer(error) => Some(error),
        }
    }
}

pub(super) async fn deadline<F: Future>(
    _timer: &super::RuntimeTimer,
    duration: Duration,
    work: F,
    _report: Rc<dyn Fn(TimerError)>,
) -> Result<F::Output, DeadlineError> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        tokio::time::timeout(duration, work)
            .await
            .map_err(|_| DeadlineError::Elapsed)
    }
    #[cfg(target_arch = "wasm32")]
    _timer.deadline(duration, work, _report).await
}
