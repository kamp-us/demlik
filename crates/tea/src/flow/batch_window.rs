//! Pure size/time batching. The timer selector is relative; the deadline
//! selector preserves its absolute target when the window is restored.

pub use crate::resilience::deadline::{
    Deadline as BatchWindowSub, DeadlineExceeded as BatchWindowExpired,
    subscribe_deadline as subscribe_batch_window,
};
pub use crate::timing::{Debounced, debounce};
use crate::{
    Step, Tagged, TimerDeps,
    data::JsText,
    resilience::deadline::{deadline_exceeded, deadline_sub},
};
use serde::Serialize;
use std::rc::Rc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchWindow<I> {
    pub buffer: Rc<Vec<Rc<I>>>,
    pub opened_at: Option<f64>,
}
pub fn init_batch_window<I>() -> Rc<BatchWindow<I>> {
    Rc::new(BatchWindow {
        buffer: Rc::new(vec![]),
        opened_at: None,
    })
}
type Flush<'a, I, C> = Box<dyn Fn(&Rc<Vec<Rc<I>>>) -> C + 'a>;
pub struct BatchWindowConfig<'a, I, C> {
    pub max_items: f64,
    pub max_ms: f64,
    flush: Flush<'a, I, C>,
}
impl<'a, I, C> BatchWindowConfig<'a, I, C> {
    pub fn new(max_items: f64, max_ms: f64, flush: impl Fn(&Rc<Vec<Rc<I>>>) -> C + 'a) -> Self {
        Self {
            max_items,
            max_ms,
            flush: Box::new(flush),
        }
    }
}
pub fn add_item<I, C: Tagged>(
    config: &BatchWindowConfig<'_, I, C>,
    state: &Rc<BatchWindow<I>>,
    item: Rc<I>,
    at: f64,
) -> Step<Rc<BatchWindow<I>>, C> {
    let mut items = state.buffer.as_ref().clone();
    items.push(item);
    let buffer = Rc::new(items);
    let opened_at = Some(state.opened_at.unwrap_or(at));
    if buffer.len() as f64 >= crate::js_math::max(1.0, config.max_items) {
        return Step::new(init_batch_window(), vec![(config.flush)(&buffer)]);
    }
    Step::new(Rc::new(BatchWindow { buffer, opened_at }), vec![])
}
pub fn on_window<I, C: Tagged>(
    config: &BatchWindowConfig<'_, I, C>,
    state: &Rc<BatchWindow<I>>,
    _at: f64,
) -> Step<Rc<BatchWindow<I>>, C> {
    if state.buffer.is_empty() {
        return Step::new(Rc::clone(state), vec![]);
    }
    Step::new(init_batch_window(), vec![(config.flush)(&state.buffer)])
}
pub fn batch_window_expired(id: impl Into<JsText>, at_ms: f64) -> BatchWindowExpired {
    deadline_exceeded(id, at_ms, None)
}
pub fn subs_for<I, C>(
    config: &BatchWindowConfig<'_, I, C>,
    state: &BatchWindow<I>,
    id: Option<&JsText>,
) -> Vec<BatchWindowSub> {
    state.opened_at.map_or_else(Vec::new, |opened| {
        vec![deadline_sub(
            id.cloned().unwrap_or_else(|| "batch-window".into()),
            opened + config.max_ms,
        )]
    })
}
pub fn timer_for<I, C>(
    config: &BatchWindowConfig<'_, I, C>,
    state: &BatchWindow<I>,
    id: Option<&JsText>,
) -> Option<TimerDeps<BatchWindowExpired>> {
    state.opened_at.map(|opened| TimerDeps {
        ms: config.max_ms,
        msg: batch_window_expired(
            id.cloned().unwrap_or_else(|| "batch-window".into()),
            opened + config.max_ms,
        ),
    })
}

pub struct BatchWindowKnob<'a, I, C> {
    config: BatchWindowConfig<'a, I, C>,
}
pub fn create_batch_window<I, C: Tagged>(
    config: BatchWindowConfig<'_, I, C>,
) -> BatchWindowKnob<'_, I, C> {
    BatchWindowKnob { config }
}
impl<I, C: Tagged> BatchWindowKnob<'_, I, C> {
    pub fn init(&self) -> Rc<BatchWindow<I>> {
        init_batch_window()
    }
    pub fn add(
        &self,
        state: &Rc<BatchWindow<I>>,
        item: Rc<I>,
        at: f64,
    ) -> Step<Rc<BatchWindow<I>>, C> {
        add_item(&self.config, state, item, at)
    }
    pub fn on_window(&self, state: &Rc<BatchWindow<I>>, at: f64) -> Step<Rc<BatchWindow<I>>, C> {
        on_window(&self.config, state, at)
    }
    pub fn timer(
        &self,
        state: &BatchWindow<I>,
        id: Option<&JsText>,
    ) -> Option<TimerDeps<BatchWindowExpired>> {
        timer_for(&self.config, state, id)
    }
    pub fn subs(&self, state: &BatchWindow<I>, id: Option<&JsText>) -> Vec<BatchWindowSub> {
        subs_for(&self.config, state, id)
    }
}
