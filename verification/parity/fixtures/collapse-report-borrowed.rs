use demlik_code_graph::{
    collapse::{candidates::find_collapse_candidates, settings::CollapseSettings},
    project::Collation,
    render::json::stable_stringify,
    schema::{CallSite, Edges, FunctionKind, FunctionNode},
};
use std::{cell::Cell, rc::Rc, sync::Arc};
fn function(id: &str, name: &str, file: &str) -> FunctionNode {
    FunctionNode {
        id: id.into(),
        name: name.into(),
        file: file.into(),
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
            calls: ["helpers.ts:normalizeId", "helpers.ts:selectRole"]
                .into_iter()
                .map(|id| CallSite {
                    callee_id: id.into(),
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
fn main() {
    struct Local<'a> {
        label: &'a str,
        visits: Rc<Cell<usize>>,
    }
    let label = String::from("local membership analysis");
    let visits = Rc::new(Cell::new(0));
    let local = Local {
        label: &label,
        visits: Rc::clone(&visits),
    };
    let nodes = vec![
        function("a.ts:normalizeMembership", "normalizeMembership", "a.ts"),
        function("b.ts:canonicalMembership", "canonicalMembership", "b.ts"),
    ];
    let settings = CollapseSettings::default();
    let roots = vec![String::new()];
    let report = {
        let collation = Collation::try_node22_en_us().unwrap();
        let inspect = || {
            assert_eq!(local.label, "local membership analysis");
            let report = find_collapse_candidates(&nodes, &roots, &settings, &collation).unwrap();
            local.visits.set(local.visits.get() + 1);
            report
        };
        inspect()
    };
    assert!(std::ptr::eq(report.settings, &settings));
    assert_eq!(report.considered_functions, 2);
    assert_eq!(report.pairs_scored, 1);
    assert_eq!(report.candidates.len(), 1);
    assert_eq!(report.clusters.len(), 1);
    assert!(report.partial_twins.is_empty());
    let candidate = Arc::clone(&report.candidates[0]);
    assert!(std::ptr::eq(candidate.a, &nodes[0]));
    assert!(std::ptr::eq(candidate.b, &nodes[1]));
    assert!(Arc::ptr_eq(&candidate, &report.clusters[0].representative));
    assert_eq!(candidate.confidence, 0.625);
    assert_eq!(candidate.cost, 1.0);
    assert_eq!(candidate.rank, 0.625);
    assert_eq!(candidate.signals.len(), 3);
    assert!(
        stable_stringify(&report, false)
            .unwrap()
            .contains("\"confidence\":0.625")
    );
    assert_eq!(visits.get(), 1);
    println!("inferred borrowed graph/settings + original pair/representative owners: passed");
}
