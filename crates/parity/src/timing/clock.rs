use demlik_tea::timing::{Timer, TimerCallback, TimerError, native_timeout_ms};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    panic::{AssertUnwindSafe, catch_unwind},
};

pub struct Clock {
    pub now: Cell<f64>,
    next: Cell<u64>,
    tasks: RefCell<BTreeMap<u64, (f64, TimerCallback)>>,
    pub events: RefCell<Vec<Value>>,
    pub errors: RefCell<Vec<Value>>,
    fail_at: Option<u64>,
}
impl Clock {
    pub fn new(now: f64, fail_at: Option<u64>) -> Self {
        Self {
            now: Cell::new(now),
            next: Cell::new(0),
            tasks: RefCell::new(BTreeMap::new()),
            events: RefCell::new(Vec::new()),
            errors: RefCell::new(Vec::new()),
            fail_at,
        }
    }
    pub fn active(&self) -> Vec<Value> {
        self.tasks
            .borrow()
            .iter()
            .map(|(id, (due, _))| json!({"id":id,"due":super::number(*due)}))
            .collect()
    }
    pub fn error(&self, phase: &str, error: Value) {
        self.errors
            .borrow_mut()
            .push(json!({"at":super::number(self.now.get()),"phase":phase,"error":error}));
    }
    pub fn advance(&self, to: f64) -> Result<(), String> {
        for _ in 0..1000 {
            let next = self
                .tasks
                .borrow()
                .iter()
                .filter(|(_, (due, _))| *due <= to)
                .min_by(|(a, (left, _)), (b, (right, _))| left.total_cmp(right).then(a.cmp(b)))
                .map(|(id, _)| *id);
            let Some(id) = next else {
                self.now.set(to);
                return Ok(());
            };
            let (due, callback) = self.tasks.borrow_mut().remove(&id).unwrap();
            self.now.set(due);
            self.events
                .borrow_mut()
                .push(json!({"kind":"timer","id":id,"at":super::number(due)}));
            match catch_unwind(AssertUnwindSafe(callback)) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => self.error("timer", timer_error(&error)),
                Err(payload) => self.error("timer", panic_error(payload.as_ref())),
            }
        }
        Err("deterministic timer script exhausted its 1000-fire budget".into())
    }
}
pub fn timer_error(error: &TimerError) -> Value {
    json!({"name":"Error","message":error.message})
}
pub fn panic_error(payload: &(dyn std::any::Any + Send)) -> Value {
    payload
        .downcast_ref::<Value>()
        .cloned()
        .or_else(|| payload.downcast_ref::<TimerError>().map(timer_error))
        .or_else(|| payload.downcast_ref::<String>().map(|value| json!(value)))
        .or_else(|| payload.downcast_ref::<&str>().map(|value| json!(value)))
        .unwrap_or_else(|| json!({"name":"Error","message":"non-protocol panic"}))
}
impl Timer for Clock {
    type Handle = u64;
    fn now_ms(&self) -> f64 {
        self.now.get()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<u64, TimerError> {
        let id = self.next.get();
        self.next.set(id + 1);
        let failed = self.fail_at == Some(id + 1);
        let due = self.now.get() + native_timeout_ms(ms) as f64;
        self.events.borrow_mut().push(json!({"kind":"arm","id":id,"at":super::number(self.now.get()),"ms":super::number(ms),"due":super::number(due),"failed":failed}));
        if failed {
            return Err(TimerError::new(format!("arm failed {}", id + 1)));
        }
        self.tasks.borrow_mut().insert(id, (due, callback));
        Ok(id)
    }
    fn clear_timeout(&self, id: &u64) {
        self.events
            .borrow_mut()
            .push(json!({"kind":"clear","id":id,"at":super::number(self.now.get())}));
        self.tasks.borrow_mut().remove(id);
    }
}
