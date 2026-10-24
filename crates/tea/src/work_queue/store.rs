use super::{
    Queue, QueueChange, QueueField, QueueItem, QueueItemStatus, claim_next_op, enqueue_op,
    mark_done_op, patch_item_op, remove_op, reset_running_op,
};
use crate::{
    data::JsText,
    storage::{PanicCause, Store, StoreRefusedError, restore},
};
use futures::FutureExt;
use std::{
    fmt,
    marker::PhantomData,
    panic::AssertUnwindSafe,
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub enum QueueError<E> {
    Restore(StoreRefusedError<E>),
    Save(E),
    SavePanic(PanicCause),
    SourcePanic(PanicCause),
}
impl<E: fmt::Display> fmt::Display for QueueError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Restore(error) => error.fmt(f),
            Self::Save(error) => error.fmt(f),
            Self::SavePanic(cause) | Self::SourcePanic(cause) => cause.summary.fmt(f),
        }
    }
}
impl<E: std::error::Error + 'static> std::error::Error for QueueError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Restore(error) => Some(error),
            Self::Save(error) => Some(error),
            Self::SavePanic(_) | Self::SourcePanic(_) => None,
        }
    }
}
pub struct QueueClient<I, P, C = fn() -> f64, G = fn() -> JsText> {
    store: P,
    clock: C,
    id: G,
    input: PhantomData<fn() -> I>,
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}
fn uuid() -> JsText {
    let mut bytes = [0; 16];
    if let Err(error) = getrandom::fill(&mut bytes) {
        std::panic::panic_any(Box::new(error) as Box<dyn std::error::Error + Send>);
    }
    let random = (u128::from_be_bytes(bytes) & !(0xf000_u128 << 64 | 0xc000_u128 << 48))
        | 0x4000_u128 << 64
        | 0x8000_u128 << 48;
    let hex = format!("{random:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
    .into()
}
pub fn create_queue<I, P>(store: P) -> QueueClient<I, P> {
    QueueClient::with_sources(store, now, uuid)
}
impl<I, P, C, G> QueueClient<I, P, C, G> {
    pub fn with_sources(store: P, clock: C, id: G) -> Self {
        Self {
            store,
            clock,
            id,
            input: PhantomData,
        }
    }
    pub fn store(&self) -> &P {
        &self.store
    }
}
impl<I, P: Store<Queue<I>>, C: Fn() -> f64, G: Fn() -> JsText> QueueClient<I, P, C, G>
where
    P::Error: fmt::Display,
{
    fn source<T>(&self, read: impl FnOnce() -> T) -> Result<T, QueueError<P::Error>> {
        std::panic::catch_unwind(AssertUnwindSafe(read))
            .map_err(|cause| QueueError::SourcePanic(PanicCause::new(cause)))
    }
    pub async fn list(&self) -> Result<Queue<I>, QueueError<P::Error>> {
        restore(&self.store)
            .await
            .map(|queue| queue.unwrap_or_default())
            .map_err(QueueError::Restore)
    }
    async fn save(&self, state: &Queue<I>) -> Result<(), QueueError<P::Error>> {
        match AssertUnwindSafe(async { self.store.save(state).await })
            .catch_unwind()
            .await
        {
            Ok(result) => result.map_err(QueueError::Save),
            Err(cause) => Err(QueueError::SavePanic(PanicCause::new(cause))),
        }
    }
    async fn save_changed(&self, change: QueueChange<I>) -> Result<(), QueueError<P::Error>> {
        if change.changed {
            self.save(&change.next).await?;
        }
        Ok(())
    }
    pub async fn enqueue(&self, input: Rc<I>) -> Result<Rc<QueueItem<I>>, QueueError<P::Error>> {
        let queue = self.list().await?;
        let (at, id) = self.source(|| ((self.clock)(), (self.id)()))?;
        let result = enqueue_op(&queue, input, at, id);
        self.save(&result.next).await?;
        Ok(result.item)
    }
    pub async fn claim_next(&self) -> Result<Option<Rc<QueueItem<I>>>, QueueError<P::Error>> {
        let queue = self.list().await?;
        let at = self.source(|| (self.clock)())?;
        let Some(result) = claim_next_op(&queue, at) else {
            return Ok(None);
        };
        self.save(&result.next).await?;
        Ok(Some(result.claimed))
    }
    pub async fn mark_done(&self, id: impl Into<JsText>) -> Result<(), QueueError<P::Error>> {
        let queue = self.list().await?;
        self.save_changed(mark_done_op(&queue, id)).await
    }
    pub async fn remove_item(&self, id: impl Into<JsText>) -> Result<(), QueueError<P::Error>> {
        let queue = self.list().await?;
        self.save_changed(remove_op(&queue, id)).await
    }
    pub async fn reset_running_to_pending(&self) -> Result<(), QueueError<P::Error>> {
        let queue = self.list().await?;
        self.save_changed(reset_running_op(&queue)).await
    }
    pub async fn mark_failed(
        &self,
        id: impl Into<JsText>,
        error: impl Into<JsText>,
    ) -> Result<(), QueueError<P::Error>> {
        let queue = self.list().await?;
        let error = error.into();
        let change = self.source(|| {
            patch_item_op(&queue, id, |item| {
                Rc::new(
                    item.with_status(QueueItemStatus::Failed)
                        .with_finished_at(QueueField::Value((self.clock)().into()))
                        .with_error(QueueField::Value(error)),
                )
            })
        })?;
        self.save_changed(change).await
    }
    pub async fn mark_cancelled(&self, id: impl Into<JsText>) -> Result<(), QueueError<P::Error>> {
        let queue = self.list().await?;
        let change = self.source(|| {
            patch_item_op(&queue, id, |item| {
                Rc::new(
                    item.with_status(QueueItemStatus::Cancelled)
                        .with_finished_at(QueueField::Value((self.clock)().into())),
                )
            })
        })?;
        self.save_changed(change).await
    }
    pub async fn retry_item(&self, id: impl Into<JsText>) -> Result<(), QueueError<P::Error>> {
        let queue = self.list().await?;
        self.save_changed(patch_item_op(&queue, id, |item| Rc::new(item.retried())))
            .await
    }
    pub async fn bind_output(
        &self,
        id: impl Into<JsText>,
        value: impl Into<JsText>,
    ) -> Result<(), QueueError<P::Error>> {
        let queue = self.list().await?;
        let value = value.into();
        self.save_changed(patch_item_op(&queue, id, |item| {
            Rc::new(item.with_output(QueueField::Value(value)))
        }))
        .await
    }
}
