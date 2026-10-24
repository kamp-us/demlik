use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use demlik_code_graph::extract::assemble::{NodeFields, assemble_graph};
use demlik_code_graph::project::load_cheap_project;
use demlik_code_graph::schema::{Health, Thresholds};

#[test]
fn assembles_a_real_cheap_graph_with_measured_smells_and_unknown_edge_facts() {
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
    let loaded = load_cheap_project(&root, None).unwrap();
    let thresholds = Thresholds {
        long_function_loc: 2,
        deep_nesting: 0,
        high_complexity: 1,
        big_file_loc: 3,
        directory_sprawl: 1,
        ..Thresholds::default()
    };
    let graph = assemble_graph(&loaded, thresholds, NodeFields { headers: true }).unwrap();
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
    let default_graph =
        assemble_graph(&loaded, Thresholds::default(), NodeFields::default()).unwrap();
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
        assemble_graph(&loaded, invalid, NodeFields::default()),
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
