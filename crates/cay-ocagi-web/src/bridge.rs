//! Small JSON ABI. The browser glue only copies UTF-8 bytes and invokes Rust.
use super::{BrowserHost, Request};
use std::cell::RefCell;
thread_local! {
    static HOST: RefCell<BrowserHost> = RefCell::new(BrowserHost::default());
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn tea_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; length].into_boxed_slice()).cast::<u8>()
}

/// # Safety
/// `input` must be a live allocation from tea_alloc with the exact same length.
/// This function consumes that allocation. The returned bytes remain valid until
/// the next call; read their size with tea_output_len before making another call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tea_request(input: *mut u8, length: usize) -> *const u8 {
    // SAFETY: the JS bridge writes and passes the allocation it just requested.
    let bytes = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(input, length)) };
    let result = serde_json::from_slice::<Request>(&bytes)
        .map_err(|error| error.to_string())
        .and_then(|request| HOST.with(|host| host.borrow_mut().request(request)));
    let json = match result {
        Ok(value) => serde_json::json!({"ok":value}),
        Err(error) => serde_json::json!({"error":error}),
    };
    OUTPUT.with(|output| {
        *output.borrow_mut() = serde_json::to_vec(&json).unwrap();
        output.borrow().as_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tea_output_len() -> usize {
    OUTPUT.with(|output| output.borrow().len())
}
