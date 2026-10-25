use demlik_code_graph::boundaries::rules::*;
#[test]
fn a_port_scope_owns_one_hexagon_and_opens_its_ports_to_outside_callers() {
    let mut rules = BoundaryRules::default();
    rules.features.insert(
        "apps/api".into(),
        ["application", "driving-adapters", "driven-adapters"]
            .into_iter()
            .map(Into::into)
            .collect(),
    );
    let zoning = scope_zoning(&rules, &"apps/api".into()).unwrap();
    let FeatureFile::Port { feature, zone } =
        feature_file_of(&"src/application/driven-ports/database.ts".into(), &zoning).unwrap()
    else {
        panic!("port layout was not selected")
    };
    assert_eq!(feature, "apps/api");
    assert_eq!(zone.name, PortZoneName::Ports);
    assert!(zone.rule.open_to_outside);
    assert!(!zone.rule.may_be_impure);
    assert!(
        layout_issue(
            &"apps/api".into(),
            &rules.features[&demlik_code_graph::text::JsString::from("apps/api")]
        )
        .is_none()
    );
}
#[test]
fn feature_zones_keep_shared_rule_identity_and_unknown_adapter_entry_ownership() {
    let mut rules = BoundaryRules::default();
    rules.features.insert(".".into(), vec!["orders".into()]);
    let zoning = scope_zoning(&rules, &".".into()).unwrap();
    let FeatureFile::PerFeature { zone: first, .. } =
        feature_file_of(&"src/orders/application/place.ts".into(), &zoning).unwrap()
    else {
        panic!("feature layout missing")
    };
    let FeatureFile::PerFeature { zone: second, .. } =
        feature_file_of(&"src/orders/application/cancel.ts".into(), &zoning).unwrap()
    else {
        panic!("feature layout missing")
    };
    assert!(std::ptr::eq(first.rule, second.rule));
    assert_eq!(
        first.rule.imports,
        Some(ZoneImport::ApplicationImportsAdapter)
    );
    let FeatureFile::PerFeature { zone, .. } =
        feature_file_of(&"src/orders/adapters/shared/helper.ts".into(), &zoning).unwrap()
    else {
        panic!("unknown adapter missing")
    };
    assert_eq!(zone.entry, "adapters/shared");
    assert_eq!(zone.name, ZoneName::Unknown);
    assert!(zone.adapter);
}
