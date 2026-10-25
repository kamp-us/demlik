//! Ordered journals with instance-local changes and call-chain reentrant locks.
//!
//! Owned operations submit work to the current Tokio `LocalSet` immediately;
//! dropping a receipt does not cancel it. The host must remain alive until its
//! submitted work settles. Entry and backend types impose no record codec,
//! Clone, Send, or static lifetime requirement.

use crate::runtime::listeners::Listeners;
use crate::{PlainData, data::JsText};
use std::{cell::RefCell, convert::Infallible, future::Future, rc::Rc};
pub mod remote;
pub(crate) mod task;
pub use task::{JournalError, JournalTask};
#[cfg(not(target_arch = "wasm32"))]
mod file;
#[cfg(not(target_arch = "wasm32"))]
pub use file::{FileBackend, FileJournalError, file_journal};
use tokio::sync::oneshot;

type StreamTails = RefCell<indexmap::IndexMap<JsText, oneshot::Receiver<()>>>;
#[derive(Clone)]
struct HeldStream {
    owner: Rc<StreamTails>,
    stream: JsText,
}
type Held = Vec<HeldStream>;
tokio::task_local! { static HELD: Held; }

#[derive(Clone, Debug, serde::Serialize)]
#[serde(transparent)]
/// Normal appends assign numbers. Existing file metadata is retained verbatim,
/// including missing, null, or nonnumeric values, when rows are rewritten.
pub struct Seq(PlainData);
impl Seq {
    pub fn number(&self) -> Option<f64> {
        match self.0 {
            PlainData::Number(value) => Some(value),
            _ => None,
        }
    }
    pub fn raw(&self) -> &PlainData {
        &self.0
    }
}
impl From<f64> for Seq {
    fn from(value: f64) -> Self {
        Self(PlainData::Number(value))
    }
}
impl PartialEq<f64> for Seq {
    fn eq(&self, other: &f64) -> bool {
        self.number() == Some(*other)
    }
}

pub struct JournalEntry<R> {
    pub stream: JsText,
    pub seq: Seq,
    pub record: Rc<R>,
}
pub type ChangeListener<R> = dyn Fn(&JournalEntry<R>);
#[derive(Debug)]
pub struct Appended {
    pub seq: Seq,
}
pub trait JournalBackend<R> {
    type Error;
    fn read(
        &self,
        stream: JsText,
    ) -> impl Future<Output = Result<Vec<Rc<JournalEntry<R>>>, Self::Error>>;
    fn append(
        &self,
        stream: JsText,
        record: Rc<R>,
    ) -> impl Future<Output = Result<Rc<JournalEntry<R>>, Self::Error>>;
    fn lock<T>(
        &self,
        stream: JsText,
        effect: impl Future<Output = T>,
    ) -> impl Future<Output = Result<T, Self::Error>>;
}

pub struct Journal<R, B> {
    backend: Rc<B>,
    listeners: Rc<Listeners<ChangeListener<R>>>,
    tails: Rc<StreamTails>,
}
impl<R, B> Clone for Journal<R, B> {
    fn clone(&self) -> Self {
        Self {
            backend: Rc::clone(&self.backend),
            listeners: Rc::clone(&self.listeners),
            tails: Rc::clone(&self.tails),
        }
    }
}
pub fn make_journal<R, B: JournalBackend<R>>(backend: B) -> Journal<R, B> {
    Journal {
        backend: Rc::new(backend),
        listeners: Listeners::new(),
        tails: Rc::new(RefCell::new(indexmap::IndexMap::new())),
    }
}
impl<R: 'static, B: JournalBackend<R> + 'static> Journal<R, B> {
    fn exclusive<T: 'static, F: 'static, P>(
        &self,
        stream: JsText,
        effect: impl FnOnce(Rc<B>) -> P + 'static,
    ) -> JournalTask<T, B::Error, F>
    where
        P: Future<Output = Result<T, JournalError<B::Error, F>>> + 'static,
    {
        let held = HELD.try_with(Clone::clone).unwrap_or_default();
        let reentrant = held
            .iter()
            .any(|held| Rc::ptr_eq(&held.owner, &self.tails) && held.stream == stream);
        let reservation = if reentrant {
            None
        } else {
            let (release, tail) = oneshot::channel();
            let previous = self.tails.borrow_mut().insert(stream.clone(), tail);
            Some((previous, release))
        };
        let mut nested = held.clone();
        if !reentrant {
            nested.push(HeldStream {
                owner: Rc::clone(&self.tails),
                stream: stream.clone(),
            });
        }
        let backend = Rc::clone(&self.backend);
        task::start(
            HELD.scope(held, async move {
                let release = if let Some((previous, release)) = reservation {
                    if let Some(previous) = previous {
                        let _ = previous.await;
                    }
                    Some(release)
                } else {
                    None
                };
                let _release = release;
                let body_backend = Rc::clone(&backend);
                let body = async move { effect(body_backend).await };
                if reentrant {
                    body.await
                } else {
                    backend
                        .lock(stream, HELD.scope(nested, body))
                        .await
                        .map_err(JournalError::Backend)?
                }
            }),
            reentrant,
        )
    }
    pub fn append(
        &self,
        stream: impl Into<JsText>,
        record: Rc<R>,
    ) -> JournalTask<Appended, B::Error> {
        let stream = stream.into();
        let listeners = Rc::clone(&self.listeners);
        self.exclusive(stream.clone(), move |backend| async move {
            let entry = backend
                .append(stream, record)
                .await
                .map_err(JournalError::Backend)?;
            tokio::task::yield_now().await;
            listeners.for_each(|listener| listener(&entry));
            Ok(Appended {
                seq: entry.seq.clone(),
            })
        })
    }
    pub fn list(
        &self,
        stream: impl Into<JsText>,
    ) -> JournalTask<Vec<Rc<JournalEntry<R>>>, B::Error> {
        let stream = stream.into();
        let backend = Rc::clone(&self.backend);
        let held = HELD.try_with(Clone::clone).unwrap_or_default();
        task::start(
            HELD.scope(held, async move {
                backend.read(stream).await.map_err(JournalError::Backend)
            }),
            true,
        )
    }
    pub fn changes(&self, listener: Rc<ChangeListener<R>>) -> crate::runtime::Unsubscribe {
        self.listeners.add(listener)
    }
    pub fn with_lock<A: 'static, F: 'static, P>(
        &self,
        stream: impl Into<JsText>,
        effect: impl FnOnce() -> P + 'static,
    ) -> JournalTask<A, B::Error, F>
    where
        P: Future<Output = Result<A, F>> + 'static,
    {
        let stream = stream.into();
        self.exclusive(stream, move |_| async move {
            effect().await.map_err(JournalError::Effect)
        })
    }
}

pub struct MemoryBackend<R> {
    streams: RefCell<indexmap::IndexMap<JsText, Vec<Rc<JournalEntry<R>>>>>,
}
impl<R> Default for MemoryBackend<R> {
    fn default() -> Self {
        Self {
            streams: RefCell::new(indexmap::IndexMap::new()),
        }
    }
}
impl<R> JournalBackend<R> for MemoryBackend<R> {
    type Error = Infallible;
    async fn read(&self, stream: JsText) -> Result<Vec<Rc<JournalEntry<R>>>, Infallible> {
        Ok(self
            .streams
            .borrow()
            .get(&stream)
            .cloned()
            .unwrap_or_default())
    }
    async fn append(
        &self,
        stream: JsText,
        record: Rc<R>,
    ) -> Result<Rc<JournalEntry<R>>, Infallible> {
        let mut streams = self.streams.borrow_mut();
        let log = streams.entry(stream.clone()).or_default();
        let entry = Rc::new(JournalEntry {
            stream,
            seq: ((log.len() + 1) as f64).into(),
            record,
        });
        log.push(Rc::clone(&entry));
        Ok(entry)
    }
    async fn lock<T>(
        &self,
        _stream: JsText,
        effect: impl Future<Output = T>,
    ) -> Result<T, Infallible> {
        Ok(effect.await)
    }
}
pub fn memory_journal<R>() -> Journal<R, MemoryBackend<R>> {
    make_journal(MemoryBackend::default())
}
