use demlik_code_graph::{
    declarations::find::{FindMatch, find_by_name, render_find},
    project::{Collation, EdgeScope},
    render::{
        blast::render_blast,
        tree::{TreeStyle, render_tree},
    },
    schema::{
        CallerSite, DeclarationKind, DeclarationNode, Edges, FunctionKind, FunctionNode, Graph,
        Health, ModuleNode, Provenance, Severity, Smell, SmellKind, SmellTarget, Stats, Summary,
        Thresholds, UseSite,
    },
    text::JsString,
};
fn node(id: &str, name: &str, file: &str, line: usize, callers: &[(&str, usize)]) -> FunctionNode {
    FunctionNode {
        id: id.into(),
        name: name.into(),
        file: file.into(),
        kind: FunctionKind::Function,
        start_line: line,
        end_line: line + 2,
        loc: 3,
        comment_lines: 0,
        nesting_depth: 0,
        complexity: 1,
        is_exported: true,
        is_test: false,
        edges: Some(Edges {
            calls: vec![],
            called_by: callers
                .iter()
                .map(|(id, line)| CallerSite {
                    caller_id: (*id).into(),
                    line: *line,
                })
                .collect(),
            call_chain_depth: 4,
        }),
        node_kind: None,
        smells: vec![],
        header: None,
    }
}
fn module(file: &str, test: bool) -> ModuleNode {
    ModuleNode {
        file: file.into(),
        loc: 20,
        comment_lines: 0,
        function_ids: vec![],
        imports: vec![],
        imported_by: vec![],
        import_edges: vec![],
        is_test: test,
        smells: vec![],
    }
}
fn graph(functions: Vec<FunctionNode>) -> Graph {
    Graph {
        root: "/root".into(),
        provenance: Provenance::Edges {
            ts_config: "tsconfig.json".into(),
            scope: EdgeScope::Deep,
        },
        thresholds: Thresholds::default(),
        summary: Summary {
            health: Health::Healthy,
            file_count: 0,
            function_count: functions.len(),
            smell_count: 0,
            high_severity_count: 0,
            worst_file: None,
            worst_function: None,
            top_targets: vec![],
            parse_failures: vec![],
        },
        functions,
        declarations: vec![],
        modules: vec![],
        directories: vec![],
        smells: vec![],
        cross_runtime: None,
        reachability: None,
        clusters: None,
        interface_width: None,
        data: None,
        stats: Stats {
            file_count: 0,
            function_count: 0,
            total_loc: 0,
            total_comment_lines: 0,
            smell_count: 0,
            parse_failures: vec![],
        },
    }
}
fn collation() -> Collation {
    Collation::try_node22_en_us().unwrap()
}
fn smelly(node: &mut FunctionNode) {
    node.smells = [SmellKind::LongFunction, SmellKind::HighComplexity]
        .into_iter()
        .map(|kind| Smell {
            kind,
            target: SmellTarget::Function {
                id: node.id.clone(),
                file: node.file.clone(),
                start_line: node.start_line,
            },
            value: 20,
            threshold: 10,
            severity: Severity::High,
        })
        .collect();
}
#[test]
fn tree_matches_chalk_reopening_crlf_and_utf16_padding() {
    // Independent literal from pinned actual Chalk5.6.2/renderTree baseline.
    let mut g = graph(vec![
        node("a:emoji", "😀", "a.ts", 1, &[]),
        node("a:escape", "name\x1b[22m tail", "a.ts", 5, &[]),
        node("b:line", "line1\r\nline2", "b.test.ts", 2, &[]),
    ]);
    smelly(&mut g.functions[1]);
    smelly(&mut g.functions[2]);
    g.modules = vec![module("b.test.ts", true), module("a.ts", false)];
    let c = collation();
    assert_eq!(
        render_tree(&g, TreeStyle::Ansi, &c).unwrap().to_lossy(),
        "\x1b[36ma.ts  (loc 20, 2 fns)\x1b[39m\n  ├ 😀                  L1-3      loc=3 cx=1 nest=0\n  └ \x1b[1mname\x1b[22m\x1b[1m tail      \x1b[22mL5-7      loc=3 cx=1 nest=0  \x1b[33m[high-complexity,long-function]\x1b[39m\n\x1b[2mb.test.ts  (loc 20, 1 fns)  [test]\x1b[22m\n  └ \x1b[1mline1\x1b[22m\r\n\x1b[1mline2        \x1b[22mL2-4      loc=3 cx=1 nest=0  \x1b[33m[high-complexity,long-function]\x1b[39m"
    );
    assert!(
        render_tree(&g, TreeStyle::Plain, &c)
            .unwrap()
            .to_lossy()
            .contains("name\x1b[22m tail")
    );
    g.modules.clear();
    assert_eq!(
        render_tree(&g, TreeStyle::Ansi, &c).unwrap(),
        "No modules in the graph."
    );
}
#[test]
fn blast_keeps_shortest_depth_first_site_unknown_callers_and_self_count() {
    let g = graph(vec![
        node(
            "t",
            "target",
            "t.ts",
            1,
            &[
                ("b", 41),
                ("a", 31),
                ("t", 71),
                ("t", 72),
                ("missing", 99),
                ("a", 25),
            ],
        ),
        node("a", "alpha", "a.ts", 1, &[("outer", 60)]),
        node("b", "beta", "b.ts", 1, &[("outer", 50)]),
        node("outer", "outer", "outer.ts", 1, &[("a", 75)]),
    ]);
    let result = render_blast(&g, &"target".into(), true, false, &collation()).unwrap();
    assert_eq!(result.exit_code, 0);
    assert!(result.warning.is_none());
    let payload: serde_json::Value =
        serde_json::from_str(&result.stdout.unwrap().to_lossy()).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({
            "target":"t","scope":"deep","targetCallChainDepth":4,"crossPackageCallersOmitted":false,"recursiveSelfCalls":2,
            "callers":[{"callerId":"a","file":"a.ts","line":31,"depth":1},{"callerId":"b","file":"b.ts","line":41,"depth":1},{"callerId":"missing","file":"","line":99,"depth":1},{"callerId":"outer","file":"outer.ts","line":50,"depth":2}]
        })
    );
}
#[test]
fn blast_resolves_exact_id_before_names_and_preserves_refusal_text() {
    let mut g = graph(vec![
        node("target", "different", "a.ts", 1, &[]),
        node("second", "target", "b.ts", 1, &[]),
    ]);
    g.provenance = Provenance::Edges {
        ts_config: "tsconfig.json".into(),
        scope: EdgeScope::Package,
    };
    let c = collation();
    let exact = render_blast(&g, &"target".into(), false, false, &c).unwrap();
    assert!(
        exact
            .stdout
            .unwrap()
            .to_lossy()
            .starts_with("blast: target\n")
    );
    assert!(
        exact
            .warning
            .unwrap()
            .to_lossy()
            .contains("cross-package callers omitted")
    );
    g.functions[0].name = "same".into();
    g.functions[1].name = "same".into();
    let ambiguous = render_blast(&g, &"same".into(), false, false, &c).unwrap();
    assert_eq!(ambiguous.exit_code, 1);
    assert_eq!(
        ambiguous.warning.unwrap(),
        "error: \"same\" is ambiguous — 2 matches. Pass one id:\n  second\n  target"
    );
    g.summary.parse_failures.push("bad.ts".into());
    let missing = render_blast(&g, &"bad.ts:lost".into(), false, false, &c).unwrap();
    assert!(
        missing
            .warning
            .unwrap()
            .to_lossy()
            .contains("its file is in parseFailures")
    );
    let raw = JsString::from_units(vec![0xd800]);
    let missing = render_blast(&g, &raw, false, false, &c).unwrap();
    assert!(missing.warning.unwrap().units().contains(&0xd800));
    g.provenance = Provenance::Cheap;
    assert_eq!(
        render_blast(&g, &raw, false, false, &c).unwrap().exit_code,
        2
    );
}
#[test]
fn find_borrows_original_declaration_uses_and_dedupes_function_sites() {
    let mut g = graph(vec![
        node(
            "shared",
            "Shared",
            "a.ts",
            3,
            &[("b", 8), ("b", 8), ("bAgain", 8), ("a", 4), ("missing", 9)],
        ),
        node("a", "Other", "z.ts", 1, &[]),
        node("b", "Other", "b.ts", 1, &[]),
        node("bAgain", "Other", "b.ts", 1, &[]),
    ]);
    g.declarations.push(DeclarationNode {
        id: "a.ts:interface:Shared".into(),
        name: "Shared".into(),
        kind: DeclarationKind::Interface,
        file: "a.ts".into(),
        line: 2,
        is_exported: true,
        is_test: false,
        uses: Some(vec![UseSite {
            file: "keep-original.ts".into(),
            line: 12,
        }]),
    });
    let c = collation();
    let matches = find_by_name(&g, &"Shared".into(), &c).unwrap();
    assert_eq!(matches.len(), 2);
    let FindMatch::Declaration(original) = &matches[0] else {
        panic!("declaration sorts by line")
    };
    assert!(std::ptr::eq(*original, &g.declarations[0]));
    assert!(std::ptr::eq(
        matches[0].uses().unwrap(),
        g.declarations[0].uses.as_deref().unwrap()
    ));
    let FindMatch::Function { node, uses } = &matches[1] else {
        panic!("function match")
    };
    assert!(std::ptr::eq(*node, &g.functions[0]));
    let uses = uses.as_ref().unwrap();
    assert_eq!(
        uses.iter()
            .map(|s| (s.file.as_str(), s.line))
            .collect::<Vec<_>>(),
        vec![("", 9), ("b.ts", 8), ("z.ts", 4)]
    );
    assert_eq!(g.functions[0].edges.as_ref().unwrap().called_by.len(), 5);
}
#[test]
fn find_returns_empty_data_and_preserves_unknown_uses() {
    let mut g = graph(vec![node("one", "Shared", "a.ts", 1, &[])]);
    g.functions[0].edges = None;
    let c = collation();
    let found = find_by_name(&g, &"Shared".into(), &c).unwrap();
    assert!(found[0].uses().is_none());
    let missing = render_find(&g, &"Nothing".into(), true, &c).unwrap();
    assert_eq!(missing.exit_code, 0);
    assert_eq!(
        missing.warning.unwrap(),
        "warning: no function or declaration is named \"Nothing\"."
    );
    let payload: serde_json::Value =
        serde_json::from_str(&missing.stdout.unwrap().to_lossy()).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"name":"Nothing","scope":"deep","matches":[]})
    );
    g.provenance = Provenance::Cheap;
    assert_eq!(
        render_find(&g, &"Shared".into(), false, &c)
            .unwrap()
            .exit_code,
        2
    );
}
