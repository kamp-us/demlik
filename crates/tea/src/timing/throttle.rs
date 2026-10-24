use super::{Edges, Timer, TimerError};
use std::{cell::RefCell, rc::Rc};

struct State<A, H> {
    handle: Option<H>,
    pending: Option<A>,
}
struct Inner<A, T: Timer> {
    state: RefCell<State<A, T::Handle>>,
    timer: Rc<T>,
    callback: Rc<dyn Fn(A)>,
    ms: f64,
    leading: bool,
    trailing: bool,
}
/// Leading callbacks run before the window is armed. Timer-driven trailing
/// callbacks arm the next window first, preserving the source's re-entry order.
pub struct Throttled<A, T: Timer>(Rc<Inner<A, T>>);
impl<A, T: Timer> Clone for Throttled<A, T> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}
pub fn throttle<A: 'static, T: Timer + 'static>(
    callback: impl Fn(A) + 'static,
    ms: f64,
    edges: Edges,
    timer: Rc<T>,
) -> Throttled<A, T> {
    Throttled(Rc::new(Inner {
        state: RefCell::new(State {
            handle: None,
            pending: None,
        }),
        timer,
        callback: Rc::new(callback),
        ms,
        leading: edges.leading.unwrap_or(true),
        trailing: edges.trailing.unwrap_or(true),
    }))
}
impl<A: 'static, T: Timer + 'static> Throttled<A, T> {
    pub fn invoke(&self, args: A) -> Result<(), TimerError> {
        let open = self.0.state.borrow().handle.is_none();
        if open {
            if self.0.leading {
                (self.0.callback)(args);
            } else if self.0.trailing {
                self.0.state.borrow_mut().pending = Some(args);
            }
            self.0.arm()?;
        } else if self.0.trailing {
            self.0.state.borrow_mut().pending = Some(args);
        }
        Ok(())
    }
    pub fn cancel(&self) {
        self.0.clear_handle();
        self.0.state.borrow_mut().pending = None;
    }
    pub fn flush(&self) {
        let args = self.0.state.borrow_mut().pending.take();
        self.0.clear_handle();
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
        let handle = self
            .timer
            .set_timeout(self.ms, Box::new(move || inner.expired()))?;
        self.state.borrow_mut().handle = Some(handle);
        Ok(())
    }
    fn expired(self: &Rc<Self>) -> Result<(), TimerError> {
        let args = if self.trailing {
            self.state.borrow_mut().pending.take()
        } else {
            None
        };
        if let Some(args) = args {
            self.arm()?;
            (self.callback)(args);
        } else {
            self.state.borrow_mut().handle = None;
        }
        Ok(())
    }
}
