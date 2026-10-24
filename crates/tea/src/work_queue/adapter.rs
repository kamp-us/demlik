use super::{
    Claimed, Enqueued, Queue, QueueChange, QueueItem, claim_next_op, enqueue_op, mark_done_op,
    patch_item_op,
};
use crate::data::JsText;
use std::rc::Rc;

pub trait QueueAdapter<I> {
    fn enqueue(&self, queue: &Queue<I>, input: Rc<I>, now: f64, id: JsText) -> Enqueued<I>;
    fn claim(&self, queue: &Queue<I>, now: f64) -> Option<Claimed<I>>;
    fn mark_done(&self, queue: &Queue<I>, id: impl Into<JsText>) -> QueueChange<I>;
    fn patch(
        &self,
        queue: &Queue<I>,
        id: impl Into<JsText>,
        patch: impl FnOnce(&Rc<QueueItem<I>>) -> Rc<QueueItem<I>>,
    ) -> QueueChange<I>;
}
pub struct QueueOps;
pub fn queue_adapter() -> QueueOps {
    QueueOps
}
impl<I> QueueAdapter<I> for QueueOps {
    fn enqueue(&self, queue: &Queue<I>, input: Rc<I>, now: f64, id: JsText) -> Enqueued<I> {
        enqueue_op(queue, input, now, id)
    }
    fn claim(&self, queue: &Queue<I>, now: f64) -> Option<Claimed<I>> {
        claim_next_op(queue, now)
    }
    fn mark_done(&self, queue: &Queue<I>, id: impl Into<JsText>) -> QueueChange<I> {
        mark_done_op(queue, id)
    }
    fn patch(
        &self,
        queue: &Queue<I>,
        id: impl Into<JsText>,
        patch: impl FnOnce(&Rc<QueueItem<I>>) -> Rc<QueueItem<I>>,
    ) -> QueueChange<I> {
        patch_item_op(queue, id, patch)
    }
}
