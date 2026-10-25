use demlik_code_graph::text::{JsString, JsValue};
use demlik_code_graph::validation::{InputIssue, PathSegment};

#[test]
fn retains_flat_validation_details_and_authoritative_utf16_path_and_message() {
    let details = JsValue::parse(r#"{"code":"too_small","origin":"string","minimum":1,"inclusive":true,"path":false,"message":"wrong"}"#).unwrap().as_object().unwrap().clone();
    let issue = InputIssue::new(
        vec![
            PathSegment::Field(JsString::from_units(vec![0xd800])),
            PathSegment::Index(2),
        ],
        JsString::from_units(vec![0xdfff]),
    )
    .with_details(details);
    assert_eq!(issue.path().len(), 2);
    assert_eq!(issue.message().units(), [0xdfff]);
    assert_eq!(issue.details().len(), 4);
    assert_eq!(
        serde_json::to_string(&issue).unwrap(),
        r#"{"code":"too_small","origin":"string","minimum":1,"inclusive":true,"path":["\ud800",2],"message":"\udfff"}"#
    );
}

#[test]
fn distinguishes_plain_record_refusals_from_thrown_constructor_errors() {
    use demlik_code_graph::validation::{record_constructor_value, record_object};
    for (text, plain) in [
        ("{}", true),
        ("[]", false),
        ("null", false),
        (r#"{"constructor":1}"#, false),
        (
            r#"{"constructor":{"prototype":{"isPrototypeOf":null}}}"#,
            true,
        ),
        (r#"{"constructor":{"prototype":{}}}"#, false),
        (r#"{"constructor":{"prototype":[]}}"#, false),
    ] {
        let value = JsValue::parse(text).unwrap();
        assert_eq!(record_object(&value).unwrap().is_some(), plain, "{text}");
    }
    let value = JsValue::parse(r#"{"constructor":null}"#).unwrap();
    let error = record_object(&value).unwrap_err();
    assert_eq!(error.name(), "TypeError");
    assert_eq!(
        error.message(),
        "Cannot read properties of null (reading 'prototype')"
    );
    assert!(record_constructor_value(None).unwrap());
}
