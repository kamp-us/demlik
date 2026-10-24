use futures::{FutureExt, future::LocalBoxFuture};
use serde::Serialize;
use std::{future::Future, rc::Rc};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    pub seq: f64,
    pub msg_type: String,
    pub at: f64,
}
pub struct Telemetry<E> {
    sink: Rc<dyn Fn(TelemetryEvent) -> LocalBoxFuture<'static, Result<(), E>>>,
}
impl<E: 'static> Telemetry<E> {
    pub fn new<F, G>(sink: F) -> Self
    where
        F: Fn(TelemetryEvent) -> G + 'static,
        G: Future<Output = Result<(), E>> + 'static,
    {
        Self {
            sink: Rc::new(move |event| sink(event).boxed_local()),
        }
    }
    pub fn sync(sink: impl Fn(TelemetryEvent) -> Result<(), E> + 'static) -> Self {
        Self {
            sink: Rc::new(move |event| futures::future::ready(sink(event)).boxed_local()),
        }
    }
    pub(crate) fn start(&self, event: TelemetryEvent) -> LocalBoxFuture<'static, Result<(), E>> {
        (self.sink)(event)
    }
}
