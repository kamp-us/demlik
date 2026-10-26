//! Retain a boot anchor and applied messages without cloning their values.

use crate::{
    Tagged,
    runtime::{Runtime, Unsubscribe},
};
mod projections;
pub use projections::*;
mod wire;
pub use wire::*;

use std::{
    cell::{Cell, RefCell},
    fmt,
    rc::Rc,
    sync::Arc,
};

pub struct TraceStep<S, M> {
    pub msg: Arc<M>,
    pub state: Arc<S>,
}
impl<S, M> Clone for TraceStep<S, M> {
    fn clone(&self) -> Self {
        Self {
            msg: Arc::clone(&self.msg),
            state: Arc::clone(&self.state),
        }
    }
}
pub struct Trace<S, M> {
    /// None is the source's null/missing replay anchor.
    pub loaded: Option<Arc<S>>,
    pub msgs: Vec<Arc<M>>,
    pub final_state: Arc<S>,
    pub steps: Option<Vec<TraceStep<S, M>>>,
}
impl<S, M> Clone for Trace<S, M> {
    fn clone(&self) -> Self {
        Self {
            loaded: self.loaded.clone(),
            msgs: self.msgs.clone(),
            final_state: self.final_state.clone(),
            steps: self.steps.clone(),
        }
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct RecorderOptions {
    pub sample_rate: Option<f64>,
    pub capture_steps: bool,
}
/// At the raw-data boundary, distinguish JS null and undefined from a typed value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateKind {
    Value,
    Null,
    Undefined,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecorderError {
    BeforeObservation { operation: &'static str },
}
impl fmt::Display for RecorderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self::BeforeObservation { operation } = self;
        write!(
            f,
            "tea recorder: {operation}() called before any transition was observed. Await `runtime.ready` (boot fires the first observe) before {}.",
            if *operation == "dump" {
                "dumping"
            } else {
                "serializing"
            }
        )
    }
}
impl std::error::Error for RecorderError {}
struct Buffer<S, M> {
    loaded: Option<Arc<S>>,
    msgs: Vec<Arc<M>>,
    final_state: Option<Arc<S>>,
    steps: Vec<TraceStep<S, M>>,
}
struct Inner<'a, S, M> {
    state: RefCell<Buffer<S, M>>,
    sample_rate: f64,
    capture_steps: bool,
    rng: Rc<dyn Fn() -> f64 + 'a>,
    state_kind: fn(&S) -> StateKind,
    stopped: Cell<bool>,
    detach: RefCell<Option<(Unsubscribe, Unsubscribe)>>,
}
impl<S, M> Drop for Inner<'_, S, M> {
    fn drop(&mut self) {
        if let Some((unobserve, unboot)) = self.detach.get_mut().take() {
            unobserve();
            unboot();
        }
    }
}
pub struct Recorder<'a, S, M> {
    inner: Rc<Inner<'a, S, M>>,
}
impl<'a, S, M> Recorder<'a, S, M> {
    pub fn new(options: RecorderOptions) -> Self {
        Self::with_rng(options, fastrand::f64)
    }
    pub fn with_rng(options: RecorderOptions, rng: impl Fn() -> f64 + 'a) -> Self {
        Self::with_state_kind(options, rng, |_| StateKind::Value)
    }
    pub fn with_state_kind(
        options: RecorderOptions,
        rng: impl Fn() -> f64 + 'a,
        state_kind: fn(&S) -> StateKind,
    ) -> Self {
        let raw = options.sample_rate.unwrap_or(1.0);
        let sample_rate = if raw.is_nan() || raw <= 0.0 {
            1.0
        } else {
            raw.min(1.0)
        };
        Self {
            inner: Rc::new(Inner {
                state: RefCell::new(Buffer {
                    loaded: None,
                    msgs: vec![],
                    final_state: None,
                    steps: vec![],
                }),
                sample_rate,
                capture_steps: options.capture_steps,
                rng: Rc::new(rng),
                state_kind,
                stopped: Cell::new(false),
                detach: RefCell::new(None),
            }),
        }
    }
    pub fn record_boot(&self, state: Arc<S>) {
        if self.inner.stopped.get() {
            return;
        }
        let kind = (self.inner.state_kind)(&state);
        let mut recording = self.inner.state.borrow_mut();
        recording.loaded = if kind == StateKind::Null {
            None
        } else {
            Some(Arc::clone(&state))
        };
        recording.final_state = if kind == StateKind::Undefined {
            None
        } else {
            Some(state)
        };
    }
    pub fn record_step(&self, msg: Arc<M>, state: Arc<S>) {
        if self.inner.stopped.get() {
            return;
        }
        self.inner.state.borrow_mut().final_state =
            if (self.inner.state_kind)(&state) == StateKind::Undefined {
                None
            } else {
                Some(Arc::clone(&state))
            };
        // Run the sampler without a buffer borrow: it may reenter recording.
        if self.inner.sample_rate < 1.0 && (self.inner.rng)() >= self.inner.sample_rate {
            return;
        }
        let mut recording = self.inner.state.borrow_mut();
        recording.msgs.push(Arc::clone(&msg));
        if self.inner.capture_steps {
            recording.steps.push(TraceStep { msg, state });
        }
    }
    pub fn dump(&self) -> Result<Trace<S, M>, RecorderError> {
        self.snapshot("dump")
    }
    fn snapshot(&self, operation: &'static str) -> Result<Trace<S, M>, RecorderError> {
        let recording = self.inner.state.borrow();
        let Some(final_state) = &recording.final_state else {
            return Err(RecorderError::BeforeObservation { operation });
        };
        Ok(Trace {
            loaded: recording.loaded.clone(),
            msgs: recording.msgs.clone(),
            final_state: Arc::clone(final_state),
            steps: self.inner.capture_steps.then(|| recording.steps.clone()),
        })
    }
    pub fn stop(&self) {
        if self.inner.stopped.replace(true) {
            return;
        }
        let detach = self.inner.detach.borrow_mut().take();
        if let Some((unobserve, unboot)) = detach {
            unobserve();
            unboot();
        }
    }
}
pub fn recorder<
    S: 'static,
    M: Tagged + 'static,
    SE: 'static,
    HE: 'static,
    E: Tagged + 'static,
    RE: 'static,
>(
    runtime: &Runtime<S, M, SE, HE, E, RE>,
    options: RecorderOptions,
) -> Recorder<'static, S, M> {
    recorder_with(runtime, options, fastrand::f64, |_| StateKind::Value)
}
pub fn recorder_with<
    S: 'static,
    M: Tagged + 'static,
    SE: 'static,
    HE: 'static,
    E: Tagged + 'static,
    RE: 'static,
>(
    runtime: &Runtime<S, M, SE, HE, E, RE>,
    options: RecorderOptions,
    rng: impl Fn() -> f64 + 'static,
    state_kind: fn(&S) -> StateKind,
) -> Recorder<'static, S, M> {
    let result = Recorder::with_state_kind(options, rng, state_kind);
    let boot = Rc::downgrade(&result.inner);
    let unboot = runtime.on_boot_retained(move |state| {
        if let Some(inner) = boot.upgrade() {
            Recorder { inner }.record_boot(Arc::clone(state));
        }
    });
    let observe = Rc::downgrade(&result.inner);
    let unobserve = runtime.observe_retained(move |msg, state| {
        if let Some(inner) = observe.upgrade() {
            Recorder { inner }.record_step(Arc::clone(msg), Arc::clone(state));
        }
    });
    *result.inner.detach.borrow_mut() = Some((unobserve, unboot));
    result
}
