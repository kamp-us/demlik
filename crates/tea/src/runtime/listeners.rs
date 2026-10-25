use crate::storage::PanicCause;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    ops::Bound::{Excluded, Unbounded},
    rc::Rc,
};

pub(crate) fn fanout<T>(
    items: impl IntoIterator<Item = T>,
    call: impl Fn(T),
    report: impl Fn(PanicCause),
) {
    for item in items {
        if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(item)))
        {
            report(PanicCause::new(payload));
        }
    }
}

pub type Unsubscribe = Box<dyn Fn()>;
pub(crate) struct Listeners<F: ?Sized> {
    next: Cell<u64>,
    items: RefCell<BTreeMap<u64, Rc<F>>>,
}
impl<F: ?Sized + 'static> Listeners<F> {
    pub fn new() -> Rc<Self> {
        Rc::new(Self {
            next: Cell::new(0),
            items: RefCell::new(BTreeMap::new()),
        })
    }
    pub fn add(self: &Rc<Self>, callback: Rc<F>) -> Unsubscribe {
        if !self
            .items
            .borrow()
            .values()
            .any(|item| Rc::ptr_eq(item, &callback))
        {
            let id = self.next.get();
            self.next.set(id + 1);
            self.items.borrow_mut().insert(id, Rc::clone(&callback));
        }
        let listeners = Rc::clone(self);
        Box::new(move || {
            let id = listeners
                .items
                .borrow()
                .iter()
                .find(|(_, item)| Rc::ptr_eq(item, &callback))
                .map(|(id, _)| *id);
            if let Some(id) = id {
                listeners.items.borrow_mut().remove(&id);
            }
        })
    }
    pub fn is_empty(&self) -> bool {
        self.items.borrow().is_empty()
    }
    pub fn fanout(&self, call: impl Fn(Rc<F>), report: impl Fn(PanicCause)) {
        self.for_each(|item| fanout([item], &call, &report));
    }
    pub fn for_each(&self, call: impl Fn(Rc<F>)) {
        let mut after = None;
        loop {
            let next = self
                .items
                .borrow()
                .range((after.map_or(Unbounded, Excluded), Unbounded))
                .next()
                .map(|(id, item)| (*id, Rc::clone(item)));
            let Some((id, item)) = next else { return };
            after = Some(id);
            call(item);
        }
    }
}
