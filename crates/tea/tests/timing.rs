use demlik_tea::timing::{
    Debounced, Edges, Throttled, Timer, TimerCallback, TimerError, debounce, throttle,
};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};

#[derive(Default)]
struct ManualTimer {
    now: Cell<f64>,
    next: Cell<u64>,
    tasks: RefCell<BTreeMap<u64, (f64, TimerCallback)>>,
}
impl Timer for ManualTimer {
    type Handle = u64;
    fn now_ms(&self) -> f64 {
        self.now.get()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<u64, TimerError> {
        let id = self.next.get();
        self.next.set(id + 1);
        self.tasks
            .borrow_mut()
            .insert(id, (self.now.get() + ms, callback));
        Ok(id)
    }
    fn clear_timeout(&self, id: &u64) {
        self.tasks.borrow_mut().remove(id);
    }
}
impl ManualTimer {
    fn advance(&self, at: f64) {
        loop {
            let next = self
                .tasks
                .borrow()
                .iter()
                .filter(|(_, (due, _))| *due <= at)
                .min_by(|(left, (a, _)), (right, (b, _))| a.total_cmp(b).then(left.cmp(right)))
                .map(|(id, _)| *id);
            let Some(id) = next else { break };
            let (due, callback) = self.tasks.borrow_mut().remove(&id).unwrap();
            self.now.set(due);
            callback().unwrap();
        }
        self.now.set(at);
    }
}

#[test]
fn debounce_slides_keeps_last_args_and_cancel_flush_close_the_burst() {
    let timer = Rc::new(ManualTimer::default());
    let output = Rc::new(RefCell::new(Vec::new()));
    let d = debounce(
        {
            let output = output.clone();
            move |args| output.borrow_mut().push(args)
        },
        100.0,
        Edges::default(),
        timer.clone(),
    );
    d.invoke("first").unwrap();
    timer.advance(60.0);
    d.invoke("last").unwrap();
    timer.advance(159.0);
    assert!(output.borrow().is_empty());
    timer.advance(160.0);
    assert_eq!(*output.borrow(), ["last"]);
    d.invoke("flush").unwrap();
    d.flush();
    d.invoke("cancelled").unwrap();
    d.cancel();
    timer.advance(999.0);
    assert_eq!(*output.borrow(), ["last", "flush"]);
    assert!(timer.tasks.borrow().is_empty());
}

#[test]
fn a_reentrant_throttle_leading_callback_really_invokes_the_same_callback_again() {
    let timer = Rc::new(ManualTimer::default());
    let output = Rc::new(RefCell::new(Vec::new()));
    let holder: Rc<RefCell<Option<Throttled<i32, ManualTimer>>>> = Rc::new(RefCell::new(None));
    let t = throttle(
        {
            let holder = Rc::downgrade(&holder);
            let output = output.clone();
            move |value| {
                output.borrow_mut().push(value);
                if value == 1 {
                    holder
                        .upgrade()
                        .unwrap()
                        .borrow()
                        .as_ref()
                        .unwrap()
                        .invoke(2)
                        .unwrap();
                }
            }
        },
        100.0,
        Edges::default(),
        timer.clone(),
    );
    *holder.borrow_mut() = Some(t.clone());
    t.invoke(1).unwrap();
    assert_eq!(*output.borrow(), [1, 2]);
    timer.advance(100.0);
    assert_eq!(*output.borrow(), [1, 2]);
    assert!(timer.tasks.borrow().is_empty());
    holder.borrow_mut().take();
}

#[test]
fn a_reentrant_debounce_leading_callback_keeps_the_pending_trailing_tuple() {
    let timer = Rc::new(ManualTimer::default());
    let output = Rc::new(RefCell::new(Vec::new()));
    let holder: Rc<RefCell<Option<Debounced<i32, ManualTimer>>>> = Rc::new(RefCell::new(None));
    let d = debounce(
        {
            let holder = Rc::downgrade(&holder);
            let output = output.clone();
            move |value| {
                output.borrow_mut().push(value);
                if value == 1 {
                    holder
                        .upgrade()
                        .unwrap()
                        .borrow()
                        .as_ref()
                        .unwrap()
                        .invoke(2)
                        .unwrap();
                }
            }
        },
        100.0,
        Edges {
            leading: Some(true),
            trailing: Some(true),
        },
        timer.clone(),
    );
    *holder.borrow_mut() = Some(d.clone());
    d.invoke(1).unwrap();
    assert_eq!(*output.borrow(), [1]);
    timer.advance(100.0);
    assert_eq!(*output.borrow(), [1, 2]);
    assert!(timer.tasks.borrow().is_empty());
    holder.borrow_mut().take();
}

#[test]
fn a_pending_call_remains_live_when_the_callers_wrapper_handle_leaves_scope() {
    let timer = Rc::new(ManualTimer::default());
    let output = Rc::new(RefCell::new(Vec::new()));
    let d = debounce(
        {
            let output = output.clone();
            move |value| output.borrow_mut().push(value)
        },
        100.0,
        Edges::default(),
        timer.clone(),
    );
    d.invoke("retained").unwrap();
    drop(d);
    timer.advance(100.0);
    assert_eq!(*output.borrow(), ["retained"]);
    assert!(timer.tasks.borrow().is_empty());
}
