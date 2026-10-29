//! Fault controls for this private local consumer, through the real JS SDK seam.
use worker::{
    js_sys,
    wasm_bindgen::{JsCast, JsValue, closure::Closure},
    wasm_bindgen_futures::{JsFuture, future_to_promise},
};

type Callback = Closure<dyn FnMut(js_sys::Function) -> Result<js_sys::Promise, JsValue>>;
pub(super) struct Fault {
    storage: JsValue,
    original: JsValue,
    _callback: Callback,
    pub(super) error: JsValue,
}
impl Fault {
    pub(super) fn install(storage: &worker::Storage, at_commit: bool) -> worker::Result<Self> {
        let storage: JsValue = storage.as_raw().into();
        let original = js_sys::Reflect::get(&storage, &"transaction".into())?;
        let original_function = original.clone().dyn_into::<js_sys::Function>()?;
        let error: JsValue = js_sys::Error::new(if at_commit {
            "injected commit rejection"
        } else {
            "injected early SDK rejection"
        })
        .into();
        let target = storage.clone();
        let cause = error.clone();
        let callback = Closure::wrap(Box::new(
            move |body: js_sys::Function| -> Result<js_sys::Promise, JsValue> {
                if !at_commit {
                    return Ok(js_sys::Promise::reject(&cause));
                }
                let cause = cause.clone();
                // The original SDK transaction still owns commit/rollback. Rejecting
                // after its body succeeds exercises real rollback at settlement.
                let wrapped = Closure::once_into_js(
                    move |txn: JsValue| -> Result<js_sys::Promise, JsValue> {
                        let promise = body
                            .call1(&JsValue::UNDEFINED, &txn)?
                            .dyn_into::<js_sys::Promise>()?;
                        Ok(future_to_promise(async move {
                            JsFuture::from(promise).await?;
                            Err(cause)
                        }))
                    },
                );
                original_function
                    .call1(&target, &wrapped)?
                    .dyn_into::<js_sys::Promise>()
            },
        )
            as Box<dyn FnMut(js_sys::Function) -> Result<js_sys::Promise, JsValue>>);
        replace(&storage, callback.as_ref())?;
        Ok(Self {
            storage,
            original,
            _callback: callback,
            error,
        })
    }
    pub(super) fn restore(self) -> worker::Result<()> {
        replace(&self.storage, &self.original)?;
        Ok(())
    }
}
impl Drop for Fault {
    fn drop(&mut self) {
        // Also restore on cancellation; the callback remains owned until here.
        if let Err(error) = replace(&self.storage, &self.original) {
            worker::console_error!("failed to restore transaction fault control: {:?}", error);
        }
    }
}

fn replace(storage: &JsValue, method: &JsValue) -> worker::Result<()> {
    if js_sys::Reflect::set(storage, &"transaction".into(), method)? {
        Ok(())
    } else {
        Err(worker::Error::RustError(
            "transaction fault control method assignment refused".into(),
        ))
    }
}
