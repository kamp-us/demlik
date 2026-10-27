use demlik_code_graph::{
    schema::UnreachableCategory,
    text::JsString,
    unreachable::ledger::{
        UnreachableFinding, UnreachableLedgerEntry, UnreachableLedgerRead, finding_key,
        parse_unreachable_ledger, unreachable_ledger_of,
    },
};
use std::sync::Arc;

#[test]
fn unreachable_ledger_parsing_and_first_wins_keep_raw_identity_and_reason() {
    let UnreachableLedgerRead::Read { ledger } = parse_unreachable_ledger(
        &r#"{"entries":[{"scope":"app","kind":"dead","id":"src/a.ts:\ud800","reason":"kept"}]}"#
            .into(),
        &collation(),
    )
    .unwrap() else {
        panic!("source-valid ledger refused")
    };
    assert_eq!(ledger.entries[0].finding.id.units().last(), Some(&0xd800));
    assert_eq!(
        finding_key(&ledger.entries[0].finding),
        r#"["app","dead","src/a.ts:\ud800"]"#
    );
    let first = Arc::clone(&ledger.entries[0]);
    let second = Arc::new(UnreachableLedgerEntry {
        finding: UnreachableFinding {
            scope: "app".into(),
            kind: UnreachableCategory::Dead,
            id: first.finding.id.clone(),
        },
        reason: "replacement".into(),
    });
    let merged = unreachable_ledger_of(&[Arc::clone(&first), second], &collation()).unwrap();
    assert_eq!(merged.entries.len(), 1);
    assert!(Arc::ptr_eq(&first, &merged.entries[0]));
    assert_eq!(merged.entries[0].reason, JsString::from("kept"));
    let UnreachableLedgerRead::Invalid { message, .. } =
        parse_unreachable_ledger(&"{}".into(), &collation()).unwrap()
    else {
        panic!("missing required entries accepted")
    };
    assert_eq!(
        message,
        "entries: Invalid input: expected array, received undefined"
    );
}

#[test]
fn smell_schema_keeps_negative_zero_and_escaping_error_input_conversion() {
    use demlik_code_graph::smells::ledger::{SmellLedgerRead, parse_smell_ledger};
    let SmellLedgerRead::Read { ledger } = parse_smell_ledger(
        &r#"{"entries":[{"rule":"big-file","target":"a","value":-0,"reason":"kept"}]}"#.into(),
        &collation(),
    )
    .unwrap() else {
        panic!("source-valid negative zero refused")
    };
    assert!(ledger.entries[0].finding.value.is_sign_negative());
    assert!(ledger.gated.is_empty());
    let error = parse_smell_ledger(
        &r#"{"gated":["bad",{"toString":null}]}"#.into(),
        &collation(),
    )
    .unwrap_err();
    assert_eq!(error.name(), "TypeError");
    assert_eq!(error.message(), "Cannot convert object to primitive value");
}

#[test]
fn unreachable_flag_refusal_precedes_any_ledger_path_access() {
    use demlik_code_graph::unreachable::gate::{
        UnreachableOpts, UnreachablePreparation, prepare_unreachable_gate,
    };
    let preparation = prepare_unreachable_gate(
        UnreachableOpts {
            accept_dead: true,
            ..Default::default()
        },
        &"/unused".into(),
        &JsString::from_units(vec![0]),
        &collation(),
    )
    .unwrap();
    let UnreachablePreparation::Refused { message, source } = preparation else {
        panic!("invalid flags accepted")
    };
    assert_eq!(
        message,
        "--accept-dead only rides --unreachable; nothing was written."
    );
    assert!(source.is_none());
}

#[test]
fn smell_mode_conflict_is_reported_before_ledger_access() {
    use demlik_code_graph::smells::gate::{
        SmellGateOpts, SmellPreparation, prepare_smell_gate, smell_gate_needs_edges,
    };
    let reason = JsString::from("kept");
    let result = prepare_smell_gate(
        SmellGateOpts {
            accept_smells: true,
            layers: true,
            reason: Some(&reason),
            ..Default::default()
        },
        &"/unused".into(),
        &JsString::from_units(vec![0]),
        &collation(),
    )
    .unwrap();
    let SmellPreparation::Refused { message, source } = result else {
        panic!("conflicting modes accepted")
    };
    assert!(message.starts_with("--accept-smells runs on its own"));
    assert!(source.is_none());
    assert!(!smell_gate_needs_edges(&SmellPreparation::None));
}

#[test]
fn the_post_hexagon_stage_refuses_the_first_invalid_ledger_before_layer_work() {
    use demlik_code_graph::{
        cli::{
            frontdoor::{
                ApiDispatch, GatePreflightDispatch, HexagonDispatch, Preparation, prepare_cli,
            },
            io::CliIo,
        },
        engine::tsgo::TsgoBinary,
    };
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = loop {
        let path = std::env::temp_dir().join(format!(
            "demlik-ledger-preflight-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&path) {
            Ok(()) => break fs::canonicalize(path).unwrap(),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => panic!("fixture: {e}"),
        }
    };
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Err(error) = std::fs::remove_dir_all(&self.0)
                && !std::thread::panicking()
            {
                panic!("fixture cleanup: {error}");
            }
        }
    }
    let fixture = Fixture(root);
    let root = &fixture.0;
    let app = root.join("packages/app");
    fs::create_dir_all(&app).unwrap();
    fs::write(root.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
    fs::write(root.join("unreachable-ledger.json"), "{bad").unwrap();
    fs::write(root.join("smell-ledger.json"), "{bad").unwrap();
    let argv = [
        JsString::from(app.to_string_lossy().as_ref()),
        "--layers".into(),
        "--unreachable".into(),
        "--ci".into(),
        "--layer-rules=missing.json".into(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let Preparation::Prepared(prepared) = prepare_cli(&argv, None, &mut host).unwrap() else {
        panic!("valid path refused")
    };
    let ApiDispatch::Continue(prepared) = prepared
        .dispatch_api_blocking(&TsgoBinary::pinned("/missing/unused/compiler"), &mut host)
        .unwrap()
    else {
        panic!("API active")
    };
    let HexagonDispatch::Continue(prepared) = prepared.dispatch_hexagon(&mut host).unwrap() else {
        panic!("hexagon active")
    };
    let outcome = prepared.prepare_gates(&mut host);
    let ledger = fs::read_to_string(root.join("unreachable-ledger.json")).unwrap();
    assert!(matches!(
        outcome.unwrap(),
        GatePreflightDispatch::Stopped(_)
    ));
    assert_eq!(host.normal_exit_code(), 2);
    drop(host);
    assert!(stdout.is_empty());
    assert_eq!(ledger, "{bad");
    let stderr = String::from_utf8(stderr).unwrap();
    assert!(stderr.starts_with("code-graph: invalid unreachable ledger \""));
    assert!(stderr.ends_with(": not valid JSON; nothing was written.\n"));
}

fn collation() -> demlik_code_graph::project::Collation {
    demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
}
