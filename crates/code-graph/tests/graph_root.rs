use demlik_code_graph::{
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::AnalysisOptions,
        assemble::{NodeFields, assemble_graph, assemble_graph_with_analysis_text},
    },
    kinds::rules::NodeKindRules,
    project::{EdgeScope, load_edge_project_text},
    render::json::stable_stringify,
    schema::{Graph, Thresholds},
    text::{JsString, JsValue},
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-graph-root-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => break fs::canonicalize(root).unwrap(),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("create fixture: {error}"),
            }
        };
        assert!(
            Command::new("git")
                .args(["init", "--quiet", "--template="])
                .arg(&root)
                .status()
                .unwrap()
                .success()
        );
        fs::write(
            root.join("tsconfig.json"),
            r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
        )
        .unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir_all(root.join("ignored/raw�")).unwrap();
        fs::write(
            root.join("ignored/raw�/sentinel.ts"),
            "export function ignored(){return 9;}\n",
        )
        .unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove fixture: {error}");
        }
    }
}
fn root_of(graph: &Graph) -> &JsString {
    &graph.root
}

#[test]
fn intentionally_ignored_source_keeps_raw_root_and_explicit_value_boundary() {
    let fixture = Fixture::new();
    let binary = TsgoBinary::from_native_preview_manifest(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json"),
    )
    .unwrap();
    let rules = NodeKindRules::default();
    let options = AnalysisOptions {
        cross_runtime: false,
        kinds: false,
        reach: false,
        clusters: false,
        interface_width: false,
        kind_rules: &rules,
        repo_root: &fixture.0,
    };
    for unit in [0xd800, 0xdfff] {
        let mut raw = JsString::from(fixture.0.to_string_lossy().as_ref());
        raw.push_str("/ignored/raw");
        raw.extend(&JsString::from_units(vec![unit]));
        let loaded = load_edge_project_text(&raw, EdgeScope::Package, &fixture.0, None).unwrap();
        assert!(loaded.project.source_files.is_empty());
        assert!(fixture.0.join("ignored/raw�/sentinel.ts").is_file());
        let graph = assemble_graph_with_analysis_text(
            &loaded,
            &raw,
            Thresholds::default(),
            &binary,
            NodeFields::default(),
            &options,
        )
        .unwrap();
        assert_eq!(root_of(&graph).units().last(), Some(&unit));
        assert_eq!(graph.stats.file_count, 0);
        for json in [
            serde_json::to_string(&graph).unwrap(),
            serde_json::to_string_pretty(&graph).unwrap(),
            stable_stringify(&graph, false).unwrap(),
            stable_stringify(&graph, true).unwrap(),
        ] {
            let parsed = JsValue::parse(&json).unwrap();
            assert_eq!(
                parsed.get("root").unwrap().as_string(),
                Some(root_of(&graph))
            );
        }
        assert!(serde_json::to_value(&graph).is_err());
        let legacy = assemble_graph(
            &loaded.project,
            Thresholds::default(),
            NodeFields::default(),
        )
        .unwrap();
        assert_eq!(root_of(&legacy).units().last(), Some(&0xfffd));
        assert!(serde_json::to_value(&legacy).is_ok());
    }
}
