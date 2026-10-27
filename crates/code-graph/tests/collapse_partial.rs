use demlik_code_graph::collapse::{
    candidates::is_candidate_function, partial::find_partial_twins, settings::CollapseSettings,
};
use demlik_code_graph::schema::{CallSite, Edges, FunctionKind, FunctionNode};

fn function(id: &str, outcome: &str) -> FunctionNode {
    let calls = ["noteAttempt", "decide", "logAttempt", outcome]
        .into_iter()
        .enumerate()
        .map(|(index, callee)| CallSite {
            callee_id: callee.into(),
            line: 10 + index,
            const_args: if index == 1 {
                vec!["MAX_ATTEMPTS".into()]
            } else {
                vec![]
            },
            declaration: None,
        })
        .collect();
    FunctionNode {
        id: id.into(),
        name: id.into(),
        file: "retry.ts".into(),
        kind: FunctionKind::Function,
        start_line: 1,
        end_line: 20,
        loc: 12,
        comment_lines: 0,
        nesting_depth: 1,
        complexity: 2,
        is_exported: true,
        is_test: false,
        edges: Some(Edges {
            calls,
            called_by: vec![],
            call_chain_depth: 0,
        }),
        node_kind: None,
        smells: vec![],
        header: None,
    }
}
#[test]
fn shared_decision_borrows_the_original_functions_calls_and_constant() {
    let nodes = [
        function("giveUp", "finalizeFailed"),
        function("recover", "salvageCheckpoint"),
    ];
    let settings = CollapseSettings::default();
    let considered = nodes
        .iter()
        .filter(|node| is_candidate_function(node, &settings))
        .collect::<Vec<_>>();
    let twins = find_partial_twins(&considered, &settings);
    assert_eq!(twins.len(), 1);
    let twin = &twins[0];
    assert!(std::ptr::eq(twin.a, &nodes[0]));
    assert!(std::ptr::eq(twin.b, &nodes[1]));
    let calls = &nodes[0].edges.as_ref().unwrap().calls;
    assert!(std::ptr::eq(twin.shared_block.as_ptr(), calls.as_ptr()));
    assert!(std::ptr::eq(twin.a_diverges, &calls[3]));
    assert!(std::ptr::eq(
        twin.shared_constants[0].as_ptr(),
        calls[1].const_args[0].as_ptr()
    ));
    assert_eq!(
        serde_json::to_value(twin).unwrap(),
        serde_json::json!({
            "aId":"giveUp","aFile":"retry.ts","aStartLine":1,"aBlockLine":10,"aDiverges":"finalizeFailed","aDivergesLine":13,
            "bId":"recover","bFile":"retry.ts","bStartLine":1,"bBlockLine":10,"bDiverges":"salvageCheckpoint","bDivergesLine":13,
            "sharedBlock":["noteAttempt","decide","logAttempt"],"sharedConstants":["MAX_ATTEMPTS"]
        })
    );
}

#[test]
fn candidate_predicate_uses_graph_facts_and_the_inclusive_thresholds() {
    let settings = CollapseSettings::default();
    for (kind, expected) in [
        (FunctionKind::Function, true),
        (FunctionKind::Method, true),
        (FunctionKind::Arrow, true),
        (FunctionKind::FunctionExpression, true),
        (FunctionKind::Constructor, false),
        (FunctionKind::Getter, false),
        (FunctionKind::Setter, false),
    ] {
        let mut node = function("candidate", "left");
        node.kind = kind;
        assert_eq!(is_candidate_function(&node, &settings), expected);
    }
    let mut node = function("threshold", "left");
    node.loc = 5;
    node.complexity = 2;
    assert!(is_candidate_function(&node, &settings));
    node.loc = 4;
    assert!(!is_candidate_function(&node, &settings));
    node.loc = 5;
    node.complexity = 1;
    assert!(!is_candidate_function(&node, &settings));
    node.complexity = 2;
    node.is_test = true;
    assert!(!is_candidate_function(&node, &settings));
    node.is_test = false;
    node.edges = None;
    assert!(!is_candidate_function(&node, &settings));
}

#[test]
fn literal_space_and_nul_keys_keep_the_source_collision_behavior() {
    let settings = CollapseSettings::default();
    let mut a = function("space-a", "left");
    let mut b = function("space-b", "right");
    for (function, callees) in [(&mut a, ["p q", "r", "s"]), (&mut b, ["p", "q r", "s"])] {
        for (call, id) in function
            .edges
            .as_mut()
            .unwrap()
            .calls
            .iter_mut()
            .zip(callees)
        {
            call.callee_id = id.into();
        }
    }
    let twins = find_partial_twins(&[&a, &b], &settings);
    assert_eq!(twins.len(), 1);
    assert_eq!(twins[0].shared_block[0].callee_id, "p q");
    let nodes = [
        function("a\0b", "first-left"),
        function("c", "first-right"),
        function("a", "second-left"),
        function("b\0c", "second-right"),
    ];
    let twins = find_partial_twins(&nodes.iter().collect::<Vec<_>>(), &settings);
    // The all-pairs input contains six pairs, but these two concatenated keys collide.
    assert_eq!(twins.len(), 5);
    assert!(
        twins
            .iter()
            .any(|t| std::ptr::eq(t.a, &nodes[0]) && std::ptr::eq(t.b, &nodes[1]))
    );
    assert!(
        !twins
            .iter()
            .any(|t| std::ptr::eq(t.a, &nodes[2]) && std::ptr::eq(t.b, &nodes[3]))
    );
}

#[test]
fn real_three_module_extraction_measures_one_then_three_then_zero_twins() {
    use demlik_code_graph::{
        engine::tsgo::TsgoBinary,
        extract::{
            analysis::AnalysisOptions,
            assemble::{NodeFields, assemble_graph_with_analysis_text},
        },
        project::{EdgeScope, load_edge_project_text},
        schema::Thresholds,
        text::JsString,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Err(error) = fs::remove_dir_all(&self.0)
                && !std::thread::panicking()
            {
                panic!("remove fixture: {error}");
            }
        }
    }
    let fixture = loop {
        let path = std::env::temp_dir().join(format!(
            "demlik-partial-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&path) {
            Ok(()) => break Fixture(fs::canonicalize(path).unwrap()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => panic!("create fixture: {error}"),
        }
    };
    for (name, text) in [
        (
            "tsconfig.json",
            include_str!("../../../verification/parity/fixtures/collapse-partial/tsconfig.json"),
        ),
        (
            "limits.ts",
            include_str!("../../../verification/parity/fixtures/collapse-partial/limits.ts"),
        ),
        (
            "helpers.ts",
            include_str!("../../../verification/parity/fixtures/collapse-partial/helpers.ts"),
        ),
        (
            "retry.ts",
            include_str!("../../../verification/parity/fixtures/collapse-partial/retry.ts"),
        ),
    ] {
        fs::write(fixture.0.join(name), text).unwrap();
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
    let binary = TsgoBinary::from_native_preview_manifest(&manifest).unwrap();
    let root = JsString::from(fixture.0.to_string_lossy().as_ref());
    let settings = CollapseSettings::default();
    let rules = demlik_code_graph::kinds::rules::NodeKindRules::default();
    let options = AnalysisOptions {
        cross_runtime: true,
        kinds: true,
        reach: false,
        clusters: false,
        interface_width: false,
        kind_rules: &rules,
        repo_root: &fixture.0,
    };
    let measure = |expected: usize| {
        let loaded = load_edge_project_text(&root, EdgeScope::Package, &fixture.0, None).unwrap();
        let graph = assemble_graph_with_analysis_text(
            &loaded,
            &root,
            Thresholds::default(),
            &binary,
            NodeFields::default(),
            &options,
        )
        .unwrap();
        assert_eq!(graph.modules.len(), 3);
        let considered = graph
            .functions
            .iter()
            .filter(|node| is_candidate_function(node, &settings))
            .collect::<Vec<_>>();
        let twins = find_partial_twins(&considered, &settings);
        assert_eq!(twins.len(), expected);
        for twin in &twins {
            assert_eq!(twin.shared_constants, ["MAX_ATTEMPTS"]);
            assert_eq!(twin.shared_block.len(), 3);
            assert_eq!(twin.shared_block[1].callee_id, "helpers.ts:decide");
        }
    };
    measure(1);
    measure(1);
    let retry = fs::read_to_string(fixture.0.join("retry.ts")).unwrap();
    let third = "\nexport function settleTransientStep(state:{attempts:number}) {\n  const count=noteAttempt(state);\n  const decision=decide(count,MAX_ATTEMPTS);\n  logAttempt(count);\n  if(decision==='give_up') {\n    return settlePending(decision);\n  }\n  return String(armTimer(BACKOFF));\n}\n";
    let three = format!("{retry}{third}");
    fs::write(fixture.0.join("retry.ts"), &three).unwrap();
    measure(3);
    fs::write(
        fixture.0.join("retry.ts"),
        three.replace("decide(count,MAX_ATTEMPTS)", "decide(count,3)"),
    )
    .unwrap();
    measure(0);
}

#[test]
fn repeated_b_prefix_keeps_the_selected_offset_in_wire_and_human_views() {
    use demlik_code_graph::collapse::{
        candidates::find_collapse_candidates, render::partial_twin_lines,
    };
    let a = function("aNormalizeInvoice", "left");
    let mut b = function("bCanonicalInvoice", "left");
    let calls = &mut b.edges.as_mut().unwrap().calls;
    calls.extend(function("another", "left").edges.unwrap().calls);
    for (index, call) in calls.iter_mut().enumerate() {
        call.line = 100 + index;
    }
    calls[7].callee_id = "right".into();
    let nodes = [a, b];
    let settings = CollapseSettings::default();
    let report = find_collapse_candidates(&nodes, &[], &settings);
    assert_eq!(report.partial_twins.len(), 1);
    let twin = &report.partial_twins[0];
    assert_eq!(twin.b_block_line(), 104);
    let b_calls = &nodes[1].edges.as_ref().unwrap().calls;
    assert!(std::ptr::eq(twin.b_diverges, &b_calls[7]));
    assert_eq!(serde_json::to_value(twin).unwrap()["bBlockLine"], 104);
    let lines = partial_twin_lines(&report);
    assert!(
        lines[2]
            .to_lossy()
            .contains("B bCanonicalInvoice  retry.ts:104")
    );
    assert!(!lines[2].to_lossy().contains("retry.ts:100"));
}
