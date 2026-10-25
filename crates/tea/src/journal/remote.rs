use super::{
    Appended, HELD, Journal, JournalBackend, JournalEntry, JournalError, MemoryBackend,
    memory_journal, task,
};
use crate::{PlainData, data::JsText};
use futures::future::LocalBoxFuture;
use std::{
    cell::RefCell, collections::BTreeMap, convert::Infallible, fmt, future::Future,
    marker::PhantomData, rc::Rc,
};

pub type RemoteSeq = f64;
pub type LocalWork<T, E> = LocalBoxFuture<'static, Result<T, E>>;
pub type MemoryError = JournalError<Infallible>;
pub struct AuthoredRecord<R> {
    pub author: JsText,
    pub record: Rc<R>,
}
pub struct RemoteEntry<R> {
    pub stream: JsText,
    pub seq: RemoteSeq,
    pub author: JsText,
    pub record: Rc<R>,
}
pub struct PushRequest<R, T = PlainData> {
    pub token: Option<Rc<T>>,
    pub stream: JsText,
    pub records: Vec<Rc<AuthoredRecord<R>>>,
}
pub struct PushResult {
    pub seqs: Vec<RemoteSeq>,
}
pub struct PullRequest<T = PlainData> {
    pub token: Option<Rc<T>>,
    pub stream: JsText,
    pub since: RemoteSeq,
}
pub struct PullResult<R> {
    pub entries: Vec<Rc<RemoteEntry<R>>>,
}

pub trait RemoteJournal<R, T = PlainData> {
    type Error;
    fn push(&self, request: PushRequest<R, T>) -> LocalWork<PushResult, Self::Error>;
    fn pull(&self, request: PullRequest<T>) -> LocalWork<PullResult<R>, Self::Error>;
}
pub trait CursorStore {
    type Error;
    fn get(&self, stream: JsText) -> LocalWork<RemoteSeq, Self::Error>;
    fn set(&self, stream: JsText, seq: RemoteSeq) -> LocalWork<(), Self::Error>;
}
pub trait LocalJournal<R> {
    type Error;
    fn append(&self, stream: JsText, record: Rc<R>) -> LocalWork<Appended, Self::Error>;
    fn list(&self, stream: JsText) -> LocalWork<Vec<Rc<JournalEntry<R>>>, Self::Error>;
}
impl<R: 'static, B: JournalBackend<R> + 'static> LocalJournal<R> for Journal<R, B> {
    type Error = JournalError<B::Error>;
    fn append(&self, stream: JsText, record: Rc<R>) -> LocalWork<Appended, Self::Error> {
        Box::pin(Journal::append(self, stream, record))
    }
    fn list(&self, stream: JsText) -> LocalWork<Vec<Rc<JournalEntry<R>>>, Self::Error> {
        Box::pin(Journal::list(self, stream))
    }
}
fn owned<A: 'static, E: 'static>(
    effect: impl Future<Output = Result<A, JournalError<E>>> + 'static,
) -> LocalWork<A, JournalError<E>> {
    let held = HELD.try_with(Clone::clone).unwrap_or_default();
    Box::pin(task::start(HELD.scope(held, effect), true))
}
fn batch_error(error: JournalError<Infallible, MemoryError>) -> MemoryError {
    match error {
        JournalError::Backend(value) => match value {},
        JournalError::Effect(error) => error,
        JournalError::Panic(cause) => JournalError::Panic(cause),
        JournalError::HostClosed => JournalError::HostClosed,
    }
}
pub struct MemoryRemote<R> {
    journal: Journal<AuthoredRecord<R>, MemoryBackend<AuthoredRecord<R>>>,
}
impl<R> Clone for MemoryRemote<R> {
    fn clone(&self) -> Self {
        Self {
            journal: self.journal.clone(),
        }
    }
}
pub fn memory_remote_journal<R>() -> MemoryRemote<R> {
    MemoryRemote {
        journal: memory_journal(),
    }
}
impl<R: 'static, T> RemoteJournal<R, T> for MemoryRemote<R> {
    type Error = MemoryError;
    fn push(&self, request: PushRequest<R, T>) -> LocalWork<PushResult, Self::Error> {
        let PushRequest {
            stream, records, ..
        } = request;
        let journal = self.journal.clone();
        owned(async move {
            let writer = journal.clone();
            journal
                .with_lock(stream.clone(), move || async move {
                    let mut seqs = Vec::new();
                    for record in records {
                        let appended = writer.append(stream.clone(), record).await?;
                        seqs.push(
                            appended
                                .seq
                                .number()
                                .expect("memory journal assigns numeric sequences"),
                        );
                    }
                    Ok::<_, MemoryError>(PushResult { seqs })
                })
                .await
                .map_err(batch_error)
        })
    }
    fn pull(&self, request: PullRequest<T>) -> LocalWork<PullResult<R>, Self::Error> {
        let PullRequest { stream, since, .. } = request;
        let journal = self.journal.clone();
        owned(async move {
            let entries = journal.list(stream).await?;
            Ok(PullResult {
                entries: entries
                    .into_iter()
                    .filter_map(|entry| {
                        let seq = entry
                            .seq
                            .number()
                            .expect("memory journal assigns numeric sequences");
                        (seq > since).then(|| {
                            Rc::new(RemoteEntry {
                                stream: entry.stream.clone(),
                                seq,
                                author: entry.record.author.clone(),
                                record: Rc::clone(&entry.record.record),
                            })
                        })
                    })
                    .collect(),
            })
        })
    }
}
#[derive(Clone)]
pub struct MemoryCursorStore {
    cursors: Rc<RefCell<BTreeMap<JsText, RemoteSeq>>>,
}
pub fn memory_cursor_store() -> MemoryCursorStore {
    MemoryCursorStore {
        cursors: Rc::new(RefCell::new(BTreeMap::new())),
    }
}
impl CursorStore for MemoryCursorStore {
    type Error = MemoryError;
    fn get(&self, stream: JsText) -> LocalWork<RemoteSeq, Self::Error> {
        let cursors = Rc::clone(&self.cursors);
        owned(async move { Ok(cursors.borrow().get(&stream).copied().unwrap_or(0.0)) })
    }
    fn set(&self, stream: JsText, seq: RemoteSeq) -> LocalWork<(), Self::Error> {
        let cursors = Rc::clone(&self.cursors);
        owned(async move {
            cursors.borrow_mut().insert(stream, seq);
            Ok(())
        })
    }
}

pub struct SyncClientOptions<
    R,
    H,
    T = PlainData,
    L = Journal<R, MemoryBackend<R>>,
    C = MemoryCursorStore,
> {
    pub remote: Rc<H>,
    pub author: JsText,
    pub token: Option<Rc<T>>,
    pub local: Rc<L>,
    pub cursors: Rc<C>,
    record: PhantomData<fn() -> R>,
}
impl<R, H> SyncClientOptions<R, H> {
    pub fn new(remote: Rc<H>, author: impl Into<JsText>) -> Self {
        Self {
            remote,
            author: author.into(),
            token: None,
            local: Rc::new(memory_journal()),
            cursors: Rc::new(memory_cursor_store()),
            record: PhantomData,
        }
    }
}
impl<R, H, T, L, C> SyncClientOptions<R, H, T, L, C> {
    pub fn with_token<N>(self, token: Rc<N>) -> SyncClientOptions<R, H, N, L, C> {
        SyncClientOptions {
            remote: self.remote,
            author: self.author,
            token: Some(token),
            local: self.local,
            cursors: self.cursors,
            record: PhantomData,
        }
    }
    pub fn with_local<N>(self, local: Rc<N>) -> SyncClientOptions<R, H, T, N, C> {
        SyncClientOptions {
            remote: self.remote,
            author: self.author,
            token: self.token,
            local,
            cursors: self.cursors,
            record: PhantomData,
        }
    }
    pub fn with_cursors<N>(self, cursors: Rc<N>) -> SyncClientOptions<R, H, T, L, N> {
        SyncClientOptions {
            remote: self.remote,
            author: self.author,
            token: self.token,
            local: self.local,
            cursors,
            record: PhantomData,
        }
    }
}
#[derive(Debug)]
pub enum SyncFailure<L, R, C> {
    Local(L),
    Push(R),
    CursorGet(C),
    Pull(R),
    CursorSet(C),
}
impl<L: fmt::Display, R: fmt::Display, C: fmt::Display> fmt::Display for SyncFailure<L, R, C> {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Local(error) => error.fmt(output),
            Self::Push(error) | Self::Pull(error) => error.fmt(output),
            Self::CursorGet(error) | Self::CursorSet(error) => error.fmt(output),
        }
    }
}
pub type ClientError<R, H, T, L, C> = JournalError<
    SyncFailure<
        <L as LocalJournal<R>>::Error,
        <H as RemoteJournal<R, T>>::Error,
        <C as CursorStore>::Error,
    >,
>;
pub type ClientWork<A, R, H, T, L, C> = LocalWork<A, ClientError<R, H, T, L, C>>;
struct ClientState<R, H, T, L, C> {
    options: SyncClientOptions<R, H, T, L, C>,
    pushed: RefCell<BTreeMap<JsText, usize>>,
    converged: RefCell<BTreeMap<JsText, Vec<Rc<RemoteEntry<R>>>>>,
}
pub struct SyncClient<R, H, T = PlainData, L = Journal<R, MemoryBackend<R>>, C = MemoryCursorStore>
{
    state: Rc<ClientState<R, H, T, L, C>>,
}
impl<R, H, T, L, C> Clone for SyncClient<R, H, T, L, C> {
    fn clone(&self) -> Self {
        Self {
            state: Rc::clone(&self.state),
        }
    }
}
pub fn make_sync_client<R, H, T, L, C>(
    options: SyncClientOptions<R, H, T, L, C>,
) -> SyncClient<R, H, T, L, C> {
    SyncClient {
        state: Rc::new(ClientState {
            options,
            pushed: RefCell::new(BTreeMap::new()),
            converged: RefCell::new(BTreeMap::new()),
        }),
    }
}
impl<R, H, T, L, C> SyncClient<R, H, T, L, C> {
    pub fn log(&self, stream: impl Into<JsText>) -> Vec<Rc<RemoteEntry<R>>> {
        self.state
            .converged
            .borrow()
            .get(&stream.into())
            .cloned()
            .unwrap_or_default()
    }
}
impl<
    R: 'static,
    H: RemoteJournal<R, T> + 'static,
    T: 'static,
    L: LocalJournal<R> + 'static,
    C: CursorStore + 'static,
> SyncClient<R, H, T, L, C>
{
    fn unpushed(&self, stream: JsText) -> ClientWork<Vec<Rc<JournalEntry<R>>>, R, H, T, L, C> {
        let state = Rc::clone(&self.state);
        owned(async move {
            let entries = state
                .options
                .local
                .list(stream.clone())
                .await
                .map_err(|error| JournalError::Backend(SyncFailure::Local(error)))?;
            let pushed = state.pushed.borrow().get(&stream).copied().unwrap_or(0);
            Ok(entries.into_iter().skip(pushed).collect())
        })
    }
    pub fn append(
        &self,
        stream: impl Into<JsText>,
        record: Rc<R>,
    ) -> LocalWork<(), ClientError<R, H, T, L, C>> {
        let state = Rc::clone(&self.state);
        let stream = stream.into();
        owned(async move {
            state
                .options
                .local
                .append(stream, record)
                .await
                .map_err(|error| JournalError::Backend(SyncFailure::Local(error)))?;
            Ok(())
        })
    }
    pub fn pending(
        &self,
        stream: impl Into<JsText>,
    ) -> ClientWork<Vec<Rc<AuthoredRecord<R>>>, R, H, T, L, C> {
        let tail = self.unpushed(stream.into());
        let state = Rc::clone(&self.state);
        owned(async move {
            Ok(tail
                .await?
                .into_iter()
                .map(|entry| {
                    Rc::new(AuthoredRecord {
                        author: state.options.author.clone(),
                        record: Rc::clone(&entry.record),
                    })
                })
                .collect())
        })
    }
    pub fn sync(&self, stream: impl Into<JsText>) -> LocalWork<(), ClientError<R, H, T, L, C>> {
        let stream = stream.into();
        let tail = self.unpushed(stream.clone());
        let state = Rc::clone(&self.state);
        owned(async move {
            let tail = tail.await?;
            if !tail.is_empty() {
                let records = tail
                    .iter()
                    .map(|entry| {
                        Rc::new(AuthoredRecord {
                            author: state.options.author.clone(),
                            record: Rc::clone(&entry.record),
                        })
                    })
                    .collect();
                state
                    .options
                    .remote
                    .push(PushRequest {
                        token: state.options.token.clone(),
                        stream: stream.clone(),
                        records,
                    })
                    .await
                    .map_err(|error| JournalError::Backend(SyncFailure::Push(error)))?;
                let mut pushed = state.pushed.borrow_mut();
                *pushed.entry(stream.clone()).or_default() += tail.len();
            }
            let since = state
                .options
                .cursors
                .get(stream.clone())
                .await
                .map_err(|error| JournalError::Backend(SyncFailure::CursorGet(error)))?;
            let entries = state
                .options
                .remote
                .pull(PullRequest {
                    token: state.options.token.clone(),
                    stream: stream.clone(),
                    since,
                })
                .await
                .map_err(|error| JournalError::Backend(SyncFailure::Pull(error)))?
                .entries;
            if let Some(last) = entries.last() {
                let seq = last.seq;
                state
                    .converged
                    .borrow_mut()
                    .entry(stream.clone())
                    .or_default()
                    .extend(entries);
                state
                    .options
                    .cursors
                    .set(stream, seq)
                    .await
                    .map_err(|error| JournalError::Backend(SyncFailure::CursorSet(error)))?;
            }
            Ok(())
        })
    }
}
