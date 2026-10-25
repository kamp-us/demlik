use demlik_tea::{
    PlainData,
    data::JsText,
    durable_object::{DurableObjectStorage, TransactionError},
    storage::StoredCell,
};
use std::{cell::RefCell, collections::BTreeMap, convert::Infallible, future::Future, rc::Rc};

#[derive(Clone)]
pub enum Call {
    Get(JsText),
    Put(JsText, PlainData),
    Delete(Vec<JsText>),
    List(JsText),
    Begin,
    Commit,
    Rollback,
    Control(PlainData),
}
impl std::fmt::Debug for Call {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Get(key) => output.debug_tuple("Get").field(key).finish(),
            Self::Put(key, value) => output.debug_tuple("Put").field(key).field(value).finish(),
            Self::Delete(keys) => output.debug_tuple("Delete").field(keys).finish(),
            Self::List(prefix) => output.debug_tuple("List").field(prefix).finish(),
            Self::Begin => output.write_str("Begin"),
            Self::Commit => output.write_str("Commit"),
            Self::Rollback => output.write_str("Rollback"),
            Self::Control(value) => output.debug_tuple("Control").field(value).finish(),
        }
    }
}
#[derive(Clone)]
pub struct MemoryStorage {
    cells: Rc<RefCell<BTreeMap<JsText, StoredCell>>>,
    staged: Option<StagedWrites>,
    clone_reads: bool,
    lock: Rc<tokio::sync::Mutex<()>>,
    changed: Rc<tokio::sync::Notify>,
    pub calls: Rc<RefCell<Vec<Call>>>,
}
type StagedWrites = Rc<RefCell<BTreeMap<JsText, Option<StoredCell>>>>;
impl MemoryStorage {
    pub fn new() -> Self {
        Self::with_cloned_reads(false)
    }
    pub fn with_cloned_reads(clone_reads: bool) -> Self {
        Self {
            cells: Rc::new(RefCell::new(BTreeMap::new())),
            staged: None,
            clone_reads,
            lock: Rc::new(tokio::sync::Mutex::new(())),
            changed: Rc::new(tokio::sync::Notify::new()),
            calls: Rc::new(RefCell::new(Vec::new())),
        }
    }
    pub fn cells(&self) -> BTreeMap<JsText, PlainData> {
        self.cells
            .borrow()
            .iter()
            .map(|(key, value)| (key.clone(), value.snapshot()))
            .collect()
    }
    pub fn note(&self, value: PlainData) {
        self.calls.borrow_mut().push(Call::Control(value));
        self.changed.notify_waiters();
    }
    pub fn seed(&self, key: impl Into<JsText>, value: impl Into<StoredCell>) {
        self.cells.borrow_mut().insert(key.into(), value.into());
        self.changed.notify_waiters();
    }
    pub async fn wait_for_cell(&self, key: impl Into<JsText>, accept: impl Fn(&PlainData) -> bool) {
        let key = key.into();
        loop {
            let changed = self.changed.notified();
            if accept(&self.cell(&key).snapshot()) {
                return;
            }
            changed.await;
        }
    }
    pub fn cell(&self, key: &JsText) -> StoredCell {
        if let Some(staged) = &self.staged
            && let Some(value) = staged.borrow().get(key)
        {
            return value.clone().unwrap_or(StoredCell::Undefined);
        }
        self.cells
            .borrow()
            .get(key)
            .cloned()
            .unwrap_or(StoredCell::Undefined)
    }
}
impl DurableObjectStorage for MemoryStorage {
    type Error = Infallible;
    fn get(&self, key: JsText) -> impl Future<Output = Result<StoredCell, Self::Error>> {
        self.calls.borrow_mut().push(Call::Get(key.clone()));
        let value = self.cell(&key);
        let value = if self.clone_reads {
            StoredCell::from(value.snapshot())
        } else {
            value
        };
        async move { Ok(value) }
    }
    fn put(&self, key: JsText, value: StoredCell) -> impl Future<Output = Result<(), Self::Error>> {
        self.calls
            .borrow_mut()
            .push(Call::Put(key.clone(), value.snapshot()));
        if let Some(staged) = &self.staged {
            staged.borrow_mut().insert(key, Some(value));
        } else {
            self.cells.borrow_mut().insert(key, value);
            self.changed.notify_waiters();
        }
        async { Ok(()) }
    }
    fn delete(&self, keys: Vec<JsText>) -> impl Future<Output = Result<(), Self::Error>> {
        self.calls.borrow_mut().push(Call::Delete(keys.clone()));
        for key in keys {
            if let Some(staged) = &self.staged {
                staged.borrow_mut().insert(key, None);
            } else {
                self.cells.borrow_mut().remove(&key);
            }
        }
        async { Ok(()) }
    }
    fn list(
        &self,
        prefix: JsText,
    ) -> impl Future<Output = Result<Vec<(JsText, StoredCell)>, Self::Error>> {
        self.calls.borrow_mut().push(Call::List(prefix.clone()));
        let values = self
            .cells
            .borrow()
            .iter()
            .filter(|(key, _)| key.as_units().starts_with(prefix.as_units()))
            .map(|(key, value)| {
                (
                    key.clone(),
                    if self.clone_reads {
                        StoredCell::from(value.snapshot())
                    } else {
                        value.clone()
                    },
                )
            })
            .collect();
        async move { Ok(values) }
    }
    async fn transaction<A, E, F>(
        &self,
        effect: impl FnOnce(Self) -> F,
    ) -> Result<A, TransactionError<Self::Error, E>>
    where
        F: Future<Output = Result<A, E>>,
    {
        let _lock = self.lock.lock().await;
        self.calls.borrow_mut().push(Call::Begin);
        let staged = Rc::new(RefCell::new(BTreeMap::new()));
        let transaction = Self {
            staged: Some(Rc::clone(&staged)),
            ..self.clone()
        };
        match effect(transaction).await {
            Ok(result) => {
                for (key, value) in std::mem::take(&mut *staged.borrow_mut()) {
                    if let Some(value) = value {
                        self.cells.borrow_mut().insert(key, value);
                    } else {
                        self.cells.borrow_mut().remove(&key);
                    }
                }
                self.calls.borrow_mut().push(Call::Commit);
                self.changed.notify_waiters();
                Ok(result)
            }
            Err(error) => {
                self.calls.borrow_mut().push(Call::Rollback);
                Err(TransactionError::Body(error))
            }
        }
    }
}
