use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use demlik_code_graph::engine::tsgo::TsgoBinary;
use demlik_code_graph::extract::assemble::{NodeFields, assemble_graph, assemble_graph_with_edges};
use demlik_code_graph::project::{EdgeScope, load_cheap_project, load_edge_project};
use demlik_code_graph::schema::{Health, Thresholds};

#[test]
fn assembles_a_real_cheap_graph_with_measured_smells_and_unknown_edge_facts() {
    let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("demlik-assembly-{}-{unique}", std::process::id()));
    fs::create_dir(&root).unwrap();
    fs::write(root.join("a.ts"), "import { value } from './values';\nexport function run(x: number) {\n  if (x) { return value; }\n  return 0;\n}\n").unwrap();
    fs::write(
        root.join("values.ts"),
        "export const value = 1;\nexport interface Shape { value: number }\n",
    )
    .unwrap();
    fs::write(root.join("bad.ts"), "export function broken( {").unwrap();
    let loaded = load_cheap_project(&root, None, &project_collation).unwrap();
    let thresholds = Thresholds {
        long_function_loc: 2,
        deep_nesting: 0,
        high_complexity: 1,
        big_file_loc: 3,
        directory_sprawl: 1,
        ..Thresholds::default()
    };
    let graph = assemble_graph(
        &loaded,
        thresholds,
        NodeFields { headers: true },
        &project_collation,
    )
    .unwrap();
    assert_eq!(graph.functions.len(), 1);
    assert_eq!(graph.declarations.len(), 2);
    assert_eq!(graph.modules.len(), 2);
    assert_eq!(graph.directories.len(), 1);
    assert_eq!(graph.stats.total_loc, 9);
    assert_eq!(graph.stats.parse_failures, ["bad.ts"]);
    assert_eq!(graph.smells.len(), 6);
    assert_eq!(graph.summary.high_severity_count, 6);
    assert_eq!(graph.summary.health, Health::Rotten);
    assert_eq!(graph.summary.worst_file.as_deref(), Some("a.ts"));
    assert_eq!(graph.summary.worst_function.as_deref(), Some("a.ts:run"));
    assert!(graph.functions[0].edges.is_none());
    assert!(graph.declarations.iter().all(|node| node.uses.is_none()));
    assert!(graph.reachability.is_none());
    assert_eq!(
        graph.functions[0].header.as_ref().unwrap().text,
        "export function run(x: number)"
    );
    assert_eq!(graph.modules[0].imports, ["./values"]);
    assert!(graph.modules[0].import_edges.is_empty());
    let default_graph = assemble_graph(
        &loaded,
        Thresholds::default(),
        NodeFields::default(),
        &project_collation,
    )
    .unwrap();
    assert!(
        !serde_json::to_string(&default_graph)
            .unwrap()
            .contains("\"header\"")
    );
    let invalid = Thresholds {
        deep_nesting: 9_007_199_254_740_992,
        ..Thresholds::default()
    };
    assert!(matches!(
        assemble_graph(&loaded, invalid, NodeFields::default(), &project_collation),
        Err(demlik_code_graph::extract::assemble::AssemblyError::Threshold(_))
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn validates_thresholds_as_javascript_nonnegative_safe_integers() {
    assert!(serde_json::from_str::<Thresholds>(r#"{"deepNesting":9007199254740992}"#).is_err());
    assert!(serde_json::from_str::<Thresholds>(r#"{"deepNesting":-1}"#).is_err());
    assert!(serde_json::from_str::<Thresholds>(r#"{"deepNesting":1.5}"#).is_err());
    assert!(serde_json::from_str::<Thresholds>(r#"{"invented":1}"#).is_err());
    assert_eq!(
        serde_json::from_str::<Thresholds>(r#"{"deepNesting":1.0}"#)
            .unwrap()
            .deep_nesting,
        1
    );
    assert_eq!(
        serde_json::from_str::<Thresholds>(r#"{"deepNesting":9007199254740991}"#)
            .unwrap()
            .deep_nesting,
        9007199254740991
    );
}

#[test]
fn round_trips_javascript_strings_without_losing_unpaired_code_units() {
    use demlik_code_graph::text::JsString;
    let source = r#""\ud800\u0000\udc00\ud83d\ude00\n\t\"\\Ω""#;
    let value: JsString = serde_json::from_str(source).unwrap();
    assert_eq!(
        value.units(),
        [0xd800, 0, 0xdc00, 0xd83d, 0xde00, 10, 9, 34, 92, 0x3a9]
    );
    let decoded: JsString = serde_json::from_str(&serde_json::to_string(&value).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_string(&value).unwrap(),
        "\"\\ud800\\u0000\\udc00😀\\n\\t\\\"\\\\Ω\""
    );
    assert_eq!(decoded, value);
    assert!(value.to_utf8().is_err());
    assert!(serde_json::from_str::<JsString>("42").is_err());
}

#[test]
fn assembles_real_measured_edges_uses_and_package_coupling_facts() {
    let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "demlik-edge-assembly-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("packages/a")).unwrap();
    fs::create_dir_all(root.join("packages/b")).unwrap();
    fs::write(
        root.join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
    )
    .unwrap();
    fs::write(root.join("packages/a/package.json"), r#"{"name":"a"}"#).unwrap();
    fs::write(root.join("packages/b/package.json"), r#"{"name":"b"}"#).unwrap();
    fs::write(root.join("packages/a/entry.ts"), "import { other } from '../b/entry';\nexport const UNUSED = 1, ZERO = 0;\nexport function leaf() { return 1; }\nexport function run() { return other(); }\n").unwrap();
    fs::write(
        root.join("packages/b/entry.ts"),
        "import { leaf, UNUSED } from '../a/entry';\nexport function other() { return leaf(); }\n",
    )
    .unwrap();
    let loaded =
        load_edge_project(&root, EdgeScope::Package, &root, None, &project_collation).unwrap();
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
    let binary = TsgoBinary::from_native_preview_manifest(&manifest).unwrap();
    let graph = assemble_graph_with_edges(
        &loaded,
        Thresholds::default(),
        &binary,
        NodeFields::default(),
        &project_collation,
    )
    .unwrap();
    assert_eq!(graph.functions.len(), 3);
    let run = graph
        .functions
        .iter()
        .find(|function| function.name == "run")
        .unwrap();
    assert_eq!(run.edges.as_ref().unwrap().call_chain_depth, 2);
    assert_eq!(
        run.edges.as_ref().unwrap().calls[0].callee_id,
        "packages/b/entry.ts:other"
    );
    assert_eq!(
        graph.modules[0].import_edges[0].target.as_deref(),
        Some("packages/b/entry.ts")
    );
    assert_eq!(graph.modules[0].imported_by, ["packages/b/entry.ts"]);
    assert_eq!(graph.smells.len(), 4);
    assert_eq!(graph.summary.health, Health::Rotten);
    let zero = graph
        .declarations
        .iter()
        .find(|declaration| declaration.name == "ZERO")
        .unwrap();
    assert!(zero.uses.as_ref().unwrap().is_empty());
    let unused = graph
        .declarations
        .iter()
        .find(|declaration| declaration.name == "UNUSED")
        .unwrap();
    assert_eq!(
        unused
            .uses
            .as_ref()
            .unwrap()
            .iter()
            .map(|site| (site.file.as_str(), site.line))
            .collect::<Vec<_>>(),
        [("packages/b/entry.ts", 1)]
    );
    fs::remove_dir_all(root).unwrap();
}
