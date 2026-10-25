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
