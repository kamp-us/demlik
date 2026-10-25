use super::{Queue, QueueField, QueueItem, QueueItemStatus, QueueTime};
use crate::data::JsText;
use std::rc::Rc;

pub struct Enqueued<I> {
    pub next: Queue<I>,
    pub item: Rc<QueueItem<I>>,
}
pub struct Claimed<I> {
    pub next: Queue<I>,
    pub claimed: Rc<QueueItem<I>>,
}
pub struct QueueChange<I> {
    pub next: Queue<I>,
    pub changed: bool,
}

pub fn enqueue_op<I>(
    queue: &Queue<I>,
    input: Rc<I>,
    now: impl Into<QueueTime>,
    id: impl Into<JsText>,
) -> Enqueued<I> {
    let item = Rc::new(QueueItem::new(input, now, id));
    let mut next = queue.to_vec();
    next.push(item.clone());
    Enqueued {
        next: Queue::from_items(next),
        item,
    }
}
pub fn claim_next_op<I>(queue: &Queue<I>, now: impl Into<QueueTime>) -> Option<Claimed<I>> {
    let items = queue.items();
    let index = items
        .iter()
        .position(|item| item.status == QueueItemStatus::Pending)?;
    let claimed = Rc::new(
        items[index]
            .with_status(QueueItemStatus::Running)
            .with_started_at(QueueField::Value(now.into())),
    );
    let mut next = items.clone();
    next[index] = claimed.clone();
    Some(Claimed {
        next: Queue::from_items(next),
        claimed,
    })
}
pub fn mark_done_op<I>(queue: &Queue<I>, id: impl Into<JsText>) -> QueueChange<I> {
    let id = id.into();
    let next: Vec<_> = queue
        .items()
        .iter()
        .filter(|item| item.id != id)
        .cloned()
        .collect();
    let changed = next.len() != queue.len();
    QueueChange {
        next: Queue::from_items(next),
        changed,
    }
}
pub fn patch_item_op<I>(
    queue: &Queue<I>,
    id: impl Into<JsText>,
    patch: impl FnOnce(&Rc<QueueItem<I>>) -> Rc<QueueItem<I>>,
) -> QueueChange<I> {
    let id = id.into();
    let mut next = queue.to_vec();
    let Some(index) = next.iter().position(|item| item.id == id) else {
        return QueueChange {
            next: Queue::from_items(next),
            changed: false,
        };
    };
    let target = next[index].clone();
    next[index] = patch(&target);
    QueueChange {
        next: Queue::from_items(next),
        changed: true,
    }
}
pub fn reset_running_op<I>(queue: &Queue<I>) -> QueueChange<I> {
    let mut changed = false;
    let next = queue
        .items()
        .iter()
        .map(|item| {
            if item.status != QueueItemStatus::Running {
                return item.clone();
            }
            changed = true;
            Rc::new(
                item.with_status(QueueItemStatus::Pending)
                    .with_started_at(QueueField::Undefined),
            )
        })
        .collect();
    QueueChange {
        next: Queue::from_items(next),
        changed,
    }
}
pub fn remove_op<I>(queue: &Queue<I>, id: impl Into<JsText>) -> QueueChange<I> {
    mark_done_op(queue, id)
}
