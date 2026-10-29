//! Adapter of borrowed generic transaction bodies to worker's owned callback.
use demlik_tea::{
    data::JsText,
    durable_object::{AlarmStorage, DurableObjectStorage, TransactionError},
    storage::StoredCell,
};
use futures::{
    channel::oneshot,
    future::{Either, select},
};
use std::{future::Future, rc::Rc};
use worker::{js_sys, wasm_bindgen::JsValue, *};

#[derive(Debug)]
pub(super) enum BindingError {
    Sdk(worker::Error),
    UnsupportedNestedTransaction,
    UnsupportedKeyUtf16,
    UnsupportedCell,
    InvalidDeadline,
    HostClosed,
}
impl std::fmt::Display for BindingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sdk(error) => error.fmt(f),
            Self::UnsupportedNestedTransaction => {
                f.write_str("nested SDK transactions unsupported")
            }
            Self::UnsupportedKeyUtf16 => f.write_str("SDK adapter requires UTF-8 storage keys"),
            Self::UnsupportedCell => f.write_str("SDK adapter supports scalar cells only"),
            Self::InvalidDeadline => f.write_str("invalid absolute epoch-ms deadline"),
            Self::HostClosed => f.write_str("SDK transaction host closed before settlement"),
        }
    }
}
impl From<worker::Error> for BindingError {
    fn from(error: worker::Error) -> Self {
        Self::Sdk(error)
    }
}
pub(super) struct SdkStorage {
    pub(super) storage: Rc<worker::Storage>,
    pub(super) transaction: Option<Rc<worker::Transaction>>,
}
impl SdkStorage {
    pub(super) fn new(storage: worker::Storage) -> Self {
        Self {
            storage: Rc::new(storage),
            transaction: None,
        }
    }
}
fn key_text(key: &JsText) -> std::result::Result<&str, BindingError> {
    key.as_utf8().ok_or(BindingError::UnsupportedKeyUtf16)
}
fn from_js(value: JsValue) -> std::result::Result<StoredCell, BindingError> {
    Ok(if value.is_undefined() {
        StoredCell::Undefined
    } else if value.is_null() {
        StoredCell::Null
    } else if let Some(value) = value.as_bool() {
        StoredCell::Bool(value)
    } else if let Some(value) = value.as_f64() {
        StoredCell::Number(value)
    } else if value.is_string() {
        StoredCell::String(JsText::from_units(
            js_sys::JsString::from(value).iter().collect(),
        ))
    } else {
        return Err(BindingError::UnsupportedCell);
    })
}
fn into_js(value: StoredCell) -> std::result::Result<JsValue, BindingError> {
    Ok(match value {
        StoredCell::Undefined => JsValue::UNDEFINED,
        StoredCell::Null => JsValue::NULL,
        StoredCell::Bool(value) => JsValue::from_bool(value),
        StoredCell::Number(value) => JsValue::from_f64(value),
        StoredCell::String(value) => js_sys::JsString::from_char_code(value.as_units()).into(),
        _ => return Err(BindingError::UnsupportedCell),
    })
}
#[derive(serde::Serialize)]
struct RawValue(#[serde(serialize_with = "serde_wasm_bindgen::preserve::serialize")] JsValue);

impl DurableObjectStorage for SdkStorage {
    type Error = BindingError;
    async fn get(&self, key: JsText) -> std::result::Result<StoredCell, BindingError> {
        let key = key_text(&key)?;
        let map = match &self.transaction {
            Some(txn) => txn.get_multiple(vec![key]).await?,
            None => self.storage.get_multiple(vec![key]).await?,
        };
        from_js(map.get(&JsValue::from_str(key)))
    }
    async fn put(&self, key: JsText, value: StoredCell) -> std::result::Result<(), BindingError> {
        let key = key_text(&key)?;
        let value = into_js(value)?;
        match &self.transaction {
            Some(txn) => txn.put(key, RawValue(value)).await?,
            None => self.storage.put_raw(key, value).await?,
        }
        Ok(())
    }
    async fn delete(&self, keys: Vec<JsText>) -> std::result::Result<(), BindingError> {
        let keys = keys
            .iter()
            .map(key_text)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        match &self.transaction {
            Some(txn) => txn.delete_multiple(keys).await?,
            None => self.storage.delete_multiple(keys).await?,
        };
        Ok(())
    }
    async fn list(
        &self,
        prefix: JsText,
    ) -> std::result::Result<Vec<(JsText, StoredCell)>, BindingError> {
        let options = ListOptions::new().prefix(key_text(&prefix)?);
        let map = match &self.transaction {
            Some(txn) => txn.list_with_options(options).await?,
            None => self.storage.list_with_options(options).await?,
        };
        let mut cells = Vec::with_capacity(map.size() as usize);
        for entry in map.entries() {
            let entry = js_sys::Array::from(&entry.map_err(worker::Error::from)?);
            let key = JsText::from_units(js_sys::JsString::from(entry.get(0)).iter().collect());
            cells.push((key, from_js(entry.get(1))?));
        }
        Ok(cells)
    }
    async fn transaction<A, E, F>(
        &self,
        effect: impl FnOnce(Self) -> F,
    ) -> std::result::Result<A, TransactionError<BindingError, E>>
    where
        F: Future<Output = std::result::Result<A, E>>,
    {
        if self.transaction.is_some() {
            return Err(TransactionError::Storage(
                BindingError::UnsupportedNestedTransaction,
            ));
        }
        let (started, received) = oneshot::channel();
        let (decision, decided) = oneshot::channel();
        let (completed, completion) = oneshot::channel();
        let storage = Rc::clone(&self.storage);
        // Only owned SDK handles/channels enter the SDK's static callback. Keeping
        // its future alive also keeps worker's JS Closure alive if our caller drops.
        worker::wasm_bindgen_futures::spawn_local(async move {
            let result = storage
                .transaction(move |transaction| async move {
                    let transaction = Rc::new(transaction);
                    if started.send(Rc::clone(&transaction)).is_err()
                        || !matches!(decided.await, Ok(true))
                    {
                        transaction.rollback()?;
                    }
                    Ok(())
                })
                .await;
            if let Err(Err(error)) = completed.send(result) {
                console_error!("cancelled SDK transaction failed: {}", error);
            }
        });
        let (transaction, completion) = match select(received, completion).await {
            Either::Left((Ok(transaction), completion)) => (transaction, completion),
            Either::Left((Err(_), completion)) => {
                return Err(TransactionError::Storage(
                    settlement(completion.await)
                        .err()
                        .unwrap_or(BindingError::HostClosed),
                ));
            }
            Either::Right((result, _)) => {
                return Err(TransactionError::Storage(
                    settlement(result).err().unwrap_or(BindingError::HostClosed),
                ));
            }
        };
        // A/E and the borrowed body never leave this future. Poll SDK settlement
        // alongside the body so an early SDK rejection cannot strand the caller.
        let body = Box::pin(effect(Self {
            storage: Rc::clone(&self.storage),
            transaction: Some(transaction),
        }));
        match select(body, completion).await {
            Either::Left((result, completion)) => {
                let _ = decision.send(result.is_ok());
                settlement(completion.await).map_err(TransactionError::Storage)?;
                result.map_err(TransactionError::Body)
            }
            Either::Right((result, _)) => Err(TransactionError::Storage(
                settlement(result).err().unwrap_or(BindingError::HostClosed),
            )),
        }
    }
}
fn settlement(
    value: std::result::Result<worker::Result<()>, oneshot::Canceled>,
) -> std::result::Result<(), BindingError> {
    value
        .map_err(|_| BindingError::HostClosed)?
        .map_err(BindingError::Sdk)
}
impl AlarmStorage for SdkStorage {
    type Error = BindingError;
    async fn set_alarm(&self, at_ms: f64) -> std::result::Result<(), BindingError> {
        if !at_ms.is_finite() || !(0.0..=8.64e15).contains(&at_ms) {
            return Err(BindingError::InvalidDeadline);
        }
        self.storage
            .set_alarm(ScheduledTime::new(js_sys::Date::new(&JsValue::from_f64(
                at_ms,
            ))))
            .await?;
        console_log!("{}", serde_json::json!({"event":"set_alarm", "at":at_ms}));
        Ok(())
    }
}
