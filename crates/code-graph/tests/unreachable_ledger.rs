use demlik_code_graph::{
    extract::assemble::{NodeFields, assemble_graph},
    project::load_cheap_project,
    schema::{
        Graph, ReachabilityReport, Thresholds, UnreachableCategory as Kind, UnreachableSymbol,
    },
    text::JsString,
    unreachable::{
        gate::{
            PreparedUnreachableGate, UnreachableMode, UnreachableOutput, UnreachableRunError,
            run_unreachable_gate,
        },
        ledger::{
            UnreachableFinding, UnreachableLedger, UnreachableLedgerEntry, UnreachableWriteError,
            reconcile_unreachable, serialize_unreachable_ledger, unreachable_ledger_of,
            with_accepted_findings,
        },
        render::render_unreachable_gate,
    },
};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    fs,
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-unreachable-native-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    fs::write(path.join("tsconfig.json"), "{\"include\":[\"*.ts\"]}").unwrap();
                    return Self(fs::canonicalize(path).unwrap());
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => panic!("create fixture:{e}"),
            }
        }
    }
    fn graph(&self, symbols: Option<Vec<UnreachableSymbol>>) -> Graph {
        let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
        let loaded = load_cheap_project(&self.0, None, &project_collation).unwrap();
        let mut graph = assemble_graph(
            &loaded,
            Thresholds::default(),
            NodeFields::default(),
            &project_collation,
        )
        .unwrap();
        graph.reachability = symbols.map(|unreachable| ReachabilityReport {
            entry_count: 0,
            exported_count: unreachable.len(),
            reachable_count: 0,
            unreachable,
            withheld: vec![],
            unguarded: vec![],
        });
        graph
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove fixture:{e}");
        }
    }
}
fn finding(scope: &str, kind: Kind, id: &str) -> UnreachableFinding {
    UnreachableFinding {
        scope: scope.into(),
        kind,
        id: id.into(),
    }
}
fn entry(scope: &str, kind: Kind, id: &str, reason: &str) -> Arc<UnreachableLedgerEntry> {
    Arc::new(UnreachableLedgerEntry {
        finding: finding(scope, kind, id),
        reason: reason.into(),
    })
}
fn symbol(kind: Kind, id: &str) -> UnreachableSymbol {
    UnreachableSymbol {
        id: id.into(),
        file: "src/x.ts".into(),
        start_line: 1,
        category: kind,
        test_references: vec![],
    }
}
#[test]
fn reconciliation_borrows_duplicate_foreign_findings_and_only_prunes_exact_scope_and_kind() {
    let kept = entry("app", Kind::OnlyCalledFromTests, "gone", "test reason");
    let other = entry("app/child", Kind::Dead, "gone", "child reason");
    let gone = entry("app", Kind::Dead, "gone", "old reason");
    let ledger = UnreachableLedger {
        entries: vec![Arc::clone(&gone), Arc::clone(&kept), Arc::clone(&other)],
    };
    let scope = JsString::from("app");
    let gated = [Kind::Dead];
    let findings = [
        finding("foreign", Kind::Dead, "new"),
        finding("foreign", Kind::Dead, "new"),
        finding("app", Kind::OnlyCalledFromTests, "ignored"),
    ];
    let result = reconcile_unreachable(&ledger, &scope, &findings, &gated, &collation()).unwrap();
    assert_eq!(result.unrecorded.len(), 2);
    assert!(std::ptr::eq(result.unrecorded[0], &findings[0]));
    assert!(std::ptr::eq(result.unrecorded[1], &findings[1]));
    assert_eq!(result.pruned.len(), 1);
    assert!(Arc::ptr_eq(&gone, &result.pruned[0]));
    assert_eq!(result.kept.entries.len(), 2);
    assert!(result.kept.entries.iter().any(|e| Arc::ptr_eq(e, &kept)));
    assert!(result.kept.entries.iter().any(|e| Arc::ptr_eq(e, &other)));
}
#[test]
fn accepted_merge_keeps_the_original_reason_owner_and_stable_serialized_lf() {
    let old = entry("a", Kind::Dead, "x", "first");
    let ledger = UnreachableLedger {
        entries: vec![Arc::clone(&old)],
    };
    let found = [finding("a", Kind::Dead, "x"), finding("a", Kind::Dead, "y")];
    let next = with_accepted_findings(
        &ledger,
        &found.iter().collect::<Vec<_>>(),
        &"second".into(),
        &collation(),
    )
    .unwrap();
    assert!(Arc::ptr_eq(&next.entries[0], &old));
    assert_eq!(next.entries[0].reason, "first");
    assert_eq!(next.entries[1].reason, "second");
    assert_eq!(
        serialize_unreachable_ledger(&next, &collation()).unwrap(),
        "{\n  \"entries\": [\n    {\n      \"id\": \"x\",\n      \"kind\": \"dead\",\n      \"reason\": \"first\",\n      \"scope\": \"a\"\n    },\n    {\n      \"id\": \"y\",\n      \"kind\": \"dead\",\n      \"reason\": \"second\",\n      \"scope\": \"a\"\n    }\n  ]\n}\n"
    );
}
#[test]
fn human_output_keeps_lone_units_before_host_encoding() {
    let scope = JsString::from_units(vec![0xd800]);
    let gated = [Kind::Dead];
    let findings = [UnreachableFinding {
        scope: scope.clone(),
        kind: Kind::Dead,
        id: JsString::from_units(vec![0xdfff]),
    }];
    let ledger = UnreachableLedger::default();
    let result = reconcile_unreachable(&ledger, &scope, &findings, &gated, &collation()).unwrap();
    let rendered = render_unreachable_gate(&result, false, false).unwrap();
    assert!(rendered.stdout.units().contains(&0xd800));
    assert!(rendered.stdout.units().contains(&0xdfff));
    let wire = serde_json::to_string(&rendered).unwrap();
    assert!(wire.contains("\\ud800"));
    assert!(wire.contains("\\udfff"));
    assert!(serde_json::from_str::<serde_json::Value>(&wire).is_err());
}
#[test]
fn missing_reachability_preserves_borrowed_report_error_and_never_writes_or_emits() {
    let f = Fixture::new();
    let graph = f.graph(None);
    let file = f.0.join("ledger.json");
    let scope = JsString::from("a");
    let gate = PreparedUnreachableGate {
        scope,
        file: file.to_string_lossy().as_ref().into(),
        mode: UnreachableMode::Gate {
            gated: vec![Kind::Dead],
        },
        ledger: UnreachableLedger::default(),
    };
    let original = Rc::new(Cell::new(17));
    let expected = Rc::clone(&original);
    let emit = Cell::new(0);
    let mut out = |_: &JsString| -> Result<(), Rc<Cell<i32>>> {
        emit.set(emit.get() + 1);
        Ok(())
    };
    let mut report = |line: &JsString| {
        assert_eq!(
            line,
            "the reachability pass did not run; the unreachable gate has nothing to read."
        );
        Err(Rc::clone(&original))
    };
    let result = run_unreachable_gate(
        &gate,
        &graph,
        UnreachableOutput {
            emit: &mut out,
            report: &mut report,
            json: false,
            pretty: false,
        },
        &collation(),
    );
    let Err(UnreachableRunError::Report(error)) = result else {
        panic!("report error must escape")
    };
    assert!(Rc::ptr_eq(&error, &expected));
    assert_eq!(emit.get(), 0);
    assert!(!file.exists());
}
#[test]
fn pruning_writes_before_original_emit_failure_and_keeps_other_scope() {
    let f = Fixture::new();
    let graph = f.graph(Some(vec![symbol(Kind::Dead, "fresh")]));
    let file = f.0.join("ledger.json");
    let gate = PreparedUnreachableGate {
        scope: "a".into(),
        file: file.to_string_lossy().as_ref().into(),
        mode: UnreachableMode::Gate {
            gated: vec![Kind::Dead],
        },
        ledger: unreachable_ledger_of(
            &[
                entry("a", Kind::Dead, "gone", "gone"),
                entry("b", Kind::Dead, "other", "kept"),
            ],
            &collation(),
        )
        .unwrap(),
    };
    let original = Rc::new(Cell::new(23));
    let expected = Rc::clone(&original);
    let seen = RefCell::new(vec![]);
    let mut emit = |_: &JsString| {
        seen.borrow_mut().push("emit");
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("other"));
        assert!(!text.contains("gone"));
        Err(Rc::clone(&original))
    };
    let mut report = |_: &JsString| -> Result<(), Rc<Cell<i32>>> { panic!("unexpected report") };
    let result = run_unreachable_gate(
        &gate,
        &graph,
        UnreachableOutput {
            emit: &mut emit,
            report: &mut report,
            json: true,
            pretty: true,
        },
        &collation(),
    );
    let Err(UnreachableRunError::Emit(error)) = result else {
        panic!("emit error must escape")
    };
    assert!(Rc::ptr_eq(&error, &expected));
    assert_eq!(*seen.borrow(), ["emit"]);
}
#[cfg(unix)]
#[test]
fn repeated_accept_succeeds_on_readonly_ledger_without_rewriting() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let graph = f.graph(Some(vec![symbol(Kind::OnlyCalledFromTests, "tested")]));
    let file = f.0.join("ledger.json");
    let old = entry("a", Kind::OnlyCalledFromTests, "tested", "old");
    let ledger = unreachable_ledger_of(&[old], &collation()).unwrap();
    let before = serialize_unreachable_ledger(&ledger, &collation()).unwrap();
    fs::write(&file, &before).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();
    let gate = PreparedUnreachableGate {
        scope: "a".into(),
        file: file.to_string_lossy().as_ref().into(),
        mode: UnreachableMode::Accept {
            reason: "new".into(),
        },
        ledger,
    };
    let mut emit = |_: &JsString| Ok::<(), Infallible>(());
    let mut report = |_: &JsString| Ok::<(), Infallible>(());
    assert_eq!(
        run_unreachable_gate(
            &gate,
            &graph,
            UnreachableOutput {
                emit: &mut emit,
                report: &mut report,
                json: false,
                pretty: false
            },
            &collation()
        )
        .unwrap(),
        0
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o444
    );
}
#[test]
fn actual_write_error_prevents_emit_and_retains_file_and_io_cause() {
    let f = Fixture::new();
    let graph = f.graph(Some(vec![symbol(Kind::Dead, "new")]));
    let file = f.0.join("missing/ledger.json");
    let gate = PreparedUnreachableGate {
        scope: "a".into(),
        file: file.to_string_lossy().as_ref().into(),
        mode: UnreachableMode::Accept { reason: "r".into() },
        ledger: UnreachableLedger::default(),
    };
    let emits = Cell::new(0);
    let mut emit = |_: &JsString| {
        emits.set(emits.get() + 1);
        Ok::<(), Infallible>(())
    };
    let mut report = |_: &JsString| Ok::<(), Infallible>(());
    let Err(UnreachableRunError::Write(UnreachableWriteError::Io {
        file: actual,
        source,
    })) = run_unreachable_gate(
        &gate,
        &graph,
        UnreachableOutput {
            emit: &mut emit,
            report: &mut report,
            json: false,
            pretty: false,
        },
        &collation(),
    )
    else {
        panic!("actual IO cause must escape")
    };
    assert_eq!(actual, gate.file);
    assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(emits.get(), 0);
    assert!(!file.exists());
}

fn collation() -> demlik_code_graph::project::Collation {
    demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
}
