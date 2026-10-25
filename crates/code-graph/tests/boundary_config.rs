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

#[test]
fn file_resolution_preserves_refusals_declaration_order_and_raw_record_errors() {
    use demlik_code_graph::boundaries::config::{
        BoundaryConfigError, BoundaryConfigResolution, resolve_boundary_rules,
    };
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "demlik-boundary-rules-{}-{}.json",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let file: JsString = path.to_str().unwrap().into();
    let BoundaryConfigResolution::Resolved(defaults) = resolve_boundary_rules(None).unwrap() else {
        panic!("default rules refused");
    };
    assert_eq!(defaults.lib, [JsString::from("lib")]);
    let BoundaryConfigResolution::Refused { message } =
        resolve_boundary_rules(Some(&file)).unwrap()
    else {
        panic!("missing rules accepted");
    };
    assert_eq!(
        message,
        JsString::from(format!("cannot read config file \"{}\".", path.display()))
    );
    for (text, expected) in [
        (
            "{",
            format!("config file \"{}\" is not valid JSON.", path.display()),
        ),
        (
            r#"{"features":{"app":["orders","orders"]},"libraries":{"missing":"no-type"}}"#,
            "feature \"orders\" is declared twice in \"app\".".into(),
        ),
        (
            r#"{"features":{"app":[1]}}"#,
            format!(
                "invalid config in \"{}\": features.app.0: Invalid input: expected string, received number.",
                path.display()
            ),
        ),
    ] {
        fs::write(&path, text).unwrap();
        let BoundaryConfigResolution::Refused { message } =
            resolve_boundary_rules(Some(&file)).unwrap()
        else {
            panic!("invalid rules accepted: {text}");
        };
        assert_eq!(message, JsString::from(expected));
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }
    fs::write(
        &path,
        r#"{"features":{"app":[]},"bindingOwners":{"app":{"constructor":null}}}"#,
    )
    .unwrap();
    assert!(matches!(
        resolve_boundary_rules(Some(&file)),
        Err(BoundaryConfigError::RecordType(_))
    ));
    fs::write(&path, r#"{"features":{"app":["orders"]}}"#).unwrap();
    let BoundaryConfigResolution::Resolved(rules) = resolve_boundary_rules(Some(&file)).unwrap()
    else {
        panic!("valid rules refused");
    };
    assert_eq!(
        rules.features[&JsString::from("app")],
        [JsString::from("orders")]
    );
    fs::remove_file(path).unwrap();
}
