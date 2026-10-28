use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use demlik_code_graph::checker::context::{TypeContextInput, with_type_context};
use demlik_code_graph::engine::tsgo::TsgoBinary;
use demlik_code_graph::extract::assemble::{NodeFields, assemble_graph_with_edges};
use demlik_code_graph::extract::references::{ReferenceResult, resolve_references};
use demlik_code_graph::project::{Collation, EdgeScope, load_edge_project};
use demlik_code_graph::schema::{EntryReach, Graph, NodeKind, Thresholds};

struct Project(PathBuf);
impl Project {
    fn new(files: &[(&str, &str)]) -> Self {
        static NEXT_PROJECT: AtomicU64 = AtomicU64::new(0);
        let sequence = NEXT_PROJECT.fetch_add(1, Ordering::Relaxed);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "demlik-query-{}-{unique}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("tsconfig.json"),
            r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
        )
        .unwrap();
        for (file, source) in files {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, source).unwrap();
        }
        Self(root)
    }
    fn graph(&self) -> Graph {
        let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
        let loaded = load_edge_project(
            &self.0,
            EdgeScope::Package,
            &self.0,
            None,
            &project_collation,
        )
        .unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
        let binary = TsgoBinary::from_native_preview_manifest(&manifest).unwrap();
        assemble_graph_with_edges(
            &loaded,
            Thresholds::default(),
            &binary,
            NodeFields::default(),
            &project_collation,
        )
        .unwrap()
    }
    fn references(&self) -> ReferenceResult {
        let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
        let loaded = load_edge_project(
            &self.0,
            EdgeScope::Package,
            &self.0,
            None,
            &project_collation,
        )
        .unwrap();
        let functions = demlik_code_graph::extract::functions::discover_functions(
            &loaded.project.source_files,
            &project_collation,
        )
        .unwrap()
        .functions;
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
        let binary = TsgoBinary::from_native_preview_manifest(&manifest).unwrap();
        let inputs = demlik_code_graph::extract::analysis::analysis_inputs(
            functions
                .iter()
                .map(demlik_code_graph::extract::analysis::NamedSymbol::from),
            &project_collation,
        )
        .unwrap();
        with_type_context(
            &binary,
            TypeContextInput {
                project: &loaded.project,
                ts_config_path: &loaded.ts_config_path,
                functions: &functions,
            },
            |context| {
                Ok(resolve_references(
                    context,
                    &inputs.names,
                    &inputs.exports_by_file,
                    &project_collation,
                )
                .unwrap())
            },
        )
        .unwrap()
    }
}

#[test]
fn distinguishes_dead_test_only_public_and_callback_exports_across_real_packages() {
    let project = Project::new(&[
        ("packages/a/package.json", r#"{"name":"a"}"#),
        ("packages/b/package.json", r#"{"name":"b"}"#),
        (
            "packages/a/index.ts",
            "export { facade } from './facade';\n",
        ),
        ("packages/a/facade.ts", "export function facade() {}\n"),
        (
            "packages/a/leaf.ts",
            "export function dead() {}\nexport function testOnly() {}\nexport function callback() {}\nexport function mentioned() {}\n",
        ),
        ("packages/a/helpers.ts", "export function testHelper() {}\n"),
        (
            "packages/a/leaf.test-d.ts",
            "import { testOnly } from './leaf'; testOnly();\n",
        ),
        (
            "packages/b/main.ts",
            "import { callback, mentioned } from '../a/leaf';\ndeclare function register(fn: () => void): void;\nregister(callback);\nexport type Name = { mentioned: number };\n",
        ),
    ]);
    let graph = project.graph();
    let refs = project.references();
    use demlik_code_graph::kinds::rules::{CompiledRule, JsRegex};
    let support = [CompiledRule {
        key: "helper".into(),
        patterns: vec![JsRegex::new(&"helpers\\.ts$".into()).unwrap()],
    }];
    let found = demlik_code_graph::query::unreachable::find_unreachable(
        &graph.functions,
        &graph.modules,
        &refs,
        &[],
        &support,
        &[],
        &Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(found.exported_count, 6);
    assert_eq!(
        found
            .unreachable
            .iter()
            .map(|row| (row.id.as_str(), &row.category))
            .map(|(id, kind)| (id, serde_json::to_string(kind).unwrap()))
            .collect::<Vec<_>>(),
        [
            ("packages/a/leaf.ts:dead", "\"dead\"".into()),
            (
                "packages/a/leaf.ts:testOnly",
                "\"only-called-from-tests\"".into()
            )
        ]
    );
    assert_eq!(
        found.unreachable[1].test_references,
        ["packages/a/leaf.test-d.ts"]
    );
    assert_eq!(
        found
            .withheld
            .iter()
            .map(|row| (row.id.as_str(), serde_json::to_string(&row.reason).unwrap()))
            .collect::<Vec<_>>(),
        [
            (
                "packages/a/facade.ts:facade",
                "\"public-entry-surface\"".into()
            ),
            (
                "packages/a/leaf.ts:mentioned",
                "\"referenced-in-non-test-file\"".into()
            ),
            (
                "packages/a/helpers.ts:testHelper",
                "\"test-support-surface\"".into()
            )
        ]
    );
    let width = demlik_code_graph::query::interface_width::find_interface_width(
        &graph.functions,
        &refs,
        &["packages/a".into(), "packages/b".into()],
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(width.len(), 1);
    assert_eq!(width[0].export_count, 6);
    assert_eq!(width[0].zero_consumer_count, 4);
    assert_eq!(
        width[0]
            .exports
            .iter()
            .find(|row| row.name == "callback")
            .unwrap()
            .external_consumers,
        ["packages/b/main.ts"]
    );
    let full = demlik_code_graph::query::reach::full_adjacency(
        &graph.functions,
        &refs.references_by_id,
        &Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(
        demlik_code_graph::query::reach::reachable_from(&full, &refs.module_scope_roots)
            .into_iter()
            .collect::<Vec<_>>(),
        ["packages/a/leaf.ts:callback"]
    );
}

#[test]
fn matches_rule_patterns_with_ecmascript_grammar_and_ucs2_units() {
    use demlik_code_graph::kinds::rules::JsRegex;
    assert!(
        JsRegex::new(&r"(?<=pre)(a)\1(?=post)".into())
            .unwrap()
            .test(&"preaapost".into())
    );
    assert!(!JsRegex::new(&"^.$".into()).unwrap().test(&"😀".into()));
    assert!(JsRegex::new(&"^..$".into()).unwrap().test(&"😀".into()));
    let surrogate = demlik_code_graph::text::JsString::from_units(vec![0xd83d]);
    assert!(JsRegex::new(&surrogate).unwrap().test(&"😀".into()));
    assert!(JsRegex::new(&"[".into()).is_err());
}

#[test]
fn clusters_real_call_triangles_and_excludes_isolated_and_test_modules() {
    let project = Project::new(&[
        (
            "left/a.ts",
            "import { b } from './b'; import { c } from '../right/c'; export function a() { b(); c(); b(); }",
        ),
        (
            "left/b.ts",
            "import { a } from './a'; import { c } from '../right/c'; export function b() { a(); c(); }",
        ),
        (
            "right/c.ts",
            "import { a } from '../left/a'; import { b } from '../left/b'; export function c() { a(); b(); }",
        ),
        (
            "right/d.ts",
            "import { e } from './e'; import { f } from '../left/f'; export function d() { e(); f(); }",
        ),
        (
            "right/e.ts",
            "import { d } from './d'; import { f } from '../left/f'; export function e() { d(); f(); }",
        ),
        (
            "left/f.ts",
            "import { d } from '../right/d'; import { e } from '../right/e'; export function f() { d(); e(); }",
        ),
        ("left/isolated.ts", "export function lonely() {}"),
        (
            "left/a.test-d.ts",
            "import { a } from './a'; export function test() { a(); }",
        ),
    ]);
    let graph = project.graph();
    let report = demlik_code_graph::query::clusters::build_cluster_report(
        &graph.functions,
        &graph.modules,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(report.modularity, 0.5);
    assert_eq!(report.cluster_count, 2);
    assert_eq!(report.clustered_file_count, 6);
    assert_eq!(report.isolated_file_count, 1);
    assert_eq!(report.excluded_test_file_count, 1);
    assert_eq!(
        report
            .scattered_clusters
            .iter()
            .map(|row| (row.id.as_str(), row.size, row.dir_count))
            .collect::<Vec<_>>(),
        [("c1", 3, 2), ("c2", 3, 2)]
    );
    assert_eq!(report.split_directories[0].dir, "left");
    assert_eq!(
        report.split_directories[0].isolated_files,
        ["left/isolated.ts"]
    );
    let edges = [demlik_code_graph::query::louvain::Edge {
        a: "x".into(),
        b: "y".into(),
        weight: 2.0,
    }];
    let partition = demlik_code_graph::query::louvain::louvain(
        &["x".into(), "y".into(), "z".into()],
        &edges,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(partition.membership["x"], partition.membership["y"]);
    assert_ne!(partition.membership["x"], partition.membership["z"]);
    assert_eq!(partition.modularity, 0.0);
}
impl Drop for Project {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if std::thread::panicking() {
                eprintln!(
                    "query fixture cleanup failed for {}: {error}",
                    self.0.display()
                );
            } else {
                panic!(
                    "query fixture cleanup failed for {}: {error}",
                    self.0.display()
                );
            }
        }
    }
}

#[test]
fn reports_a_public_unguarded_witness_even_when_other_reaches_have_shorter_paths() {
    let project = Project::new(&[(
        "entry.ts",
        "export function fetch() { guarded(); open(); }\nexport function rpc() { persist(); }\nexport function scheduled() { persist(); }\nfunction guarded() { persist(); }\nfunction open() { persist(); }\nexport function persist() { }\n",
    )]);
    let mut graph = project.graph();
    for function in &mut graph.functions {
        function.node_kind = Some(match function.name.as_str() {
            "fetch" => NodeKind::Entry {
                evidence: vec!["worker-handler".into()],
                guards: vec![],
                reach: EntryReach::Public,
            },
            "rpc" => NodeKind::Entry {
                evidence: vec!["rpc".into()],
                guards: vec![],
                reach: EntryReach::ServiceBinding,
            },
            "scheduled" => NodeKind::Entry {
                evidence: vec!["trigger".into()],
                guards: vec![],
                reach: EntryReach::Platform,
            },
            "guarded" => NodeKind::Auth {
                evidence: vec!["auth".into()],
            },
            "persist" => NodeKind::Effect {
                evidence: vec!["write".into()],
            },
            _ => NodeKind::Plain,
        });
    }
    let findings = demlik_code_graph::query::unguarded::find_unguarded(
        &graph.functions,
        &Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].entry_id, "entry.ts:fetch");
    assert_eq!(findings[0].effect_id, "entry.ts:persist");
    assert_eq!(
        findings[0].path,
        ["entry.ts:fetch", "entry.ts:open", "entry.ts:persist"]
    );
    assert!(matches!(findings[0].reach, EntryReach::Public));
    let adjacency = demlik_code_graph::query::reach::invoked_adjacency(
        &graph.functions,
        &Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let reachable = demlik_code_graph::query::reach::reachable_from(
        &adjacency,
        &["entry.ts:fetch".into(), "outside".into()],
    );
    assert_eq!(
        reachable.into_iter().collect::<Vec<_>>(),
        [
            "entry.ts:fetch",
            "outside",
            "entry.ts:guarded",
            "entry.ts:open",
            "entry.ts:persist"
        ]
    );
}
