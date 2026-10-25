use super::durable_storage::MemoryStorage;
use demlik_tea::{
    PlainData,
    data::JsText,
    durable_object::{DurableObjectStorage, TransactionError},
    storage::StoredCell,
};
use std::{
    cell::{Cell, RefCell},
    future::Future,
    rc::Rc,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Get,
    Put,
    Delete,
    List,
    Transaction,
    Commit,
}
impl Operation {
    pub fn name(self) -> &'static str {
        match self {
            Self::Get => "get",
            Self::Put => "put",
            Self::Delete => "delete",
            Self::List => "list",
            Self::Transaction => "transaction",
            Self::Commit => "commit",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Before,
    After,
}
impl Stage {
    pub fn name(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
        }
    }
}
#[derive(Clone, Debug)]
pub struct StorageFailure {
    pub operation: Operation,
    pub key: Option<JsText>,
    pub stage: Stage,
    pub message: String,
    pub value: Rc<PlainData>,
}
impl std::fmt::Display for StorageFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for StorageFailure {}
pub struct Gate {
    pub name: String,
    arrivals: Cell<usize>,
    released: Cell<bool>,
    changed: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl Gate {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            arrivals: Cell::new(0),
            released: Cell::new(false),
            changed: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        }
    }
    pub async fn wait(&self, count: usize) {
        loop {
            let changed = self.changed.notified();
            if self.arrivals.get() >= count {
                return;
            }
            changed.await;
        }
    }
    async fn arrive(&self) {
        self.arrivals.set(self.arrivals.get() + 1);
        self.changed.notify_waiters();
        loop {
            let released = self.release.notified();
            if self.released.get() {
                return;
            }
            released.await;
        }
    }
    pub fn release(&self) {
        self.released.set(true);
        self.release.notify_waiters();
    }
}
#[derive(Clone)]
pub enum Behavior {
    Fail {
        message: String,
        value: Rc<PlainData>,
    },
    Hold(Rc<Gate>),
}
#[derive(Clone)]
pub struct Rule {
    pub operation: Operation,
    pub key: Option<JsText>,
    pub stage: Stage,
    pub remaining: usize,
    pub behavior: Behavior,
}
#[derive(Clone)]
pub struct ControlledStorage {
    pub inner: MemoryStorage,
    rules: Rc<RefCell<Vec<Rule>>>,
    requested: Rc<Cell<usize>>,
    requested_changed: Rc<tokio::sync::Notify>,
}
impl ControlledStorage {
    pub fn new() -> Self {
        Self::with_inner(MemoryStorage::new())
    }
    pub fn with_inner(inner: MemoryStorage) -> Self {
        Self {
            inner,
            rules: Rc::new(RefCell::new(Vec::new())),
            requested: Rc::new(Cell::new(0)),
            requested_changed: Rc::new(tokio::sync::Notify::new()),
        }
    }
    pub fn rule(&self, rule: Rule) {
        self.rules.borrow_mut().push(rule);
    }
    pub fn transaction_requests(&self) -> usize {
        self.requested.get()
    }
    pub async fn wait_for_transactions(&self, count: usize) {
        loop {
            let changed = self.requested_changed.notified();
            if self.requested.get() >= count {
                return;
            }
            changed.await;
        }
    }
    fn take(&self, operation: Operation, key: Option<&JsText>) -> Option<Rule> {
        let mut rules = self.rules.borrow_mut();
        let index = rules.iter().position(|rule| {
            rule.operation == operation
                && rule
                    .key
                    .as_ref()
                    .is_none_or(|expected| Some(expected) == key)
        })?;
        let rule = rules[index].clone();
        if rules[index].remaining == 1 {
            rules.remove(index);
        } else {
            rules[index].remaining -= 1;
        }
        Some(rule)
    }
    async fn boundary(&self, rule: &Option<Rule>, stage: Stage) -> Result<(), StorageFailure> {
        let Some(rule) = rule.as_ref().filter(|rule| rule.stage == stage) else {
            return Ok(());
        };
        let mut fields = vec![
            ("at".into(), PlainData::String(rule.operation.name().into())),
            ("stage".into(), PlainData::String(stage.name().into())),
            (
                "key".into(),
                rule.key
                    .as_ref()
                    .map_or(PlainData::Null, |key| PlainData::String(key.clone())),
            ),
        ];
        match &rule.behavior {
            Behavior::Fail { message, value } => {
                fields.extend([
                    ("op".into(), PlainData::String("fail".into())),
                    ("message".into(), PlainData::String(message.into())),
                    ("value".into(), (**value).clone()),
                ]);
                self.inner
                    .note(PlainData::Object(fields.into_iter().collect()));
                Err(StorageFailure {
                    operation: rule.operation,
                    key: rule.key.clone(),
                    stage,
                    message: message.clone(),
                    value: Rc::clone(value),
                })
            }
            Behavior::Hold(gate) => {
                fields.extend([
                    ("op".into(), PlainData::String("held".into())),
                    ("gate".into(), PlainData::String(gate.name.clone().into())),
                ]);
                self.inner
                    .note(PlainData::Object(fields.iter().cloned().collect()));
                gate.arrive().await;
                fields
                    .iter_mut()
                    .find(|(key, _)| key.as_utf8() == Some("op"))
                    .unwrap()
                    .1 = PlainData::String("released".into());
                self.inner
                    .note(PlainData::Object(fields.into_iter().collect()));
                Ok(())
            }
        }
    }
}
impl DurableObjectStorage for ControlledStorage {
    type Error = StorageFailure;
    fn get(&self, key: JsText) -> impl Future<Output = Result<StoredCell, Self::Error>> {
        let rule = self.take(Operation::Get, Some(&key));
        async move {
            self.boundary(&rule, Stage::Before).await?;
            let value = self.inner.get(key).await.unwrap();
            // The paired TS adapter suspends at `await base.get(key)` even for a ready read.
            tokio::task::yield_now().await;
            self.boundary(&rule, Stage::After).await?;
            Ok(value)
        }
    }
    fn put(&self, key: JsText, value: StoredCell) -> impl Future<Output = Result<(), Self::Error>> {
        let rule = self.take(Operation::Put, Some(&key));
        async move {
            self.boundary(&rule, Stage::Before).await?;
            self.inner.put(key, value).await.unwrap();
            self.boundary(&rule, Stage::After).await
        }
    }
    fn delete(&self, keys: Vec<JsText>) -> impl Future<Output = Result<(), Self::Error>> {
        let rule = self.take(Operation::Delete, None);
        async move {
            self.boundary(&rule, Stage::Before).await?;
            self.inner.delete(keys).await.unwrap();
            self.boundary(&rule, Stage::After).await
        }
    }
    fn list(
        &self,
        prefix: JsText,
    ) -> impl Future<Output = Result<Vec<(JsText, StoredCell)>, Self::Error>> {
        let rule = self.take(Operation::List, Some(&prefix));
        async move {
            self.boundary(&rule, Stage::Before).await?;
            let value = self.inner.list(prefix).await.unwrap();
            self.boundary(&rule, Stage::After).await?;
            Ok(value)
        }
    }
    fn transaction<A, E, F>(
        &self,
        effect: impl FnOnce(Self) -> F,
    ) -> impl Future<Output = Result<A, TransactionError<Self::Error, E>>>
    where
        F: Future<Output = Result<A, E>>,
    {
        enum Abort<E> {
            Body(E),
            Storage(StorageFailure),
        }
        let rule = self.take(Operation::Transaction, None);
        self.requested.set(self.requested.get() + 1);
        self.requested_changed.notify_waiters();
        self.inner.note(PlainData::Object(
            [(
                "op".into(),
                PlainData::String("transactionRequested".into()),
            )]
            .into_iter()
            .collect(),
        ));
        async move {
            self.boundary(&rule, Stage::Before)
                .await
                .map_err(TransactionError::Storage)?;
            let result = self
                .inner
                .transaction(|inner| async move {
                    let transaction = Self {
                        inner,
                        ..self.clone()
                    };
                    let value = effect(transaction).await.map_err(Abort::Body)?;
                    let commit = self.take(Operation::Commit, None);
                    self.boundary(&commit, Stage::Before)
                        .await
                        .map_err(Abort::Storage)?;
                    Ok::<_, Abort<E>>((value, commit))
                })
                .await;
            let (value, commit) = match result {
                Ok(result) => result,
                Err(TransactionError::Storage(value)) => match value {},
                Err(TransactionError::Body(Abort::Body(error))) => {
                    return Err(TransactionError::Body(error));
                }
                Err(TransactionError::Body(Abort::Storage(error))) => {
                    return Err(TransactionError::Storage(error));
                }
            };
            self.boundary(&commit, Stage::After)
                .await
                .map_err(TransactionError::Storage)?;
            self.boundary(&rule, Stage::After)
                .await
                .map_err(TransactionError::Storage)?;
            Ok(value)
        }
    }
}
