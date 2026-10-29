//! Real Node/global JavaScript timer adapter for this private consumer.
use demlik_tea::timing::{Timer, TimerCallback, TimerError};
use js_sys::Function;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use wasm_bindgen::{JsCast, JsValue, closure::Closure, prelude::*};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = globalThis, js_name = setTimeout, catch)]
    fn set_timeout(callback: &Function, ms: f64) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace = globalThis, js_name = clearTimeout, catch)]
    fn clear_timeout(token: &JsValue) -> Result<(), JsValue>;
}
#[derive(Clone, Default)]
pub(super) struct NodeTimer {
    next: Rc<Cell<u32>>,
    active: Rc<RefCell<std::collections::BTreeSet<u32>>>,
    arms: Rc<RefCell<Vec<f64>>>,
    clears: Rc<RefCell<Vec<u32>>>,
    fail_next: Rc<Cell<bool>>,
    errors: Rc<RefCell<Vec<String>>>,
}
pub(super) struct Handle {
    id: u32,
    token: JsValue,
    _callback: Closure<dyn FnMut()>,
}
impl Timer for NodeTimer {
    type Handle = Handle;
    fn now_ms(&self) -> f64 {
        js_sys::Date::now()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<Handle, TimerError> {
        if self.fail_next.replace(false) {
            return Err(TimerError {
                message: "deadline arm refused (code 73)".into(),
                cause: Some(demlik_tea::storage::PanicCause::new(Box::new(73_u32))),
            });
        }
        let id = self.next.get() + 1;
        self.next.set(id);
        self.arms.borrow_mut().push(ms);
        let active = Rc::clone(&self.active);
        let mut callback = Some(callback);
        let errors = Rc::clone(&self.errors);
        let closure = Closure::wrap(Box::new(move || {
            active.borrow_mut().remove(&id);
            if let Some(callback) = callback.take()
                && let Err(error) = callback()
            {
                errors.borrow_mut().push(error.to_string());
            }
        }) as Box<dyn FnMut()>);
        let token = set_timeout(closure.as_ref().unchecked_ref(), ms)
            .map_err(|error| TimerError::new(format!("setTimeout rejected: {error:?}")))?;
        self.active.borrow_mut().insert(id);
        Ok(Handle {
            id,
            token,
            _callback: closure,
        })
    }
    fn clear_timeout(&self, handle: &Handle) {
        self.active.borrow_mut().remove(&handle.id);
        self.clears.borrow_mut().push(handle.id);
        if let Err(error) = clear_timeout(&handle.token) {
            self.errors
                .borrow_mut()
                .push(format!("clearTimeout rejected: {error:?}"));
        }
    }
}

impl NodeTimer {
    pub(super) fn stats(&self) -> serde_json::Value {
        serde_json::json!({"arms":&*self.arms.borrow(),"clears":&*self.clears.borrow(),"active":&*self.active.borrow(),"errors":&*self.errors.borrow()})
    }
    pub(super) fn fail_next(&self) {
        self.fail_next.set(true);
    }
}
pub(super) async fn sleep(ms: u32) -> Result<(), JsValue> {
    let timer = NodeTimer::default();
    let (tx, rx) = futures::channel::oneshot::channel();
    let handle = timer
        .set_timeout(
            f64::from(ms),
            Box::new(move || {
                let _ = tx.send(());
                Ok(())
            }),
        )
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    rx.await
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    drop(handle);
    Ok(())
}
