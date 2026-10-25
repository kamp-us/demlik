use demlik_code_graph::{
    boundaries::{
        deployables::{
            cycles::{worker_cycles, worker_graph},
            workspaces::{cross_workspace_imports, workspace_at},
        },
        violation::BoundaryViolation,
    },
    extract::wrangler_config::load_binding_catalog,
    syntax::imports::{ImportEdge, ImportKind},
    text::JsString,
};
use indexmap::IndexSet;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn real_worker_configs_form_one_cycle_while_workspace_crossings_keep_the_first_spelling() {
    let root = std::env::temp_dir().join(format!(
        "demlik-deployable-native-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (dir, source) in [
        (
            "workers/a",
            r#"{"name":"a","services":[{"binding":"B","service":"b"},{"binding":"SELF","service":"a"},{"binding":"OUT","service":"outside"}],"durable_objects":{"bindings":[{"name":"ROOM","class_name":"Room","script_name":"outside"}]}}"#,
        ),
        (
            "workers/b",
            r#"{"name":"b","services":[{"binding":"A","service":"a"}]}"#,
        ),
    ] {
        fs::create_dir_all(root.join(dir)).unwrap();
        fs::write(root.join(dir).join("wrangler.json"), source).unwrap();
    }
    let catalog = load_binding_catalog(&root, None).unwrap();
    let graph = worker_graph(&catalog);
    assert_eq!(
        graph.workers,
        vec![JsString::from("a"), JsString::from("b")]
    );
    assert_eq!(graph.unresolved, 1);
    assert_eq!(graph.edges.len(), 2);
    let cycles = worker_cycles(&graph);
    assert!(
        matches!(&cycles[..],[BoundaryViolation::WorkerCallCycle {from,specifier,..}] if from=="a, b"&&specifier=="a.B -> b; b.A -> a")
    );
    let roots: IndexSet<_> = [".", "workers/a", "workers/b"]
        .into_iter()
        .map(JsString::from)
        .collect();
    assert_eq!(
        workspace_at(&roots, &"workers/a/src/missing.ts".into()),
        Some(&JsString::from("workers/a"))
    );
    let edges = vec![
        ImportEdge {
            specifier: "../b/missing.ts".into(),
            kind: ImportKind::Static,
            type_only: true,
            target: None,
        },
        ImportEdge {
            specifier: "..\\b\\other.ts".into(),
            kind: ImportKind::Static,
            type_only: false,
            target: None,
        },
    ];
    let crossing = cross_workspace_imports(
        &roots,
        &"workers/a".into(),
        &"workers/a/index.ts".into(),
        &edges,
    );
    assert!(
        matches!(&crossing[..],[BoundaryViolation::RelativeImportCrossesWorkspace {from,to,specifier,type_only:false}] if from=="workers/a/index.ts"&&to=="workers/b"&&specifier=="../b/missing.ts")
    );
    fs::remove_dir_all(root).unwrap();
}
