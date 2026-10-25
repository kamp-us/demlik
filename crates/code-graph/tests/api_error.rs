use demlik_code_graph::{
    api::map::{ApiError, ApiInputError},
    text::JsString,
};
use std::{error::Error, io};
#[test]
fn input_refusal_keeps_raw_message_and_the_original_typed_cause() {
    let message = JsString::from_units("callback ".encode_utf16().chain([0xd800]).collect());
    let error = ApiError::Input(
        ApiInputError::new(message.clone())
            .with_cause(io::Error::from(io::ErrorKind::PermissionDenied)),
    );
    assert_eq!(error.name(), "ApiInputError");
    assert_eq!(error.message(), message);
    let input = error
        .source()
        .unwrap()
        .downcast_ref::<ApiInputError>()
        .unwrap();
    let cause = input.source().unwrap().downcast_ref::<io::Error>().unwrap();
    assert_eq!(cause.kind(), io::ErrorKind::PermissionDenied);
}
#[test]
fn cleanup_owns_the_visible_refusal_and_both_failures_remain_inspectable() {
    let raw = JsString::from_units("cleanup ".encode_utf16().chain([0xdfff]).collect());
    let operation = ApiError::Io {
        path: "archive.tar".into(),
        source: io::Error::from(io::ErrorKind::UnexpectedEof),
    };
    let cleanup = ApiError::Input(
        ApiInputError::new(raw.clone())
            .with_cause(io::Error::from(io::ErrorKind::PermissionDenied)),
    );
    let error = ApiError::OperationAndCleanup {
        operation: Box::new(operation),
        cleanup: Box::new(cleanup),
    };
    assert_eq!(error.name(), "ApiInputError");
    assert_eq!(error.message(), raw);
    let ApiError::OperationAndCleanup { operation, cleanup } = &error else {
        panic!("lost failure pair")
    };
    let ApiError::Io { source, .. } = operation.as_ref() else {
        panic!("lost operation")
    };
    assert_eq!(source.kind(), io::ErrorKind::UnexpectedEof);
    let ApiError::Input(cleanup) = cleanup.as_ref() else {
        panic!("lost cleanup")
    };
    assert_eq!(
        cleanup
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .unwrap()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(error.source().unwrap().downcast_ref::<ApiError>().is_some());
}

#[test]
fn null_argument_error_can_return_from_a_real_worker_without_sync_or_context_bounds() {
    use demlik_code_graph::api::map::{ApiArgumentError, ApiArgumentLocation};
    let returned = std::thread::spawn(|| {
        let value = JsString::from_units("rev".encode_utf16().chain([0, 0xd800]).collect());
        let cwd = JsString::from_units("cwd".encode_utf16().chain([0]).collect());
        let arguments = vec!["ordinary".into(), value.clone(), "later\0arg".into()];
        let cause = std::process::Command::new("git")
            .args(arguments.iter().map(JsString::to_lossy))
            .current_dir(cwd.to_lossy())
            .spawn()
            .unwrap_err();
        ApiError::Argument(ApiArgumentError::from_null_byte(&cwd, &arguments, cause).unwrap())
    })
    .join()
    .unwrap();
    assert_eq!(returned.name(), "TypeError");
    let ApiError::Argument(error) = returned else {
        panic!("lost argument refusal")
    };
    assert_eq!(error.code(), "ERR_INVALID_ARG_VALUE");
    assert_eq!(error.location(), ApiArgumentLocation::Argument(1));
    assert_eq!(error.argument().units(), &[114, 101, 118, 0, 0xd800]);
    assert_eq!(
        error
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .unwrap()
            .kind(),
        io::ErrorKind::InvalidInput
    );
}
#[test]
fn null_cwd_follows_all_arguments_and_non_null_failures_keep_their_original_kind() {
    use demlik_code_graph::api::map::{ApiArgumentError, ApiArgumentLocation};
    let cwd = JsString::from("bad\0cwd");
    let arguments = vec![JsString::from("ordinary")];
    let cause = std::process::Command::new("git")
        .args(arguments.iter().map(JsString::to_lossy))
        .current_dir(cwd.to_lossy())
        .spawn()
        .unwrap_err();
    let error = ApiArgumentError::from_null_byte(&cwd, &arguments, cause).unwrap();
    assert_eq!(error.location(), ApiArgumentLocation::WorkingDirectory);
    assert_eq!(error.argument(), &cwd);
    let ordinary = ApiArgumentError::from_null_byte(
        &"cwd".into(),
        &arguments,
        io::Error::from(io::ErrorKind::NotFound),
    )
    .unwrap_err();
    assert_eq!(ordinary.kind(), io::ErrorKind::NotFound);
}

#[test]
fn null_filesystem_path_keeps_its_own_location_raw_units_and_real_refusal() {
    use demlik_code_graph::api::map::{ApiArgumentError, ApiArgumentLocation};
    let value = JsString::from_units(vec![114, 97, 119, 0, 0xd800]);
    let native = std::fs::symlink_metadata(value.to_lossy()).unwrap_err();
    let error = ApiArgumentError::from_null_path(&value, native).unwrap();
    assert_eq!(error.location(), ApiArgumentLocation::Path);
    assert_eq!(error.argument(), &value);
    assert_eq!(error.code(), "ERR_INVALID_ARG_VALUE");
    assert_eq!(error.name(), "TypeError");
    assert_eq!(
        error
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .unwrap()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    let ordinary = ApiArgumentError::from_null_path(
        &"ordinary".into(),
        io::Error::from(io::ErrorKind::NotFound),
    )
    .unwrap_err();
    assert_eq!(ordinary.kind(), io::ErrorKind::NotFound);
}

#[cfg(unix)]
#[test]
fn symlink_refusal_keeps_both_raw_paths_and_node_target_before_path_precedence() {
    use demlik_code_graph::api::map::{ApiArgumentError, ApiArgumentLocation};
    let target = JsString::from_units(vec![116, 0, 0xd800]);
    let destination = JsString::from("dest\0bad");
    let cause = std::os::unix::fs::symlink(target.to_lossy(), destination.to_lossy()).unwrap_err();
    let error = ApiArgumentError::from_null_symlink(&target, &destination, cause).unwrap();
    assert_eq!(error.location(), ApiArgumentLocation::SymlinkTarget);
    assert_eq!(error.argument(), &target);
    let cause = std::os::unix::fs::symlink("ordinary", destination.to_lossy()).unwrap_err();
    let error =
        ApiArgumentError::from_null_symlink(&"ordinary".into(), &destination, cause).unwrap();
    assert_eq!(error.location(), ApiArgumentLocation::Path);
    assert_eq!(error.argument(), &destination);
    let path = JsString::from_units(vec![116, 0xd800]);
    let destination = JsString::from_units(vec![100, 0xdfff]);
    let error = ApiError::Symlink {
        path,
        destination,
        source: io::Error::from(io::ErrorKind::AlreadyExists),
    };
    assert_eq!(error.name(), "Error");
    assert_eq!(
        error
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .unwrap()
            .kind(),
        io::ErrorKind::AlreadyExists
    );
    let ApiError::Symlink {
        path, destination, ..
    } = error
    else {
        panic!("lost symlink event")
    };
    assert_eq!(path.units(), &[116, 0xd800]);
    assert_eq!(destination.units(), &[100, 0xdfff]);
}

#[test]
fn finally_cleanup_controls_input_classification_without_discarding_the_operation() {
    use demlik_code_graph::{api::map::api_subpaths, text::JsValue};
    let refusal = || api_subpaths(&"/package".into(), &JsValue::parse("{}").unwrap()).unwrap_err();
    assert!(refusal().is_input());
    let error = ApiError::OperationAndCleanup {
        operation: Box::new(ApiError::Io {
            path: "operation".into(),
            source: io::Error::from(io::ErrorKind::PermissionDenied),
        }),
        cleanup: Box::new(refusal()),
    };
    assert!(error.is_input());
    let ApiError::OperationAndCleanup { operation, cleanup } = &error else {
        panic!("lost causes")
    };
    assert!(std::ptr::eq(error.visible(), cleanup.as_ref()));
    assert!(
        matches!(operation.as_ref(),ApiError::Io{source,..} if source.kind()==io::ErrorKind::PermissionDenied)
    );
    let nested = ApiError::OperationAndCleanup {
        operation: Box::new(refusal()),
        cleanup: Box::new(ApiError::OperationAndCleanup {
            operation: Box::new(error),
            cleanup: Box::new(ApiError::Io {
                path: "cleanup".into(),
                source: io::Error::from(io::ErrorKind::NotFound),
            }),
        }),
    };
    assert!(!nested.is_input());
    assert!(
        matches!(nested.visible(),ApiError::Io{source,..} if source.kind()==io::ErrorKind::NotFound)
    );
}

#[test]
fn ordinary_callback_error_keeps_raw_message_and_original_cause_across_a_worker() {
    use demlik_code_graph::api::map::ApiCallbackError;
    use std::sync::Arc;
    #[derive(Debug)]
    struct ToolCause {
        marker: Arc<()>,
    }
    impl std::fmt::Display for ToolCause {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("original tooling failure")
        }
    }
    impl Error for ToolCause {}
    let marker = Arc::new(());
    let shared = Arc::clone(&marker);
    let message = JsString::from_units(
        "ApiInputError: callback "
            .encode_utf16()
            .chain([0xd800, 10, 9, 0x85])
            .collect(),
    );
    let raw = message.clone();
    let error = std::thread::spawn(move || {
        ApiError::Callback(ApiCallbackError::new(raw).with_cause(ToolCause { marker: shared }))
    })
    .join()
    .unwrap();
    assert_eq!(error.name(), "Error");
    assert_eq!(error.message(), message);
    assert!(!error.is_input());
    let cause = error
        .source()
        .unwrap()
        .downcast_ref::<ApiCallbackError>()
        .unwrap()
        .source()
        .unwrap()
        .downcast_ref::<ToolCause>()
        .unwrap();
    assert!(Arc::ptr_eq(&marker, &cause.marker));
}
