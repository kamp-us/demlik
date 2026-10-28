use demlik_code_graph::checker::context::{TypeContextInput, with_type_context_text};
use demlik_code_graph::engine::tsgo::{TsgoBinary, TsgoError};
use demlik_code_graph::extract::analysis::{AnalysisError, AnalysisOptions};
use demlik_code_graph::extract::assemble::{
    AssemblyError, NodeFields, assemble_graph_with_analysis, assemble_graph_with_analysis_text,
};
use demlik_code_graph::extract::functions::discover_functions;
use demlik_code_graph::extract::wrangler_config::CatalogError;
use demlik_code_graph::kinds::glob::glob_to_regexp;
use demlik_code_graph::kinds::rules::NodeKindRules;
use demlik_code_graph::project::{EdgeScope, LoadedEdgeProject, load_edge_project_text};
use demlik_code_graph::schema::{Graph, Provenance, Thresholds};
use demlik_code_graph::text::JsString;
use demlik_code_graph::validation::RecordTypeError;
use std::{
    cell::Cell,
    error::Error,
    fs,
    path::{Path, PathBuf},
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Project(PathBuf);
impl Project {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-assembly-text-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(fs::canonicalize(path).unwrap()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("create fixture: {error}"),
            }
        }
    }
    fn write(&self, file: impl AsRef<Path>, text: &str) {
        let file = self.0.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    fn populate(&self, directory: &str, own_config: bool) -> PathBuf {
        if own_config {
            self.write(
                Path::new(directory).join("tsconfig.json"),
                "{\"compilerOptions\":{\"strict\":true,\"types\":[]}}\n",
            );
        }
        for (file, text) in [
            ("limits.ts", "export const LIMIT=3;\n"),
            (
                "helpers.ts",
                "export function choose(n:number,max:number) { return n>=max?'stop':'retry'; }\n",
            ),
            (
                "entry.ts",
                "import {LIMIT} from './limits.js';\nimport {choose} from './helpers.js';\nexport function run() { return choose(1,LIMIT); }\n",
            ),
        ] {
            self.write(Path::new(directory).join(file), text);
        }
        self.0.join(directory)
    }
    fn raw_child(&self) -> JsString {
        let mut text = JsString::from(self.0.to_string_lossy().as_ref());
        text.push_str("/raw");
        text.extend(&JsString::from_units(vec![0xd800]));
        text
    }
}
impl Drop for Project {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove fixture: {error}");
        }
    }
}
fn binary() -> TsgoBinary {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
    TsgoBinary::from_native_preview_manifest(&manifest).unwrap()
}
fn loaded(root: &JsString, repo: &Path) -> LoadedEdgeProject {
    let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
    load_edge_project_text(root, EdgeScope::Package, repo, None, &project_collation).unwrap()
}
fn options<'a>(rules: &'a NodeKindRules, repo: &'a Path) -> AnalysisOptions<'a> {
    AnalysisOptions {
        cross_runtime: true,
        kinds: true,
        reach: false,
        clusters: false,
        interface_width: false,
        kind_rules: rules,
        repo_root: repo,
    }
}
fn assert_decision_graph(graph: &Graph) {
    assert_eq!(graph.modules.len(), 3);
    assert_eq!(graph.functions.len(), 2);
    let run = graph
        .functions
        .iter()
        .find(|node| node.name == "run")
        .unwrap();
    let calls = &run.edges.as_ref().unwrap().calls;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].callee_id, "helpers.ts:choose");
    assert_eq!(calls[0].const_args, ["LIMIT"]);
}
fn assert_backend(error: &TsgoError, expected_method: &str) {
    assert!(
        matches!(error, TsgoError::Compiler { method, .. } if method == expected_method),
        "actual backend error: {error:?}"
    );
    assert!(error.to_string().contains("invalid surrogate pair"));
}
fn catalog_record(error: &AssemblyError) -> &RecordTypeError {
    match error {
        AssemblyError::Analysis(AnalysisError::Catalog(CatalogError::Record(source))) => source,
        _ => panic!("{error:?}"),
    }
}

#[test]
fn public_text_context_keeps_borrowed_rc_state_and_real_semantic_facts() {
    let project = Project::new();
    let native = project.populate("ordinary", true);
    let root = JsString::from(native.to_string_lossy().as_ref());
    let loaded = loaded(&root, &project.0);
    let functions = discover_functions(
        &loaded.project.source_files,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap()
    .functions;
    let visits = Rc::new(Cell::new(0));
    let borrowed = String::from("run");
    let count = with_type_context_text(
        &binary(),
        TypeContextInput {
            project: &loaded.project,
            ts_config_path: &loaded.ts_config_path,
            functions: &functions,
        },
        &root,
        |context| {
            visits.set(visits.get() + 1);
            assert!(context.unjoined.is_empty());
            assert!(
                context
                    .node_to_id
                    .values()
                    .any(|id| id.ends_with(&borrowed))
            );
            Ok(context.files.len())
        },
    )
    .unwrap();
    assert_eq!(count, 3);
    assert_eq!(visits.get(), 1);
    let rules = NodeKindRules::default();
    let arguments = options(&rules, &project.0);
    let text = assemble_graph_with_analysis_text(
        &loaded,
        &root,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_decision_graph(&text);
    let legacy = assemble_graph_with_analysis(
        &loaded,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(text).unwrap(),
        serde_json::to_value(legacy).unwrap()
    );
}

#[test]
fn selected_config_provenance_uses_the_same_normalized_text_sent_to_go() {
    let project = Project::new();
    let native = project.populate("ordinary", true);
    fs::create_dir(project.0.join("unused\u{fffd}")).unwrap();
    let mut root = JsString::from(project.0.to_string_lossy().as_ref());
    root.push_str("/unused");
    root.extend(&JsString::from_units(vec![0xd800]));
    root.push_str("/../ordinary");
    let loaded = loaded(&root, &project.0);
    let rules = NodeKindRules::default();
    let arguments = options(&rules, &project.0);
    let graph = assemble_graph_with_analysis_text(
        &loaded,
        &root,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_decision_graph(&graph);
    let Provenance::Edges { ts_config, .. } = &graph.provenance else {
        panic!("expected edge provenance")
    };
    assert_eq!(ts_config, &native.join("tsconfig.json").to_string_lossy());
}

#[test]
fn raw_config_text_reaches_real_go_while_replacement_and_native_paths_stay_valid() {
    let project = Project::new();
    let native = project.populate("raw\u{fffd}", true);
    let root = project.raw_child();
    let loaded = loaded(&root, &project.0);
    let functions = discover_functions(
        &loaded.project.source_files,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap()
    .functions;
    let context = with_type_context_text(
        &binary(),
        TypeContextInput {
            project: &loaded.project,
            ts_config_path: &loaded.ts_config_path,
            functions: &functions,
        },
        &root,
        |_| Ok(()),
    )
    .unwrap_err();
    assert_backend(&context, "parseConfigFile");
    let rules = NodeKindRules::default();
    let arguments = options(&rules, &project.0);
    let error: AssemblyError = assemble_graph_with_analysis_text(
        &loaded,
        &root,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap_err();
    let AssemblyError::Compiler(ref compiler) = error else {
        panic!("{error:?}")
    };
    assert_backend(compiler, "parseConfigFile");
    let replacement = JsString::from(native.to_string_lossy().as_ref());
    let text = assemble_graph_with_analysis_text(
        &loaded,
        &replacement,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_decision_graph(&text);
    let legacy = assemble_graph_with_analysis(
        &loaded,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(text).unwrap(),
        serde_json::to_value(legacy).unwrap()
    );
}

#[test]
fn raw_source_lookup_survives_an_ascii_ancestor_config() {
    let project = Project::new();
    project.write(
        "tsconfig.json",
        "{\"compilerOptions\":{\"strict\":true,\"types\":[]}}\n",
    );
    let native = project.populate("raw\u{fffd}", false);
    let root = project.raw_child();
    let loaded = loaded(&root, &project.0);
    let functions = discover_functions(
        &loaded.project.source_files,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap()
    .functions;
    let context = with_type_context_text(
        &binary(),
        TypeContextInput {
            project: &loaded.project,
            ts_config_path: &loaded.ts_config_path,
            functions: &functions,
        },
        &root,
        |_| Ok(()),
    )
    .unwrap_err();
    assert_backend(&context, "getSourceFile");
    let rules = NodeKindRules::default();
    let arguments = options(&rules, &project.0);
    let error: AssemblyError = assemble_graph_with_analysis_text(
        &loaded,
        &root,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap_err();
    let AssemblyError::Compiler(ref compiler) = error else {
        panic!("{error:?}")
    };
    assert_backend(compiler, "getSourceFile");
    let replacement = JsString::from(native.to_string_lossy().as_ref());
    let text = assemble_graph_with_analysis_text(
        &loaded,
        &replacement,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_decision_graph(&text);
    let legacy = assemble_graph_with_analysis(
        &loaded,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &arguments,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(text).unwrap(),
        serde_json::to_value(legacy).unwrap()
    );
}

#[test]
fn real_catalog_type_error_retains_its_type_message_and_original_source() {
    let project = Project::new();
    let native = project.populate("worker", true);
    project.write(
        "wrangler.json",
        "{\"name\":\"worker\",\"vars\":{\"constructor\":null}}\n",
    );
    let root = JsString::from(native.to_string_lossy().as_ref());
    let loaded = loaded(&root, &project.0);
    let rules = NodeKindRules::default();
    let error: AssemblyError = assemble_graph_with_analysis_text(
        &loaded,
        &root,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        &options(&rules, &project.0),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap_err();
    let original = catalog_record(&error);
    assert_eq!(error.name(), "TypeError");
    assert_eq!(
        error.message(),
        "Cannot read properties of null (reading 'prototype')"
    );
    let projected = error
        .source()
        .unwrap()
        .source()
        .unwrap()
        .source()
        .unwrap()
        .downcast_ref::<RecordTypeError>()
        .unwrap();
    assert!(std::ptr::eq(original, projected));
}

#[test]
fn analysis_and_assembly_projection_keep_an_actual_raw_glob_refusal() {
    let mut pattern = JsString::from("{");
    pattern.extend(&JsString::from_units(vec![0xd800]));
    let original = glob_to_regexp(&pattern).unwrap_err();
    let analysis = AnalysisError::Convention(original);
    let expected = JsString::from_units(
        "unclosed \"{\" in glob \""
            .encode_utf16()
            .chain(pattern.units().iter().copied())
            .chain([u16::from(b'"')])
            .collect(),
    );
    assert_eq!(analysis.name(), "Error");
    assert_eq!(analysis.message(), expected);
    assert!(analysis.source().is_some());
    let assembly = AssemblyError::Analysis(analysis);
    assert_eq!(assembly.name(), "Error");
    assert_eq!(assembly.message(), expected);
    assert!(assembly.source().unwrap().source().is_some());
}
