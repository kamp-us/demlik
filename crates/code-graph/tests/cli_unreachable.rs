use demlik_code_graph::{
    cli::{
        frontdoor::{GatePreflightDispatch, Preparation, UnreachableDispatch, prepare_cli},
        io::CliIo,
    },
    engine::tsgo::TsgoBinary,
    extract::assemble::{NodeFields, assemble_graph},
    project::{ProjectLoadError, load_cheap_project},
    render::analysis::render_unreachable,
    schema::{
        ReachabilityReport, Thresholds, UnreachableCategory, UnreachableSymbol, WithheldReason,
        WithheldSymbol,
    },
    text::JsString,
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-cli-unreachable-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(fs::canonicalize(path).unwrap()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("fixture: {error}"),
            }
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("fixture cleanup: {error}");
        }
    }
}
#[test]
fn renderer_keeps_witness_order_and_counts_sorted_withheld_reasons() {
    let fixture = Fixture::new();
    let loaded = load_cheap_project(&fixture.0, None).unwrap();
    let mut graph = assemble_graph(
        &loaded,
        Thresholds::default(),
        NodeFields::default(),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(
        render_unreachable(&graph, true, true).unwrap(),
        "reachability: pass did not run — add --unreachable or --unguarded."
    );
    graph.reachability = Some(ReachabilityReport {
        entry_count: 2,
        exported_count: 7,
        reachable_count: 4,
        unreachable: vec![UnreachableSymbol {
            id: "src/z.ts:unused".into(),
            file: "src/z.ts".into(),
            start_line: 3,
            category: UnreachableCategory::OnlyCalledFromTests,
            test_references: vec!["z.test.ts".into(), "a.test.ts".into()],
        }],
        withheld: vec![
            WithheldSymbol {
                id: "t".into(),
                reason: WithheldReason::TestSupportSurface,
            },
            WithheldSymbol {
                id: "p".into(),
                reason: WithheldReason::PublicEntrySurface,
            },
            WithheldSymbol {
                id: "p2".into(),
                reason: WithheldReason::PublicEntrySurface,
            },
        ],
        unguarded: vec![],
    });
    assert_eq!(
        render_unreachable(&graph, false, true).unwrap(),
        "unreachable: 1 of 7 exported symbols (2 entries, 4 nodes reachable)\n  only-called-from-tests  src/z.ts:unused  src/z.ts:3  <- z.test.ts, a.test.ts\nwithheld (3) — an unmodelled construct may reach them:\n  public-entry-surface  2\n  test-support-surface  1"
    );
    let json = render_unreachable(&graph, true, false).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json.to_lossy()).unwrap();
    assert_eq!(
        parsed
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["entryCount", "unreachable", "withheld"]
    );
    assert_eq!(
        parsed["unreachable"][0]["testReferences"],
        serde_json::json!(["z.test.ts", "a.test.ts"])
    );
}
#[test]
fn inactive_and_html_retain_the_same_box_without_starting_compiler_or_warning() {
    let fixture = Fixture::new();
    for flags in [
        vec![],
        vec!["--unreachable", "--html"],
        vec!["--unreachable", "--collapse"],
    ] {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
        let mut args = vec![JsString::from(fixture.0.to_string_lossy().as_ref())];
        args.extend(flags.into_iter().map(JsString::from));
        let Preparation::Prepared(prepared) = prepare_cli(&args, None, &mut host).unwrap() else {
            panic!("prepared")
        };
        let GatePreflightDispatch::Continue(prepared) = prepared.prepare_gates(&mut host).unwrap()
        else {
            panic!("preflight")
        };
        let original = std::ptr::from_ref(prepared.as_ref());
        let nested = std::ptr::from_ref(prepared.prepared.as_ref());
        let UnreachableDispatch::Continue(continued) = prepared
            .dispatch_unreachable_blocking(&mut host, &TsgoBinary::pinned("/must-not-start"))
            .unwrap()
        else {
            panic!("same box")
        };
        assert!(std::ptr::eq(original, continued.as_ref()));
        assert!(std::ptr::eq(nested, continued.prepared.as_ref()));
        assert_eq!(host.exit_state().stored_code(), Some(7));
        drop(host);
        assert!(stdout.is_empty() && stderr.is_empty());
    }
}
#[test]
fn active_missing_config_warns_then_refuses_with_original_load_cause_without_compiler() {
    let fixture = Fixture::new();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let args = [
        JsString::from(fixture.0.to_string_lossy().as_ref()),
        "--unreachable".into(),
        "--by".into(),
        "loc".into(),
    ];
    let Preparation::Prepared(prepared) = prepare_cli(&args, None, &mut host).unwrap() else {
        panic!("prepared")
    };
    let GatePreflightDispatch::Continue(prepared) = prepared.prepare_gates(&mut host).unwrap()
    else {
        panic!("preflight")
    };
    let UnreachableDispatch::Refused { cause } = prepared
        .dispatch_unreachable_blocking(&mut host, &TsgoBinary::pinned("/must-not-start"))
        .unwrap()
    else {
        panic!("load refusal")
    };
    assert!(matches!(cause, ProjectLoadError::MissingTsConfig(_)));
    assert_eq!(host.exit_state().stored_code(), Some(2));
    drop(host);
    assert!(stdout.is_empty());
    assert_eq!(
        String::from_utf8(stderr).unwrap(),
        format!(
            "warning: --by loc has no effect without --plan.\ncode-graph: no tsconfig found for edge pass at {}; edges unavailable\n",
            fixture.0.display()
        )
    );
}
