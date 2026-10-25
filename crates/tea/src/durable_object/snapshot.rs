use super::{
    DoStoreError, DurableObjectStorage, TransactionError, encoded_json, stored_json, version,
};
use crate::{
    PlainData,
    data::{DependencyError, JsText, plain_data},
    storage::{DeletableStore, FencedRead, Fencing, Migrated, Store, StoreConflictError},
};
use futures::{FutureExt, future::LocalBoxFuture};
use std::{marker::PhantomData, rc::Rc};

#[derive(Default)]
pub struct DoStoreOptions {
    pub key: Option<JsText>,
}
pub struct DoStore<S, P, D, F> {
    storage: Rc<P>,
    parse: Rc<D>,
    serialize: Rc<F>,
    key: JsText,
    version_key: JsText,
    state: PhantomData<fn() -> S>,
}
impl<S, P, D, F> Clone for DoStore<S, P, D, F> {
    fn clone(&self) -> Self {
        Self {
            storage: Rc::clone(&self.storage),
            parse: Rc::clone(&self.parse),
            serialize: Rc::clone(&self.serialize),
            key: self.key.clone(),
            version_key: self.version_key.clone(),
            state: PhantomData,
        }
    }
}
pub fn do_store<S: serde::Serialize, P, D>(
    storage: Rc<P>,
    parse: D,
    options: DoStoreOptions,
) -> DoStore<S, P, D, impl Fn(&S) -> Result<PlainData, DependencyError>> {
    do_store_with(storage, parse, plain_data::<S>, options)
}
pub fn do_store_with<S, P, D, F>(
    storage: Rc<P>,
    parse: D,
    serialize: F,
    options: DoStoreOptions,
) -> DoStore<S, P, D, F> {
    let key = options.key.unwrap_or_else(|| "@@state".into());
    let mut units = key.as_units().to_vec();
    units.extend("@@version".encode_utf16());
    DoStore {
        storage,
        parse: Rc::new(parse),
        serialize: Rc::new(serialize),
        key,
        version_key: JsText::from_units(units),
        state: PhantomData,
    }
}
impl<S, P, D, F> DoStore<S, P, D, F> {
    pub fn fenced(self) -> FencedDoStore<S, P, D, F> {
        FencedDoStore(self)
    }
}
impl<S, P, D, F, C> Store<S> for DoStore<S, P, D, F>
where
    P: DurableObjectStorage,
    D: Fn(PlainData) -> Migrated<S>,
    F: Fn(&S) -> Result<PlainData, C>,
{
    type Raw = PlainData;
    type Error = DoStoreError<P::Error, C>;
    async fn load(&self) -> Result<PlainData, Self::Error> {
        let raw =
            self.storage
                .get(self.key.clone())
                .await
                .map_err(|cause| DoStoreError::Storage {
                    operation: "get",
                    cause,
                })?;
        if matches!(raw, PlainData::Null | PlainData::Undefined) {
            return Ok(PlainData::Null);
        }
        stored_json(raw)
    }
    async fn save(&self, state: &S) -> Result<(), Self::Error> {
        let value = (self.serialize)(state).map_err(DoStoreError::Encode)?;
        self.storage
            .put(self.key.clone(), encoded_json(value))
            .await
            .map_err(|cause| DoStoreError::Storage {
                operation: "put",
                cause,
            })
    }
    fn migrate(&self, raw: PlainData) -> Migrated<S> {
        (self.parse)(raw)
    }
}
impl<S, P, D, F, C> DeletableStore<S> for DoStore<S, P, D, F>
where
    P: DurableObjectStorage,
    D: Fn(PlainData) -> Migrated<S>,
    F: Fn(&S) -> Result<PlainData, C>,
{
    async fn delete(&self) -> Result<(), Self::Error> {
        self.storage
            .delete(vec![self.key.clone(), self.version_key.clone()])
            .await
            .map_err(|cause| DoStoreError::Storage {
                operation: "delete",
                cause,
            })
    }
}
pub struct FencedDoStore<S, P, D, F>(DoStore<S, P, D, F>);
impl<S, P, D, F> Clone for FencedDoStore<S, P, D, F> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<S, P, D, F, C> Store<S> for FencedDoStore<S, P, D, F>
where
    P: DurableObjectStorage,
    D: Fn(PlainData) -> Migrated<S>,
    F: Fn(&S) -> Result<PlainData, C>,
{
    type Raw = PlainData;
    type Error = DoStoreError<P::Error, C>;
    async fn load(&self) -> Result<PlainData, Self::Error> {
        self.0.load().await
    }
    async fn save(&self, state: &S) -> Result<(), Self::Error> {
        self.0.save(state).await
    }
    fn migrate(&self, raw: PlainData) -> Migrated<S> {
        self.0.migrate(raw)
    }
    fn fencing(&self) -> Option<&dyn Fencing<S, Raw = PlainData, Error = Self::Error>> {
        Some(self)
    }
}
impl<S, P, D, F, C> DeletableStore<S> for FencedDoStore<S, P, D, F>
where
    P: DurableObjectStorage,
    D: Fn(PlainData) -> Migrated<S>,
    F: Fn(&S) -> Result<PlainData, C>,
{
    async fn delete(&self) -> Result<(), Self::Error> {
        self.0.delete().await
    }
}
impl<S, P, D, F, C> Fencing<S> for FencedDoStore<S, P, D, F>
where
    P: DurableObjectStorage,
    D: Fn(PlainData) -> Migrated<S>,
    F: Fn(&S) -> Result<PlainData, C>,
{
    type Raw = PlainData;
    type Error = DoStoreError<P::Error, C>;
    fn load_fenced(&self) -> LocalBoxFuture<'_, Result<FencedRead<PlainData>, Self::Error>> {
        async move {
            let raw = self
                .0
                .storage
                .get(self.0.version_key.clone())
                .await
                .map_err(|cause| DoStoreError::Storage {
                    operation: "get",
                    cause,
                })?;
            Ok(FencedRead {
                raw: self.0.load().await?,
                version: version(raw)?,
            })
        }
        .boxed_local()
    }
    fn save_fenced<'a>(
        &'a self,
        state: &'a S,
        expected_version: f64,
    ) -> LocalBoxFuture<'a, Result<f64, Self::Error>> {
        async move {
            let result = self
                .0
                .storage
                .transaction(|transaction| async move {
                    let actual =
                        version(transaction.get(self.0.version_key.clone()).await.map_err(
                            |cause| DoStoreError::Storage {
                                operation: "get",
                                cause,
                            },
                        )?)?;
                    if actual != expected_version {
                        return Err(DoStoreError::Conflict(StoreConflictError {
                            expected_version,
                            actual_version: actual,
                        }));
                    }
                    let next = expected_version + 1.0;
                    let value = (self.0.serialize)(state).map_err(DoStoreError::Encode)?;
                    transaction
                        .put(self.0.key.clone(), encoded_json(value))
                        .await
                        .map_err(|cause| DoStoreError::Storage {
                            operation: "put",
                            cause,
                        })?;
                    transaction
                        .put(self.0.version_key.clone(), PlainData::Number(next))
                        .await
                        .map_err(|cause| DoStoreError::Storage {
                            operation: "put",
                            cause,
                        })?;
                    Ok(next)
                })
                .await;
            match result {
                Ok(value) => Ok(value),
                Err(TransactionError::Body(error)) => Err(error),
                Err(TransactionError::Storage(cause)) => Err(DoStoreError::Storage {
                    operation: "transaction",
                    cause,
                }),
            }
        }
        .boxed_local()
    }
}
