use demlik_code_graph::{
    collapse::{candidates::find_collapse_candidates, settings::CollapseSettings},
    render::json::stable_stringify,
    schema::{CallSite, CallerSite, Edges, FunctionKind, FunctionNode, NodeKind},
};
use std::sync::Arc;
fn function(id: &str, name: &str) -> FunctionNode {
    FunctionNode {
        id: id.into(),
        name: name.into(),
        file: "member.ts".into(),
        kind: FunctionKind::Function,
        start_line: 1,
        end_line: 10,
        loc: 10,
        comment_lines: 0,
        nesting_depth: 1,
        complexity: 2,
        is_exported: true,
        is_test: false,
        edges: Some(Edges {
            calls: ["normalizeId", "selectRole"]
                .into_iter()
                .map(|callee| CallSite {
                    callee_id: callee.into(),
                    line: 2,
                    const_args: vec![],
                    declaration: None,
                })
                .collect(),
            called_by: vec![],
            call_chain_depth: 0,
        }),
        node_kind: None,
        smells: vec![],
        header: None,
    }
}
#[test]
fn retained_pair_outlives_report_and_borrows_original_graph() {
    let nodes = [
        function("a", "normalizeMembership"),
        function("b", "canonicalMembership"),
    ];
    let settings = CollapseSettings::default();
    let pair = {
        let report = find_collapse_candidates(
            &nodes,
            &[String::new()],
            &settings,
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
        )
        .unwrap();
        assert!(std::ptr::eq(report.settings, &settings));
        assert!(Arc::ptr_eq(
            &report.candidates[0],
            &report.clusters[0].representative
        ));
        Arc::clone(&report.clusters[0].representative)
    };
    assert!(std::ptr::eq(pair.a, &nodes[0]));
    assert!(std::ptr::eq(pair.b, &nodes[1]));
    assert_eq!((pair.confidence, pair.cost, pair.rank), (0.625, 1.0, 0.625));
    let wire = stable_stringify(&pair, false).unwrap();
    assert!(wire.contains("\"aId\":\"a\""));
    assert!(!wire.contains("\"a\":"));
}
#[test]
fn excluded_helpers_still_contribute_caller_packages_and_effect_reach() {
    let mut a = function("a", "normalizeMembership");
    a.edges.as_mut().unwrap().called_by.push(CallerSite {
        caller_id: "caller".into(),
        line: 1,
    });
    let b = function("b", "canonicalMembership");
    let mut helper = function("normalizeId", "helper");
    helper.loc = 1;
    helper.complexity = 1;
    helper.node_kind = Some(NodeKind::Effect { evidence: vec![] });
    let mut caller = function("caller", "caller");
    caller.loc = 1;
    caller.file = "other/caller.ts".into();
    let nodes = [a, b, helper, caller];
    let settings = CollapseSettings::default();
    let report = find_collapse_candidates(
        &nodes,
        &["other".into(), String::new()],
        &settings,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(report.considered_functions, 2);
    assert_eq!(report.candidates[0].cost, 4.0);
    assert_eq!(report.candidates[0].cost_inputs.caller_union, 1);
    assert_eq!(report.candidates[0].cost_inputs.packages_spanned, 2);
    assert!(report.candidates[0].cost_inputs.effect_on_path);
}
#[test]
fn independent_partial_view_keeps_original_calls_when_candidate_blocks_are_skipped() {
    let mut a = function("a", "normalizeMembership");
    let mut b = function("b", "canonicalMembership");
    for (node, end) in [(&mut a, "left"), (&mut b, "right")] {
        node.edges.as_mut().unwrap().calls = ["p", "q", "r", end]
            .into_iter()
            .enumerate()
            .map(|(i, id)| CallSite {
                callee_id: id.into(),
                line: 10 + i,
                const_args: if i == 1 { vec!["LIMIT".into()] } else { vec![] },
                declaration: None,
            })
            .collect();
    }
    let nodes = [a, b];
    let settings = CollapseSettings {
        max_block_size: 0.0,
        ..CollapseSettings::default()
    };
    let report = find_collapse_candidates(
        &nodes,
        &[],
        &settings,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert!(report.candidates.is_empty());
    assert_eq!(report.partial_twins.len(), 1);
    let original = &nodes[0].edges.as_ref().unwrap().calls;
    assert!(std::ptr::eq(
        report.partial_twins[0].shared_block.as_ptr(),
        original.as_ptr()
    ));
    assert!(std::ptr::eq(
        report.partial_twins[0].a_diverges,
        &original[3]
    ));
}
#[test]
fn finite_valid_weights_can_produce_live_infinity_and_wire_null() {
    let mut a = function("a", "normalizeMembership");
    let b = function("b", "canonicalMembership");
    a.edges.as_mut().unwrap().called_by = ["x", "y", "z"]
        .into_iter()
        .map(|id| CallerSite {
            caller_id: id.into(),
            line: 1,
        })
        .collect();
    let nodes = [a, b];
    let settings = CollapseSettings {
        cost_caller_weight: f64::MAX,
        ..CollapseSettings::default()
    };
    let report = find_collapse_candidates(
        &nodes,
        &[],
        &settings,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(report.candidates[0].cost, f64::INFINITY);
    assert_eq!(report.candidates[0].rank, 0.0);
    assert!(
        stable_stringify(&report, false)
            .unwrap()
            .contains("\"cost\":null")
    );
}
