use demlik_code_graph::{
    boundaries::ledger::{
        BoundaryKind, BoundaryLedgerEntry, boundary_ledger_of, rekey_boundary_ledger,
    },
    layers::{
        analyze::{LayerCensus, LayerEdge, LayerReport},
        reconcile::reconcile,
    },
    project::Collation,
    ratchet::scope_count::scopes_under,
    text::JsString,
};
use std::sync::Arc;

#[test]
fn canonical_gate_order_retains_selected_owners_and_rekey_remints_even_without_moves() {
    let raw = |unit| {
        Arc::new(BoundaryLedgerEntry {
            scope: "app".into(),
            kind: BoundaryKind::Impure,
            from: JsString::from_units(vec![unit]),
            to: None,
            specifier: "fetch".into(),
            reason: None,
        })
    };
    let entries = [raw(0xe000), raw(0xdfff), raw(0xd800)];
    let (held, moved) = {
        let collation = Collation::try_node22_en_us().unwrap();
        let ledger = boundary_ledger_of(&entries, &collation).unwrap();
        let moved = rekey_boundary_ledger(&ledger, &[], &collation).unwrap();
        (ledger, moved)
    };
    assert_eq!(
        held.entries
            .iter()
            .map(|entry| entry.from.units()[0])
            .collect::<Vec<_>>(),
        [0xd800, 0xdfff, 0xe000]
    );
    for (i, original) in [2, 1, 0].into_iter().enumerate() {
        assert!(Arc::ptr_eq(&held.entries[i], &entries[original]));
        assert!(!Arc::ptr_eq(&moved.entries[i], &held.entries[i]));
        assert_eq!(&*moved.entries[i], &*held.entries[i]);
    }
}

#[test]
fn borrowed_reconciliation_outlives_collation_and_keeps_canonical_equivalence_ties_stable() {
    let edge = |from: JsString| LayerEdge {
        from,
        from_line: 2,
        from_layer: "a".into(),
        to: "target".into(),
        to_line: 1,
        to_layer: "b".into(),
        specifier: "./target".into(),
        type_only: false,
    };
    let report = LayerReport {
        layers: vec![],
        files_scanned: 5,
        census: LayerCensus::default(),
        unresolved: vec![],
        violations: vec![
            edge("é".into()),
            edge("e\u{301}".into()),
            edge("file2".into()),
            edge("file10".into()),
        ],
    };
    let result = {
        let collation = Collation::try_node22_en_us().unwrap();
        reconcile(&report, &[], &collation).unwrap()
    };
    assert_eq!(
        result
            .undeclared
            .iter()
            .map(|edge| edge.from.to_lossy())
            .collect::<Vec<_>>(),
        ["é", "e\u{301}", "file10", "file2"]
    );
    assert!(std::ptr::eq(result.undeclared[0], &report.violations[0]));
    assert!(std::ptr::eq(result.undeclared[1], &report.violations[1]));
}

#[test]
fn checked_scope_selection_keeps_slash_membership_and_original_input_order() {
    let scopes = ["app/2", "apps", "app/10", "app", "app/é", "app/e\u{301}"].map(JsString::from);
    let result = {
        let collation = Collation::try_node22_en_us().unwrap();
        scopes_under(&scopes, &"app".into(), &collation).unwrap()
    };
    assert_eq!(
        result.iter().map(JsString::to_lossy).collect::<Vec<_>>(),
        ["app", "app/10", "app/2", "app/é", "app/e\u{301}"]
    );
    assert_eq!(scopes[0], "app/2");
    assert_eq!(scopes[1], "apps");
}
