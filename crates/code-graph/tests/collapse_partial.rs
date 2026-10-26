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
