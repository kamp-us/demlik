use std::cell::RefCell;
use std::fmt;
use std::marker::PhantomData;
use std::rc::Rc;

use futures::{FutureExt, future::LocalBoxFuture};

use crate::storage::{Migrated, Store, StoreRefusedError, StoredCell, restore};

pub(crate) trait Backend<S, E> {
    fn restore(&self) -> LocalBoxFuture<'_, Result<Option<S>, StoreRefusedError<E>>>;
    fn save<'a>(&'a self, state: &'a S) -> LocalBoxFuture<'a, Result<(), E>>;
}
struct Lease<P, S> {
    store: Rc<P>,
    version: RefCell<StoredCell>,
    state: PhantomData<fn() -> S>,
}
impl<S, P: Store<S>> Store<S> for Lease<P, S> {
    type Raw = P::Raw;
    type Error = P::Error;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        if let Some(fenced) = self.store.fencing() {
            let read = fenced.load_fenced().await?;
            self.version.replace(read.version);
            Ok(read.raw)
        } else {
            self.store.load().await
        }
    }
    async fn save(&self, state: &S) -> Result<(), Self::Error> {
        if let Some(fenced) = self.store.fencing() {
            let expected = self.version.borrow().clone();
            let version = fenced.save_fenced(state, expected).await?;
            self.version.replace(version);
            Ok(())
        } else {
            self.store.save(state).await
        }
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<S> {
        self.store.migrate(raw)
    }
}
impl<S, P: Store<S>> Backend<S, P::Error> for Lease<P, S>
where
    P::Error: fmt::Display,
{
    fn restore(&self) -> LocalBoxFuture<'_, Result<Option<S>, StoreRefusedError<P::Error>>> {
        restore(self).boxed_local()
    }
    fn save<'a>(&'a self, state: &'a S) -> LocalBoxFuture<'a, Result<(), P::Error>> {
        Store::save(self, state).boxed_local()
    }
}
/// Creates a separate fencing lease for each run, even when this binding is cloned.
pub struct Persistence<S, E> {
    make: Rc<dyn Fn() -> Rc<dyn Backend<S, E>>>,
}
impl<S, E> Clone for Persistence<S, E> {
    fn clone(&self) -> Self {
        Self {
            make: Rc::clone(&self.make),
        }
    }
}
impl<S: 'static, E: fmt::Display + 'static> Persistence<S, E> {
    pub fn new<P: Store<S, Error = E> + 'static>(store: P) -> Self {
        let store = Rc::new(store);
        Self {
            make: Rc::new(move || {
                Rc::new(Lease {
                    store: Rc::clone(&store),
                    version: RefCell::new(StoredCell::Number(0.0)),
                    state: PhantomData,
                })
            }),
        }
    }
}
impl<S, E> Persistence<S, E> {
    pub(crate) fn open(&self) -> Rc<dyn Backend<S, E>> {
        (self.make)()
    }
}
