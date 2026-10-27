use demlik_code_graph::{
    collapse::{candidates::find_collapse_candidates, settings::CollapseSettings},
    schema::{CallSite, Edges, FunctionKind, FunctionNode},
};

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
    let settings = CollapseSettings::default();
    let report;
    {
        let nodes = vec![
            function("a", "normalizeMembership", "a.ts"),
            function("b", "canonicalMembership", "b.ts"),
        ];
        report = find_collapse_candidates(&nodes, &[], &settings);
    }
    println!("{}", report.considered_functions);
}
