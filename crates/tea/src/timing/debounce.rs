use super::{Edges, Timer, TimerError};
use std::{cell::RefCell, rc::Rc};

struct State<A, H> {
    handle: Option<H>,
    pending: Option<A>,
    leading_fired: bool,
}
struct Inner<A, T: Timer> {
    state: RefCell<State<A, T::Handle>>,
    timer: Rc<T>,
    callback: Rc<dyn Fn(A)>,
    ms: f64,
    leading: bool,
    trailing: bool,
}

/// A live host wrapper. Scheduled work retains its state; call `cancel` when
/// detaching the host listener, even if the caller drops its wrapper handle.
pub struct Debounced<A, T: Timer>(Rc<Inner<A, T>>);
impl<A, T: Timer> Clone for Debounced<A, T> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}

pub fn debounce<A: 'static, T: Timer + 'static>(
    callback: impl Fn(A) + 'static,
    ms: f64,
    edges: Edges,
    timer: Rc<T>,
) -> Debounced<A, T> {
    Debounced(Rc::new(Inner {
        state: RefCell::new(State {
            handle: None,
            pending: None,
            leading_fired: false,
        }),
        timer,
        callback: Rc::new(callback),
        ms,
        leading: edges.leading.unwrap_or(false),
        trailing: edges.trailing.unwrap_or(true),
    }))
}
impl<A: 'static, T: Timer + 'static> Debounced<A, T> {
    pub fn invoke(&self, args: A) -> Result<(), TimerError> {
        let leads = {
            let mut state = self.0.state.borrow_mut();
            let leads = self.0.leading && state.handle.is_none() && !state.leading_fired;
            if leads {
                state.leading_fired = true;
            }
            leads
        };
        if leads {
            (self.0.callback)(args);
        } else if self.0.trailing {
            self.0.state.borrow_mut().pending = Some(args);
        }
        self.0.clear_handle();
        self.0.arm()
    }
    pub fn cancel(&self) {
        self.0.clear_handle();
        let mut state = self.0.state.borrow_mut();
        state.pending = None;
        state.leading_fired = false;
    }
    pub fn flush(&self) {
        let args = self.0.state.borrow_mut().pending.take();
        self.0.clear_handle();
        self.0.state.borrow_mut().leading_fired = false;
        if let Some(args) = args {
            (self.0.callback)(args);
        }
    }
}
impl<A, T: Timer> Inner<A, T> {
    fn clear_handle(&self) {
        let handle = self.state.borrow_mut().handle.take();
        if let Some(handle) = handle {
            self.timer.clear_timeout(&handle);
        }
    }
}
impl<A: 'static, T: Timer + 'static> Inner<A, T> {
    fn arm(self: &Rc<Self>) -> Result<(), TimerError> {
        let inner = Rc::clone(self);
        let handle = self.timer.set_timeout(
            self.ms,
            Box::new(move || {
                inner.expired();
                Ok(())
            }),
        )?;
        self.state.borrow_mut().handle = Some(handle);
        Ok(())
    }
    fn expired(&self) {
        self.state.borrow_mut().handle = None;
        let args = if self.trailing {
            self.state.borrow_mut().pending.take()
        } else {
            None
        };
        if let Some(args) = args {
            (self.callback)(args);
        }
        self.state.borrow_mut().leading_fired = false;
    }
}
