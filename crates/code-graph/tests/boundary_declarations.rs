use demlik_code_graph::{
    boundaries::{declaration::declaration_issue, rules::BoundaryRules},
    text::{JsString, JsValue},
};

#[test]
fn a_read_allowance_needs_a_driven_file_and_a_declared_decision_type() {
    let mut rules = BoundaryRules::parse(
        &JsValue::parse(
            r#"{
        "features":{"apps/api":["orders"]},
        "libraryTypes":{"kernel":{"imports":[],"pure":true}},
        "readAllowance":{"apps/api":{
            "driven":["src/orders/adapters/driven/db.ts"],"decidedBy":["missing"]
        }}
    }"#,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        declaration_issue(&rules).unwrap().unwrap(),
        "\"readAllowance\" names type \"missing\" in \"apps/api\", which \"libraryTypes\" (declared: kernel) lacks."
    );
    rules
        .read_allowance
        .get_mut(&JsString::from("apps/api"))
        .unwrap()
        .decided_by = Some(vec!["kernel".into()]);
    assert!(declaration_issue(&rules).unwrap().is_none());
}
