use demlik_code_graph::{
    boundaries::{
        ledger::{BoundaryKind, BoundaryLedger, BoundaryLedgerEntry},
        libraries::census::LibraryCensus,
        migrate::{Migration, ScopeCountCeilings, migrated_ledger},
        reconcile::{reconcile, with_accepted},
        render::{
            Censuses, render_accepted, render_boundaries, render_ledger_gate, render_migrated,
            render_migration_refused,
        },
        violation::{BoundaryViolation, False, ScopeBoundaryReport, WriteSite},
    },
    text::JsString,
};
use std::sync::Arc;

#[test]
fn a_run_with_no_scopes_distinguishes_unrequested_and_requested_empty_libraries() {
    let under = JsString::from("services/api");
    let empty = LibraryCensus {
        types: Default::default(),
        undeclared: vec![],
        unjudged_imports: 0.0,
    };
    assert_eq!(
        render_boundaries(&[], &under, Censuses::default(), false, false).unwrap(),
        JsString::from(
            "boundaries: no feature scope declared at or under \"services/api\" — nothing to check."
        )
    );
    assert_eq!(
        render_boundaries(
            &[],
            &under,
            Censuses {
                libraries: Some(&empty),
                deployables: None
            },
            false,
            true
        )
        .unwrap(),
        JsString::from(
            "boundaries: no feature or library scope declared at or under \"services/api\" — nothing to check."
        )
    );
}

#[test]
fn census_counters_render_as_javascript_numbers() {
    use demlik_code_graph::boundaries::deployables::census::{DeployableCensus, WorkerCensus};
    let count = 1_234_567_890_123_456_768_u64 as f64;
    let library = LibraryCensus {
        types: Default::default(),
        undeclared: vec![],
        unjudged_imports: count,
    };
    let deployables = DeployableCensus {
        workers: vec![WorkerCensus {
            worker: "api".into(),
            files: vec![],
            bindings: [(JsString::from("DB"), count)].into_iter().collect(),
            sites: vec![],
        }],
        unresolved_service_bindings: count,
    };
    let reports = [ScopeBoundaryReport {
        scope: ".".into(),
        features: vec![],
        files_scanned: 0.0,
        violations: vec![],
        workers: None,
    }];
    let rendered = render_boundaries(
        &reports,
        &".".into(),
        Censuses {
            libraries: Some(&library),
            deployables: Some(&deployables),
        },
        false,
        false,
    )
    .unwrap()
    .to_utf8()
    .unwrap();
    assert!(rendered.ends_with(concat!(
        "libraries: 0 declared (no type), 0 undeclared, 1234567890123456800 imports left unjudged\n",
        "deployables: 1 worker using bindings, 0 sites, 1234567890123456800 service bindings to a worker with no config in the repo\n",
        "  api: 0 sites in 0 files over 1 binding (DB 1234567890123456800)"
    )), "{rendered}");
}

#[test]
fn opaque_number_facts_preserve_the_source_numeric_domain() {
    use demlik_code_graph::boundaries::{
        deployables::census::{DeployableCensus, WorkerCensus},
        migrate::CeilingBreach,
        reconcile::Reconciliation,
    };
    for (value, text) in [
        (-1.0, "-1"),
        (-0.0, "0"),
        (0.5, "0.5"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
        (f64::NEG_INFINITY, "-Infinity"),
        (18_446_744_073_709_551_616.0, "18446744073709552000"),
        (1e21, "1e+21"),
    ] {
        let library = LibraryCensus {
            types: Default::default(),
            undeclared: vec![],
            unjudged_imports: value,
        };
        let deployables = DeployableCensus {
            workers: vec![WorkerCensus {
                worker: "api".into(),
                files: vec![],
                bindings: [(JsString::from("DB"), value)].into_iter().collect(),
                sites: vec![],
            }],
            unresolved_service_bindings: value,
        };
        let result = Reconciliation {
            scopes_checked: value,
            unrecorded: vec![],
            pruned: vec![],
            kept: BoundaryLedger { entries: vec![] },
            writes: Default::default(),
        };
        let reports = [ScopeBoundaryReport {
            scope: ".".into(),
            features: vec![],
            files_scanned: 0.0,
            violations: vec![],
            workers: None,
        }];
        let rendered = render_boundaries(
            &reports,
            &".".into(),
            Censuses {
                libraries: Some(&library),
                deployables: Some(&deployables),
            },
            false,
            false,
        )
        .unwrap()
        .to_utf8()
        .unwrap();
        assert!(
            rendered.contains(&format!("{text} imports left unjudged")),
            "{rendered}"
        );
        assert!(
            rendered.contains(&format!("{text} service bindings")),
            "{rendered}"
        );
        assert!(rendered.contains(&format!("DB {text}")), "{rendered}");
        assert_eq!(
            render_ledger_gate(&result, false, false).unwrap().stdout,
            JsString::from(format!(
                "boundary ledger: PASS — {text} scope(s), 0 recorded crossing(s), none new."
            ))
        );
        let refusal = render_migration_refused(&[CeilingBreach {
            scope: "api".into(),
            measured: value,
            ceiling: 0.0,
        }]);
        assert!(
            refusal
                .to_utf8()
                .unwrap()
                .contains(&format!("api: {text} crossing(s)"))
        );
        if !value.is_finite() {
            let json = render_ledger_gate(&result, true, false).unwrap();
            assert!(
                json.stdout
                    .to_utf8()
                    .unwrap()
                    .contains("\"scopesChecked\":null")
            );
            assert!(
                serde_json::to_string(&library)
                    .unwrap()
                    .contains("\"unjudgedImports\":null")
            );
        }
    }
}

#[test]
fn real_reconciliation_and_migration_facts_render_new_accepted_pruned_and_refused_runs() {
    let reports = vec![
        ScopeBoundaryReport {
            scope: "services/api".into(),
            features: vec!["orders".into()],
            files_scanned: 2.0,
            workers: None,
            violations: vec![
                BoundaryViolation::DrivingReachesDriven {
                    from: "services/api/src/orders/adapters/driving/http.ts".into(),
                    to: "services/api/src/orders/adapters/driven/read.ts".into(),
                    specifier: "../driven/read".into(),
                    type_only: true,
                    feature: "orders".into(),
                    write: Some(Arc::new(WriteSite {
                        file: "services/api/src/orders/adapters/driven/read.ts".into(),
                        line: 2.0,
                        binding: "DB".into(),
                    })),
                },
                BoundaryViolation::Impure {
                    from: "services/api/src/orders/application/use.ts".into(),
                    to: (),
                    specifier: "Date.now".into(),
                    type_only: false,
                },
            ],
        },
        ScopeBoundaryReport {
            scope: "packages/core".into(),
            features: vec![],
            files_scanned: 1.0,
            workers: None,
            violations: vec![BoundaryViolation::IndexNotExportsOnly {
                from: "packages/core/src/index.ts".into(),
                to: (),
                specifier: "declaration".into(),
                type_only: False,
            }],
        },
        ScopeBoundaryReport {
            scope: "workers".into(),
            features: vec![],
            files_scanned: 0.0,
            workers: Some(vec![]),
            violations: vec![],
        },
    ];
    let old = Arc::new(BoundaryLedgerEntry {
        scope: "services/api".into(),
        kind: BoundaryKind::LibImportsFeature,
        from: "services/api/src/lib/old.ts".into(),
        to: Some("services/api/src/orders/index.ts".into()),
        specifier: "../orders".into(),
        reason: Some("old".into()),
    });
    let ledger = BoundaryLedger { entries: vec![old] };
    let found = reconcile(
        &ledger,
        &reports,
        &".".into(),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let gate = render_ledger_gate(&found, false, false).unwrap();
    assert_eq!(gate.exit_code, 1);
    let stdout = gate.stdout.to_utf8().unwrap();
    assert!(
        stdout.starts_with("BOUNDARY LEDGER FAILED — 3 crossing(s) not in boundary-ledger.json:\n")
    );
    assert!(stdout.contains("[write: DB at services/api/src/orders/adapters/driven/read.ts:2]"));
    assert!(stdout.contains("pruned 1 boundary-ledger.json entry whose crossing is gone:"));
    assert!(!stdout.contains("[type-only]"));
    let reason = JsString::from("reviewed");
    let accepted = render_accepted(&found, &reason, false, false)
        .unwrap()
        .to_utf8()
        .unwrap();
    assert!(
        accepted.starts_with(
            "accepted 3 crossing(s) into boundary-ledger.json, reason \"reviewed\":\n"
        )
    );
    let seeded = with_accepted(
        &found.kept,
        &found.unrecorded,
        &reason,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let repeated = reconcile(
        &seeded,
        &reports,
        &".".into(),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let pass = render_ledger_gate(&repeated, false, true).unwrap();
    assert_eq!(pass.exit_code, 0);
    assert_eq!(
        pass.stdout,
        JsString::from("boundary ledger: PASS — 3 scope(s), 3 recorded crossing(s), none new.")
    );
    let human = render_boundaries(&reports, &".".into(), Censuses::default(), false, false)
        .unwrap()
        .to_utf8()
        .unwrap();
    assert!(human.contains("workers — worker call graph\n  0 worker(s) — 0 violation(s)"));
    assert!(human.contains("[type-only]  [write: DB"));
    let Migration::Refused { breaches } = migrated_ledger(
        &reports,
        &ScopeCountCeilings::default(),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap() else {
        panic!("ceiling did not refuse")
    };
    let refusal = render_migration_refused(&breaches).to_utf8().unwrap();
    assert!(refusal.contains("services/api: 1 crossing(s) against a recorded ceiling of 0"));
    let Migration::Migrated { ledger } = migrated_ledger(
        &reports,
        &ScopeCountCeilings {
            default: 1.0,
            scopes: Default::default(),
        },
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap() else {
        panic!("within ceiling refused")
    };
    assert_eq!(
        render_migrated(&ledger, 3.0, false, false).unwrap(),
        JsString::from(
            "migrated 3 scope(s): seeded boundary-ledger.json with 3 crossing(s) and removed boundary-ceilings.json."
        )
    );
}
