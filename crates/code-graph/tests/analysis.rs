use demlik_code_graph::engine::tsgo::TsgoBinary;
use demlik_code_graph::extract::analysis::AnalysisOptions;
use demlik_code_graph::extract::assemble::{NodeFields, assemble_graph_with_analysis};
use demlik_code_graph::extract::package_exports::{
    package_name, package_source_entry, public_export_patterns, read_manifest,
};
use demlik_code_graph::kinds::rules::NodeKindRules;
use demlik_code_graph::project::{EdgeScope, load_edge_project};
use demlik_code_graph::schema::{NodeKind, Thresholds};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static ORDINAL: AtomicU64 = AtomicU64::new(0);
struct Project(PathBuf);
impl Project {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "demlik-analysis-{}-{}",
            std::process::id(),
            ORDINAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn write(&self, file: &str, text: &str) {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}
impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn reads_package_entry_targets_with_root_assignment_semantics_and_lossless_path_patterns() {
    let project = Project::new();
    project.write("pkg/package.json", r#"{"__proto__":{"name":"inherited","main":"./dist/public.js"},"exports":{"10":"./dist/second.d.ts","2":"./dist/first.mjs","nested":{"__proto__":"./dist/raw.cjs"},"wildcard":"./dist/*.js","raw":"./\ud800/../src/valid.js"}}"#);
    for file in [
        "pkg/src/public.ts",
        "pkg/src/first.ts",
        "pkg/src/second.ts",
        "pkg/src/raw.ts",
        "pkg/src/valid.ts",
    ] {
        project.write(file, "export {};\n");
    }
    let manifest = read_manifest(&project.0, "pkg").unwrap();
    assert_eq!(package_name(&manifest).unwrap(), "inherited");
    assert!(
        !serde_json::to_string(&manifest)
            .unwrap()
            .contains("inherited")
    );
    assert_eq!(
        package_source_entry(
            &project.0,
            "pkg",
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
        )
        .unwrap()
        .unwrap(),
        "pkg/src/first.ts"
    );
    let patterns =
        public_export_patterns(&project.0, &project.0.join("pkg"), &["pkg".into()]).unwrap();
    assert_eq!(patterns.len(), 6);
    for file in [
        "src/public.ts",
        "src/first.ts",
        "src/second.ts",
        "src/raw.ts",
        "src/valid.ts",
        "src/other.tsx",
    ] {
        assert!(
            patterns.iter().any(|pattern| pattern.test_str(file)),
            "{file}"
        );
    }
    assert!(
        !patterns
            .iter()
            .any(|pattern| pattern.test_str("outside.ts"))
    );
    project.write("raw/package.json", r#"{"main":"src/\ud800.js"}"#);
    project.write("raw/src/\u{fffd}.ts", "export {};\n");
    let mut expected = "raw/src/".encode_utf16().collect::<Vec<_>>();
    expected.push(0xd800);
    expected.extend(".ts".encode_utf16());
    assert_eq!(
        package_source_entry(
            &project.0,
            "raw",
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
        )
        .unwrap()
        .unwrap()
        .units(),
        expected
    );
    let raw_patterns =
        public_export_patterns(&project.0, &project.0.join("raw"), &["raw".into()]).unwrap();
    assert!(!raw_patterns[0].test_str("src/\u{fffd}.ts"));
}

#[test]
fn assembles_requested_analysis_reports_from_real_compiler_edges_and_package_surfaces() {
    let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
    let project = Project::new();
    for (file, text) in [
        (
            "tsconfig.json",
            r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
        ),
        (
            "package.json",
            r#"{"name":"app","exports":{".":"./dist/public.js"}}"#,
        ),
        (
            "wrangler.json",
            r#"{"name":"worker","main":"src/entry.ts"}"#,
        ),
        (
            "src/entry.ts",
            "import { writeRecord } from './store';\nexport function fetch() { return writeRecord(); }\n",
        ),
        (
            "src/store.ts",
            "import { db } from 'drizzle-orm';\nexport function writeRecord() { return db.insert('t'); }\nexport function dead() { return 0; }\n",
        ),
        (
            "src/public.ts",
            "export function apiHelper() { return 0; }\n",
        ),
        (
            "node_modules/drizzle-orm/package.json",
            r#"{"name":"drizzle-orm","version":"0.0.0","types":"index.d.ts"}"#,
        ),
        (
            "node_modules/drizzle-orm/index.d.ts",
            "export declare class PgDatabase { insert(table: unknown): unknown; }\nexport declare const db: PgDatabase;\n",
        ),
    ] {
        project.write(file, text);
    }
    let loaded = load_edge_project(
        &project.0,
        EdgeScope::Package,
        &project.0,
        None,
        &project_collation,
    )
    .unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
    let binary = TsgoBinary::from_native_preview_manifest(&manifest).unwrap();
    let rules = NodeKindRules::default();
    let options = AnalysisOptions {
        cross_runtime: true,
        kinds: true,
        reach: true,
        clusters: true,
        interface_width: true,
        kind_rules: &rules,
        repo_root: &project.0,
    };
    let graph = assemble_graph_with_analysis(
        &loaded,
        Thresholds::default(),
        &binary,
        NodeFields { headers: true },
        &options,
        &project_collation,
    )
    .unwrap();
    assert_eq!(graph.functions.len(), 4);
    assert!(matches!(
        graph
            .functions
            .iter()
            .find(|node| node.name == "fetch")
            .unwrap()
            .node_kind,
        Some(NodeKind::Entry { .. })
    ));
    assert!(matches!(
        graph
            .functions
            .iter()
            .find(|node| node.name == "writeRecord")
            .unwrap()
            .node_kind,
        Some(NodeKind::Effect { .. })
    ));
    assert_eq!(
        graph.cross_runtime.as_ref().unwrap().config_files,
        ["wrangler.json"]
    );
    let reach = graph.reachability.as_ref().unwrap();
    assert_eq!(
        (
            reach.entry_count,
            reach.exported_count,
            reach.reachable_count
        ),
        (1, 4, 2)
    );
    assert_eq!(
        reach
            .unreachable
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["src/store.ts:dead"]
    );
    assert_eq!(
        reach
            .withheld
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["src/public.ts:apiHelper"]
    );
    assert_eq!(reach.unguarded.len(), 1);
    let width = graph.interface_width.as_ref().unwrap();
    assert_eq!((width.total_exports, width.total_zero_consumer), (4, 4));
    let clusters = graph.clusters.as_ref().unwrap();
    assert_eq!(
        (
            clusters.cluster_count,
            clusters.clustered_file_count,
            clusters.isolated_file_count
        ),
        (1, 2, 1)
    );
    assert!(graph.data.is_none());
    let none = AnalysisOptions {
        cross_runtime: false,
        kinds: false,
        reach: false,
        clusters: false,
        interface_width: false,
        kind_rules: &rules,
        repo_root: &project.0,
    };
    let plain = assemble_graph_with_analysis(
        &loaded,
        Thresholds::default(),
        &binary,
        NodeFields::default(),
        &none,
        &project_collation,
    )
    .unwrap();
    assert!(
        plain.cross_runtime.is_none()
            && plain.reachability.is_none()
            && plain.clusters.is_none()
            && plain.interface_width.is_none()
    );
    assert!(plain.functions.iter().all(|node| node.node_kind.is_none()));
}
