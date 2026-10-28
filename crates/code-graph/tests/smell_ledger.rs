use demlik_code_graph::{
    cli::io::{CliIo, exit_with, output_to},
    extract::assemble::{NodeFields, assemble_graph},
    project::load_cheap_project,
    schema::{Graph, Severity, Smell, SmellKind as Kind, SmellTarget},
    smells::{
        gate::{PreparedSmellGate, SmellGateMode, run_smell_ledger_gate},
        ledger::{
            SmellFinding, SmellLedger, SmellLedgerEntry, reconcile_smells, repo_target,
            serialize_smell_ledger, with_accepted_smells,
        },
    },
    text::JsString,
};
use std::{
    cell::Cell,
    fs,
    io::Write,
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
        let path = std::env::temp_dir().join(format!(
            "demlik-smell-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("tsconfig.json"), "{}").unwrap();
        Self(path)
    }
    fn graph(&self) -> Graph {
        let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
        let loaded = load_cheap_project(&self.0, None, &project_collation).unwrap();
        assemble_graph(
            &loaded,
            Default::default(),
            NodeFields::default(),
            &project_collation,
        )
        .unwrap()
    }
    fn file(&self) -> JsString {
        self.0.join("ledger.json").to_string_lossy().as_ref().into()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn finding(rule: Kind, target: &str, value: f64) -> SmellFinding {
    SmellFinding {
        rule,
        target: target.into(),
        value,
    }
}
fn entry(rule: Kind, target: &str, value: f64, reason: &str) -> Arc<SmellLedgerEntry> {
    Arc::new(SmellLedgerEntry {
        finding: finding(rule, target, value),
        reason: reason.into(),
    })
}
fn smell(value: usize) -> Smell {
    Smell {
        kind: Kind::HighComplexity,
        target: SmellTarget::Function {
            id: "x.ts:calculate".into(),
            file: "x.ts".into(),
            start_line: 1,
        },
        value,
        threshold: 1,
        severity: Severity::Warn,
    }
}
#[test]
fn reconciliation_keeps_original_borrows_and_only_remints_measured_matches() {
    let same = entry(Kind::HighComplexity, "app/x", 3.0, "first");
    let unmeasured = entry(Kind::HighFanIn, "app/y", 4.0, "edges");
    let foreign = entry(Kind::HighComplexity, "application/z", 5.0, "foreign");
    let gone = entry(Kind::HighComplexity, "app/gone", 6.0, "gone");
    let ledger = SmellLedger {
        gated: vec![Kind::HighFanIn, Kind::HighComplexity],
        entries: vec![
            Arc::clone(&same),
            Arc::clone(&unmeasured),
            Arc::clone(&foreign),
            Arc::clone(&gone),
        ],
    };
    let scope = JsString::from("app");
    let findings = [
        finding(Kind::HighComplexity, "app/x", 3.0),
        finding(Kind::HighComplexity, "foreign/new", 2.0),
    ];
    let result = reconcile_smells(
        &ledger,
        &scope,
        &findings,
        &[Kind::HighComplexity],
        &collation(),
    )
    .unwrap();
    assert!(std::ptr::eq(result.gated, ledger.gated.as_slice()));
    assert!(std::ptr::eq(result.scope, &scope));
    assert!(std::ptr::eq(result.unrecorded[0], &findings[1]));
    assert!(Arc::ptr_eq(&result.pruned[0], &gone));
    assert!(
        result
            .kept
            .entries
            .iter()
            .any(|e| Arc::ptr_eq(e, &unmeasured))
    );
    assert!(result.kept.entries.iter().any(|e| Arc::ptr_eq(e, &foreign)));
    assert!(!result.kept.entries.iter().any(|e| Arc::ptr_eq(e, &same)));
    let accepted = with_accepted_smells(&result, &"new".into(), &collation()).unwrap();
    assert!(accepted.entries.iter().any(|e| Arc::ptr_eq(e, &unmeasured)));
}
#[test]
fn last_finding_keeps_first_map_position_and_accept_retains_first_reason() {
    let scope = JsString::from("app");
    let ledger = SmellLedger {
        gated: vec![Kind::HighComplexity],
        entries: vec![],
    };
    let findings = [
        finding(Kind::HighComplexity, "app/z", 2.0),
        finding(Kind::HighComplexity, "app/a", 3.0),
        finding(Kind::HighComplexity, "app/z", 7.0),
    ];
    let result = reconcile_smells(
        &ledger,
        &scope,
        &findings,
        &[Kind::HighComplexity],
        &collation(),
    )
    .unwrap();
    assert!(std::ptr::eq(result.unrecorded[0], &findings[2]));
    assert!(std::ptr::eq(result.unrecorded[1], &findings[1]));
    let first = entry(Kind::HighComplexity, "other/x", 2.0, "first");
    let raw = SmellLedger {
        gated: vec![Kind::HighComplexity],
        entries: vec![
            Arc::clone(&first),
            entry(Kind::HighComplexity, "other/x", 9.0, "second"),
        ],
    };
    let result =
        reconcile_smells(&raw, &scope, &[], &[Kind::HighComplexity], &collation()).unwrap();
    let accepted = with_accepted_smells(&result, &"replacement".into(), &collation()).unwrap();
    assert_eq!(accepted.entries.len(), 1);
    assert!(Arc::ptr_eq(&accepted.entries[0], &first));
}
#[test]
fn function_suffix_uses_utf16_length_even_when_the_prefix_does_not_match() {
    let mut s = smell(2);
    s.target = SmellTarget::Function {
        file: "a".into(),
        id: "𐀀:x".into(),
        start_line: 900,
    };
    let actual = repo_target(&"app".into(), &s);
    let mut expected: Vec<_> = "app/a".encode_utf16().collect();
    expected.extend([0xdc00, 58, 120]);
    assert_eq!(actual.units(), expected);
    s.target = SmellTarget::Function {
        file: "too-long.ts".into(),
        id: "x".into(),
        start_line: 1,
    };
    assert_eq!(repo_target(&".".into(), &s), "too-long.ts");
}
#[test]
fn arithmetic_retains_nan_infinities_and_both_negative_zero_positions() {
    for (recorded, measured, expected) in [
        (0.0, -0.0, -0.0),
        (-0.0, 0.0, -0.0),
        (f64::INFINITY, 7.0, 7.0),
        (7.0, f64::NEG_INFINITY, f64::NEG_INFINITY),
    ] {
        let ledger = SmellLedger {
            gated: vec![Kind::HighComplexity],
            entries: vec![entry(Kind::HighComplexity, "app/x", recorded, "old")],
        };
        let scope = JsString::from("app");
        let findings = [finding(Kind::HighComplexity, "app/x", measured)];
        let result = reconcile_smells(
            &ledger,
            &scope,
            &findings,
            &[Kind::HighComplexity],
            &collation(),
        )
        .unwrap();
        assert_eq!(
            result.kept.entries[0].finding.value.to_bits(),
            expected.to_bits()
        );
    }
    let ledger = SmellLedger {
        gated: vec![Kind::HighComplexity],
        entries: vec![entry(Kind::HighComplexity, "app/x", f64::NAN, "old")],
    };
    let scope = JsString::from("app");
    let findings = [finding(Kind::HighComplexity, "app/x", 3.0)];
    let result = reconcile_smells(
        &ledger,
        &scope,
        &findings,
        &[Kind::HighComplexity],
        &collation(),
    )
    .unwrap();
    assert!(result.kept.entries[0].finding.value.is_nan());
    assert!(
        serialize_smell_ledger(&result.kept, &collation())
            .unwrap()
            .to_lossy()
            .contains("\"value\": null")
    );
}
#[test]
fn prepared_gate_writes_before_original_borrowed_output_failure() {
    struct Opaque<'a>(&'a Cell<u8>);
    let tick = Cell::new(4);
    let original = Rc::new(Opaque(&tick));
    let f = Fixture::new();
    let mut graph = f.graph();
    graph.smells = vec![smell(2)];
    let gate = PreparedSmellGate {
        mode: SmellGateMode::Gate,
        file: f.file(),
        scope: "app".into(),
        ledger: SmellLedger {
            gated: vec![Kind::HighComplexity],
            entries: vec![entry(
                Kind::HighComplexity,
                "app/x.ts:calculate",
                5.0,
                "old",
            )],
        },
    };
    let rendered = run_smell_ledger_gate(&gate, &graph, false, false, &collation()).unwrap();
    let emit = |_: &JsString| {
        assert!(
            fs::read_to_string(gate.file.to_lossy())
                .unwrap()
                .contains("\"value\": 2")
        );
        Err::<(), _>(Rc::clone(&original))
    };
    let actual = emit(&rendered.stdout).unwrap_err();
    assert!(Rc::ptr_eq(&actual, &original));
    assert_eq!(actual.0.get(), 4);
    assert_eq!(rendered.exit_code, 0);
    assert!(rendered.stdout.units().ends_with(&[10]));
}
#[cfg(unix)]
#[test]
fn repeat_preserves_noncanonical_bytes_and_readonly_mode() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let mut graph = f.graph();
    graph.smells = vec![smell(2)];
    let bytes = " {\"entries\":[],\"gated\":[\"high-complexity\"]}  \n";
    fs::write(f.file().to_lossy(), bytes).unwrap();
    fs::set_permissions(f.file().to_lossy(), fs::Permissions::from_mode(0o444)).unwrap();
    let gate = PreparedSmellGate {
        mode: SmellGateMode::Accept {
            reason: "unused".into(),
        },
        file: f.file(),
        scope: "app".into(),
        ledger: SmellLedger {
            gated: vec![Kind::HighComplexity],
            entries: vec![entry(
                Kind::HighComplexity,
                "app/x.ts:calculate",
                2.0,
                "old",
            )],
        },
    };
    assert_eq!(
        run_smell_ledger_gate(&gate, &graph, false, false, &collation())
            .unwrap()
            .exit_code,
        0
    );
    assert_eq!(fs::read_to_string(gate.file.to_lossy()).unwrap(), bytes);
    assert_eq!(
        fs::metadata(gate.file.to_lossy())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o444
    );
}
#[test]
fn complete_caller_uses_existing_output_and_exit_owners_with_borrowed_writers() {
    struct Sink<'a> {
        seen: &'a Cell<usize>,
        bytes: Vec<u8>,
    }
    impl Write for Sink<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.seen.set(self.seen.get() + 1);
            self.bytes.extend(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let f = Fixture::new();
    let mut graph = f.graph();
    graph.smells = vec![smell(2)];
    let gate = PreparedSmellGate {
        mode: SmellGateMode::Gate,
        file: f.file(),
        scope: "app".into(),
        ledger: SmellLedger {
            gated: vec![Kind::HighComplexity],
            entries: vec![],
        },
    };
    let count = Cell::new(0);
    let mut stdout = Sink {
        seen: &count,
        bytes: vec![],
    };
    let mut stderr = vec![];
    let mut io = CliIo::new(&mut stdout, &mut stderr, None);
    let rendered = run_smell_ledger_gate(&gate, &graph, false, false, &collation()).unwrap();
    output_to(None).emit(&mut io, &rendered.stdout).unwrap();
    exit_with(&mut io, f64::from(rendered.exit_code)).unwrap();
    assert_eq!(io.normal_exit_code(), 1);
    drop(io);
    assert_eq!(count.get(), 1);
    assert_eq!(stdout.bytes, rendered.stdout.to_lossy().as_bytes());
    assert!(stderr.is_empty());
    assert!(!f.0.join("ledger.json").exists());
}

fn collation() -> demlik_code_graph::project::Collation {
    demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
}
