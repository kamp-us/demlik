use demlik_code_graph::{
    api::{base::checkout_of, map::ApiError},
    text::JsString,
};

#[test]
fn an_async_host_can_receive_an_owned_git_refusal_from_a_real_blocking_worker() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let root = JsString::from_units(vec![b'/' as u16, b'x' as u16, 0, 0xd800]);
        let returned = tokio::task::spawn_blocking(move || checkout_of(&root))
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(returned, ApiError::Argument(_)));
        assert!(
            std::error::Error::source(&returned)
                .unwrap()
                .source()
                .is_some()
        );
    });
}
