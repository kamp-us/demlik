use demlik_code_graph::{boundaries::ledger::*, text::JsString};
use std::{fs, sync::Arc};

fn entry(from: &str, to: Option<&str>, reason: Option<&str>) -> Arc<BoundaryLedgerEntry> {
    Arc::new(BoundaryLedgerEntry {
        scope: "app".into(),
        kind: BoundaryKind::Impure,
        from: from.into(),
        to: to.map(JsString::from),
        specifier: "world".into(),
        reason: reason.map(JsString::from),
    })
}

#[test]
fn collision_identity_ignores_display_specifier_and_keeps_the_first_reason_owner() {
    let first = entry("a.ts", Some("b.ts"), None);
    let reason = entry("a.ts", Some("b.ts"), Some("pending extraction"));
    let later = entry("a.ts", Some("b.ts"), Some("later reason"));
    let ledger = boundary_ledger_of(&[first, Arc::clone(&reason), later]);
    assert_eq!(ledger.entries.len(), 1);
    assert!(Arc::ptr_eq(&ledger.entries[0], &reason));
    assert_eq!(
        ledger_key(&reason),
        "[\"app\",\"impure\",\"a.ts\",\"b.ts\"]"
    );
}

#[test]
fn external_ledger_parsing_refuses_duplicates_unknown_fields_and_invalid_null_targets() {
    assert!(
        matches!(parse_boundary_ledger("{}"), LedgerRead::Read { ledger } if ledger.entries.is_empty())
    );
    assert!(matches!(
        parse_boundary_ledger("{"),
        LedgerRead::Invalid { .. }
    ));
    assert!(matches!(
        parse_boundary_ledger(
            r#"{"entries":[{"scope":"app","kind":"cross-feature","from":"a","to":null,"specifier":"b"}]}"#
        ),
        LedgerRead::Invalid { .. }
    ));
    let item = r#"{"scope":"app","kind":"impure","from":"a","to":null,"specifier":"fs"}"#;
    assert!(
        matches!(parse_boundary_ledger(&format!("{{\"entries\":[{item},{item}]}}")), LedgerRead::Invalid { message } if message.to_lossy().starts_with("entries.1: duplicate entry"))
    );
}

#[test]
fn a_move_rekeys_the_real_file_and_keeps_bare_targets_and_invalid_bytes_untouched() {
    let root = std::env::temp_dir().join(format!("demlik-ledger-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let file = root.join("boundary-ledger.json");
    let ledger = boundary_ledger_of(&[
        entry("a.ts", Some("b.ts"), Some("why")),
        entry("bare.ts", None, None),
    ]);
    write_boundary_ledger(&file, &ledger).unwrap();
    let result = rekey_boundary_ledger_file(
        &file,
        &[FileMove {
            from: "b.ts".into(),
            to: "moved.ts".into(),
        }],
    )
    .unwrap();
    assert!(matches!(result, LedgerFileRekey::Rekeyed { entries: 1 }));
    let LedgerRead::Read { ledger } = read_boundary_ledger(&file).unwrap() else {
        panic!("saved ledger was not readable")
    };
    assert_eq!(ledger.entries[0].to.as_ref().unwrap(), "moved.ts");
    assert_eq!(ledger.entries[1].to, None);
    fs::write(&file, b"{").unwrap();
    assert!(matches!(
        rekey_boundary_ledger_file(&file, &[]).unwrap(),
        LedgerFileRekey::Invalid { .. }
    ));
    assert_eq!(fs::read(&file).unwrap(), b"{");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ledger_strings_keep_unpaired_code_units_across_the_json_file_boundary() {
    let LedgerRead::Read { ledger } = parse_boundary_ledger(
        r#"{"entries":[{"scope":"app","kind":"impure","from":"\ud800","to":null,"specifier":"fs"}]}"#,
    ) else {
        panic!("valid UTF16 ledger was rejected")
    };
    assert_eq!(ledger.entries[0].from.units(), &[0xd800]);
    let json = serialize_boundary_ledger(&ledger);
    assert!(json.contains(r#""from": "\ud800""#));
    assert!(
        matches!(parse_boundary_ledger(&json), LedgerRead::Read { ledger: restored } if restored == ledger)
    );
}
