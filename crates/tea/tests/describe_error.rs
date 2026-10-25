use demlik_tea::{
    data::{JsText, decode_json},
    describe_error::{ErrorView, describe_error},
};

#[test]
fn an_error_message_is_distinct_from_a_message_shaped_plain_record() {
    let message = JsText::from_units(vec![0x70, 0xd800]);
    assert_eq!(
        describe_error(ErrorView::ErrorMessage(&message)).unwrap(),
        message
    );
    let record = decode_json(r#"{"message":"schema rejected","name":"Error"}"#).unwrap();
    assert_eq!(
        describe_error(ErrorView::Value(&record)).unwrap().as_utf8(),
        Some("[object Object]")
    );
    let invalid = decode_json(r#"{"toString":null}"#).unwrap();
    let cause = describe_error(ErrorView::Value(&invalid)).unwrap_err();
    assert_eq!(cause.name, "TypeError");
    assert_eq!(cause.message, "Cannot convert object to primitive value");
}
