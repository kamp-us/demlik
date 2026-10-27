use demlik_code_graph::{
    boundaries::{
        ledger::{BoundaryKind, BoundaryLedger, BoundaryLedgerEntry},
        reconcile::*,
        violation::{BoundaryViolation, False, ScopeBoundaryReport, WriteSite},
    },
    text::JsString,
};
use std::sync::Arc;

#[test]
fn checking_one_scope_preserves_original_owners_outside_it_and_last_write_diagnostics() {
    let held = Arc::new(BoundaryLedgerEntry {
        scope: "apps/other".into(),
        kind: BoundaryKind::Impure,
        from: "a".into(),
        to: None,
        specifier: "fetch".into(),
        reason: Some("keep".into()),
    });
    let write = Arc::new(WriteSite {
        file: "apps/api/driven.ts".into(),
        line: 7.0,
        binding: "DB".into(),
    });
    let report = ScopeBoundaryReport {
        scope: "apps/api".into(),
        features: vec![],
        files_scanned: 1.0,
        workers: None,
        violations: vec![BoundaryViolation::DrivingReachesDriven {
            from: "driving.ts".into(),
            to: "driven.ts".into(),
            specifier: "./driven".into(),
            type_only: false,
            feature: "api".into(),
            write: Some(Arc::clone(&write)),
        }],
    };
    let ledger = BoundaryLedger {
        entries: vec![Arc::clone(&held)],
    };
    let result = reconcile(
        &ledger,
        &[report],
        &"apps/api".into(),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert!(Arc::ptr_eq(&result.kept.entries[0], &held));
    assert!(Arc::ptr_eq(result.writes.values().next().unwrap(), &write));
    assert_eq!(result.unrecorded.len(), 1);
    assert!(result.pruned.is_empty());
}

#[test]
fn tagged_boundary_data_retains_raw_utf16_and_refuses_a_nonliteral_boolean() {
    let raw = r#"{"kind":"unknown-zone","from":"\ud800","to":null,"specifier":"x","feature":"f","typeOnly":false}"#;
    let violation: BoundaryViolation = serde_json::from_str(raw).unwrap();
    let entry = entry_of("app", &violation);
    assert_eq!(entry.from.units(), &[0xd800]);
    assert!(
        serde_json::to_string(&violation)
            .unwrap()
            .contains(r#"\ud800"#)
    );
    assert!(serde_json::from_str::<BoundaryViolation>(&raw.replace("false", "true")).is_err());
    let _native = BoundaryViolation::UnknownZone {
        from: JsString::from_units(vec![0xd800]),
        to: (),
        specifier: "x".into(),
        feature: "f".into(),
        type_only: False,
    };
}
