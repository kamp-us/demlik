use super::listeners::{Listeners, Unsubscribe};
use crate::{Tagged, data::JsText, storage::PanicCause};
use indexmap::IndexMap;
use std::{cell::RefCell, rc::Rc};

pub enum NoEvent {}
impl Tagged for NoEvent {
    fn tag(&self) -> &str {
        match *self {}
    }
}
pub type EventProjector<S, M, E> = Rc<dyn Fn(&M, &S) -> Vec<E>>;
pub type CheckedEventProjector<S, M, E, RE> = Rc<dyn Fn(&M, &S) -> Result<Vec<E>, RE>>;
/// One selected semantic projection. Checked failures use the runtime's existing
/// reducer error channel; neither mode delivers a partial event batch.
pub enum EventProjection<S, M, E, RE> {
    Plain(EventProjector<S, M, E>),
    Checked(CheckedEventProjector<S, M, E, RE>),
}
impl<S, M, E, RE> Clone for EventProjection<S, M, E, RE> {
    fn clone(&self) -> Self {
        match self {
            Self::Plain(project) => Self::Plain(Rc::clone(project)),
            Self::Checked(project) => Self::Checked(Rc::clone(project)),
        }
    }
}
type EventListeners<E> = Listeners<dyn Fn(&E)>;
pub(crate) struct SemanticEvents<S, M, E, RE> {
    project: Option<EventProjection<S, M, E, RE>>,
    handlers: RefCell<IndexMap<JsText, Rc<EventListeners<E>>>>,
}
impl<S: 'static, M: 'static, E: Tagged + 'static, RE: 'static> SemanticEvents<S, M, E, RE> {
    pub fn new(project: Option<EventProjection<S, M, E, RE>>) -> Rc<Self> {
        Rc::new(Self {
            project,
            handlers: RefCell::new(IndexMap::new()),
        })
    }
    pub fn subscribe(self: &Rc<Self>, kind: JsText, callback: Rc<dyn Fn(&E)>) -> Unsubscribe {
        let bucket = self
            .handlers
            .borrow_mut()
            .entry(kind.clone())
            .or_insert_with(Listeners::new)
            .clone();
        let detach = bucket.add(callback);
        let owner = Rc::downgrade(self);
        Box::new(move || {
            detach();
            if !bucket.is_empty() {
                return;
            }
            if let Some(owner) = owner.upgrade() {
                let same = owner
                    .handlers
                    .borrow()
                    .get(&kind)
                    .is_some_and(|current| Rc::ptr_eq(current, &bucket));
                if same {
                    owner.handlers.borrow_mut().shift_remove(&kind);
                }
            }
        })
    }
    pub fn committed(
        &self,
        msg: &M,
        state: &S,
        rejected: impl Fn(RE),
        report: impl Fn(PanicCause),
    ) {
        let Some(project) = &self.project else { return };
        if self.handlers.borrow().is_empty() {
            return;
        }
        let events =
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match project {
                EventProjection::Plain(project) => Ok(project(msg, state)),
                EventProjection::Checked(project) => project(msg, state),
            })) {
                Ok(Ok(events)) => events,
                Ok(Err(error)) => {
                    rejected(error);
                    return;
                }
                Err(payload) => {
                    report(PanicCause::new(payload));
                    return;
                }
            };
        for event in events {
            let bucket = self.handlers.borrow().get(event.tag()).cloned();
            if let Some(bucket) = bucket {
                bucket.fanout(|listener| listener(&event), &report);
            }
        }
    }
}
