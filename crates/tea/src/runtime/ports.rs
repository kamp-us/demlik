use super::listeners::{Listeners, Unsubscribe};
use crate::{
    ports::{Port, PortKey},
    storage::PanicCause,
};
use std::{any::Any, cell::RefCell, collections::HashMap, rc::Rc, sync::Arc};

type PortListeners<T> = Listeners<dyn Fn(&T)>;
struct Bucket {
    _key: Arc<PortKey>,
    listeners: Rc<dyn Any>,
}
#[derive(Default)]
pub(crate) struct PortRegistry {
    buckets: RefCell<HashMap<usize, Bucket>>,
}
impl PortRegistry {
    fn listeners<T: 'static>(&self, port: &Port<T>, create: bool) -> Option<Rc<PortListeners<T>>> {
        let existing = self
            .buckets
            .borrow()
            .get(&port.id())
            .map(|bucket| Rc::clone(&bucket.listeners));
        if let Some(existing) = existing {
            return Some(existing.downcast::<PortListeners<T>>().unwrap_or_else(|_| {
                unreachable!("a private Port identity retains its declared payload type")
            }));
        }
        if !create {
            return None;
        }
        let listeners = PortListeners::<T>::new();
        self.buckets.borrow_mut().insert(
            port.id(),
            Bucket {
                _key: Arc::clone(&port.key),
                listeners: listeners.clone(),
            },
        );
        Some(listeners)
    }
    pub fn subscribe<T: 'static>(
        self: &Rc<Self>,
        port: &Port<T>,
        callback: Rc<dyn Fn(&T)>,
    ) -> Unsubscribe {
        let listeners = self.listeners(port, true).expect("created port bucket");
        let detach = listeners.add(callback);
        let owner = Rc::downgrade(self);
        let key = port.id();
        let erased: Rc<dyn Any> = listeners.clone();
        Box::new(move || {
            detach();
            if !listeners.is_empty() {
                return;
            }
            if let Some(owner) = owner.upgrade() {
                let same = owner
                    .buckets
                    .borrow()
                    .get(&key)
                    .is_some_and(|current| Rc::ptr_eq(&current.listeners, &erased));
                if same {
                    owner.buckets.borrow_mut().remove(&key);
                }
            }
        })
    }
    pub fn emit<T: 'static>(&self, port: &Port<T>, value: &T, report: impl Fn(PanicCause)) {
        let Some(listeners) = self.listeners(port, false) else {
            return;
        };
        listeners.fanout(|listener| listener(value), report);
    }
}
#[derive(Clone)]
pub(crate) struct PortEmitter {
    pub registry: Rc<PortRegistry>,
    pub report: Rc<dyn Fn(PanicCause)>,
}
impl PortEmitter {
    pub fn emit<T: 'static>(&self, port: &Port<T>, value: &T) {
        self.registry
            .emit(port, value, |cause| (self.report)(cause));
    }
}
