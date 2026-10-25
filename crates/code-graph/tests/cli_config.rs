use demlik_code_graph::{
    collapse::settings::CollapseSettings,
    config::{
        ConfigResolution, resolve_collapse_settings, resolve_node_kind_rules, resolve_thresholds,
        with_entry_presets,
    },
    kinds::presets::EntryExportPresetName,
    text::{JsString, JsValue},
};

#[test]
fn frontdoor_defaults_and_repeated_entry_presets_share_canonical_models() {
    let ConfigResolution::Resolved(thresholds) = resolve_thresholds(None) else {
        panic!("defaults refused")
    };
    assert_eq!(thresholds.long_function_loc, 60);
    assert_eq!(thresholds.cross_boundary_imports, 0);
    let ConfigResolution::Resolved(settings) = resolve_collapse_settings(None) else {
        panic!("defaults refused")
    };
    assert_eq!(settings.min_signals, 2.0);
    assert_eq!(settings.shape_loc_ratio, 0.2);
    assert_eq!(settings.partial_max_block_size, 40.0);
    let ConfigResolution::Resolved(rules) = resolve_node_kind_rules(None).unwrap() else {
        panic!("defaults refused")
    };
    let ConfigResolution::Resolved(rules) =
        with_entry_presets(rules, &["nextjs".into(), "nextjs".into()])
    else {
        panic!("known presets refused")
    };
    assert_eq!(rules.entry_export_presets, [EntryExportPresetName::Nextjs]);
    let raw = JsString::from_units(vec![114, 97, 119, 0xd800]);
    let ConfigResolution::Refused { message } =
        with_entry_presets(rules, std::slice::from_ref(&raw))
    else {
        panic!("unknown preset accepted")
    };
    let mut expected = JsString::from("unknown --entry-preset \"");
    expected.extend(&raw);
    expected.push_str("\"; expected one of: nextjs.");
    assert_eq!(message, expected);
}

#[test]
fn collapse_settings_retain_large_real_weights_signed_zero_and_first_integer_issue() {
    let settings = CollapseSettings::parse(
        &JsValue::parse(r#"{"costCallerWeight":1e100,"shapeLocRatio":-0,"partialMinPrefix":2}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(settings.cost_caller_weight, 1e100);
    assert_eq!(settings.shape_loc_ratio, 0.0);
    assert!(settings.shape_loc_ratio.is_sign_negative());
    assert_eq!(settings.partial_min_prefix, 2.0);
    let issue = CollapseSettings::parse(
        &JsValue::parse(r#"{"minSignals":9007199254740992,"minLoc":-1,"extra":true}"#).unwrap(),
    )
    .unwrap_err();
    assert_eq!(
        issue.path(),
        &[demlik_code_graph::validation::PathSegment::Field(
            "minSignals".into()
        )]
    );
    assert_eq!(
        issue.message(),
        "Too big: expected int to be <9007199254740991"
    );
    assert_eq!(
        issue.details().get(&JsString::from("origin")).unwrap(),
        &JsValue::String("int".into())
    );
}

#[test]
fn preset_application_keeps_unmodified_rule_storage_and_deduplicates_typed_presets() {
    let ConfigResolution::Resolved(mut rules) = resolve_node_kind_rules(None).unwrap() else {
        panic!("defaults refused")
    };
    rules
        .entry_export_presets
        .push(EntryExportPresetName::Nextjs);
    let group = rules.entry_names.values().next().unwrap().as_ptr();
    let ConfigResolution::Resolved(applied) = with_entry_presets(rules, &[]) else {
        panic!("empty names refused")
    };
    assert_eq!(applied.entry_names.values().next().unwrap().as_ptr(), group);
    assert_eq!(
        applied.entry_export_presets,
        [EntryExportPresetName::Nextjs]
    );
}
