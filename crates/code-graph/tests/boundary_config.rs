use demlik_code_graph::{
    boundaries::{config::BoundaryRuleInputError, rules::BoundaryRules},
    text::{JsString, JsValue},
};
#[test]
fn validated_rules_keep_defaults_drop_record_proto_and_round_trip_raw_utf16_keys() {
    let value=JsValue::parse(r#"{"features":{"\ud800":["\udfff"],"__proto__":null},"libraryTypes":{"contract":{"imports":[],"pure":true}}}"#).unwrap();
    let rules = BoundaryRules::parse(&value).unwrap();
    assert_eq!(rules.lib, vec![JsString::from("lib")]);
    assert_eq!(rules.features.len(), 1);
    let key = JsString::from_units(vec![0xd800]);
    assert_eq!(rules.features[&key][0].units(), &[0xdfff]);
    let json = serde_json::to_string(&rules).unwrap();
    assert!(json.contains(r#""\ud800":["\udfff"]"#));
    let reloaded = BoundaryRules::parse(&JsValue::parse(&json).unwrap()).unwrap();
    assert_eq!(reloaded, rules);
}
#[test]
fn thrown_record_errors_override_normal_issues_but_invalid_keys_hide_their_values() {
    let value =
        JsValue::parse(r#"{"features":{"app":[]},"bindingOwners":{"app":{"constructor":null}}}"#)
            .unwrap();
    assert!(
        matches!(BoundaryRules::parse(&value),Err(BoundaryRuleInputError::TypeError(error)) if error.name()=="TypeError")
    );
    let value = JsValue::parse(r#"{"bindingOwners":{"":{"constructor":null}}}"#).unwrap();
    assert!(
        matches!(BoundaryRules::parse(&value),Err(BoundaryRuleInputError::Issue(issue)) if issue.message()=="Invalid key in record")
    );
}
