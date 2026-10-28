use super::{
    AssemblyError, NodeFields, TextAssembly, assemble_graph_with_analysis_text_and_warning,
};
use crate::{
    engine::tsgo::TsgoBinary,
    extract::analysis::AnalysisOptions,
    kinds::rules::NodeKindRules,
    project::{EdgeScope, load_edge_project_text},
    schema::Thresholds,
    text::JsString,
};
use std::{
    cell::RefCell,
    fs,
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-warning-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => return Self(fs::canonicalize(root).unwrap()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("create fixture: {error}"),
            }
        }
    }
    fn write(&self, file: &str, text: &str) {
        fs::write(self.0.join(file), text).unwrap();
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
fn binary() -> TsgoBinary {
    TsgoBinary::from_native_preview_manifest(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json"),
    )
    .unwrap()
}
#[test]
fn local_warning_consumer_keeps_borrowed_rc_state() {
    let fixture = Fixture::new();
    fixture.write(
        "tsconfig.json",
        r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
    );
    fixture.write("escaped.ts","export interface \\u0055 { value:number }\nexport const \\u0056=1;\nexport function run(){return 1;}\n");
    let root = JsString::from(fixture.0.to_string_lossy().as_ref());
    let loaded = load_edge_project_text(&root, EdgeScope::Package, &fixture.0, None).unwrap();
    let rules = NodeKindRules::default();
    let options = AnalysisOptions {
        cross_runtime: true,
        kinds: true,
        reach: false,
        clusters: false,
        interface_width: false,
        kind_rules: &rules,
        repo_root: &fixture.0,
    };
    let transcript = Rc::new(RefCell::new(Vec::<JsString>::new()));
    let borrowed = String::from("code-graph: warning:");
    let mut warning = |line: &JsString| {
        assert!(line.to_lossy().starts_with(&borrowed));
        transcript.borrow_mut().push(line.clone());
    };
    let graph = assemble_graph_with_analysis_text_and_warning(
        &loaded,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        Some(&options),
        None,
        TextAssembly {
            root: &root,
            warning: &mut warning,
        },
        &crate::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(graph.functions.len(), 1);
    assert_eq!(
        transcript.borrow().as_slice(),
        &[JsString::from(
            "code-graph: warning: 2 declaration(s) have no node in tsgo's tree, so their uses are unknown: escaped.ts:interface:U, escaped.ts:constant:V\n"
        )]
    );
}

fn warning_fixture(fixture: &Fixture) -> (JsString, crate::project::LoadedEdgeProject) {
    fixture.write(
        "tsconfig.json",
        r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
    );
    let source = "export interface \\u0055 { value:number }\nexport const \\u0056=1;\nexport function run(){return 1;}\n";
    fixture.write("escaped.ts", source);
    let root = JsString::from(fixture.0.to_string_lossy().as_ref());
    let loaded = load_edge_project_text(&root, EdgeScope::Package, &fixture.0, None).unwrap();
    // A loaded syntax snapshot can precede a concurrent edit observed by the compiler.
    fixture.write(
        "escaped.ts",
        &format!("// edited after syntax load\n{source}"),
    );
    (root, loaded)
}

#[test]
fn function_warning_survives_later_analysis_failure_with_original_cause() {
    use crate::{
        extract::{analysis::AnalysisError, wrangler_config::CatalogError},
        validation::RecordTypeError,
    };
    use std::error::Error;
    let fixture = Fixture::new();
    let (root, loaded) = warning_fixture(&fixture);
    fixture.write(
        "wrangler.json",
        r#"{"name":"worker","vars":{"constructor":null}}"#,
    );
    let rules = NodeKindRules::default();
    let options = AnalysisOptions {
        cross_runtime: true,
        kinds: true,
        reach: false,
        clusters: false,
        interface_width: false,
        kind_rules: &rules,
        repo_root: &fixture.0,
    };
    let warnings = Rc::new(RefCell::new(Vec::new()));
    let borrowed = String::from("calls are not resolved");
    let mut warning = |line: &JsString| {
        assert!(line.to_lossy().contains(&borrowed));
        warnings.borrow_mut().push(line.clone());
        fixture.write("warning-observed.txt", &line.to_lossy());
    };
    let error = assemble_graph_with_analysis_text_and_warning(
        &loaded,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        Some(&options),
        None,
        TextAssembly {
            root: &root,
            warning: &mut warning,
        },
        &crate::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap_err();
    assert_eq!(
        warnings.borrow().as_slice(),
        &[JsString::from(
            "code-graph: warning: 1 function(s) have no node in tsgo's tree, so their calls are not resolved: escaped.ts:run\n"
        )]
    );
    assert!(fixture.0.join("warning-observed.txt").exists());
    let AssemblyError::Analysis(
        analysis @ AnalysisError::Catalog(catalog @ CatalogError::Record(record)),
    ) = &error
    else {
        panic!("{error:?}");
    };
    assert_eq!(error.name(), "TypeError");
    assert_eq!(error.message(), record.message().clone());
    assert!(std::ptr::eq(
        error
            .source()
            .unwrap()
            .downcast_ref::<AnalysisError>()
            .unwrap(),
        analysis
    ));
    assert!(std::ptr::eq(
        analysis
            .source()
            .unwrap()
            .downcast_ref::<CatalogError>()
            .unwrap(),
        catalog
    ));
    assert!(std::ptr::eq(
        catalog
            .source()
            .unwrap()
            .downcast_ref::<RecordTypeError>()
            .unwrap(),
        record
    ));
}

#[cfg(unix)]
#[test]
fn warning_bridge_keeps_both_callbacks_and_pending_real_stdio_failure() {
    use crate::cli::io::{CliIo, StdioStream};
    use std::cell::Cell;
    let fixture = Fixture::new();
    let (root, loaded) = warning_fixture(&fixture);
    let mut stdout = Vec::new();
    let mut stderr = fs::File::open("/dev/null").unwrap();
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let visits = Rc::new(Cell::new(0));
    let rules = NodeKindRules::default();
    let options = AnalysisOptions {
        cross_runtime: true,
        kinds: true,
        reach: false,
        clusters: false,
        interface_width: false,
        kind_rules: &rules,
        repo_root: &fixture.0,
    };
    let mut warning = |line: &JsString| {
        visits.set(visits.get() + 1);
        host.write_stderr(line);
    };
    let graph = assemble_graph_with_analysis_text_and_warning(
        &loaded,
        Thresholds::default(),
        &binary(),
        NodeFields::default(),
        Some(&options),
        None,
        TextAssembly {
            root: &root,
            warning: &mut warning,
        },
        &crate::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(graph.functions.len(), 1);
    assert_eq!(visits.get(), 2);
    assert_eq!(host.exit_state().requested_code(), Some(7.0));
    assert_eq!(host.normal_exit_code(), 1);
    let pending = host.pending_stdio_failures();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].stream, StdioStream::Stderr);
    assert_eq!(pending[0].source.raw_os_error(), Some(9));
    assert_eq!(pending[0].suppressed_writes, 1);
    assert!(pending[0].attempted_bytes > 0);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Mode {
    Callback,
    DefaultText,
    DefaultPath,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    file: String,
    text: String,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    mode: Mode,
    root: JsString,
    repo_root: JsString,
    native_preview_manifest: String,
    kind_rules: crate::text::JsValue,
    #[serde(default)]
    after_load: Vec<Change>,
    cross_runtime: bool,
    kinds: bool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Thrown {
    stage: &'static str,
    name: &'static str,
    message: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend_method: Option<String>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    #[serde(skip_serializing_if = "Option::is_none")]
    graph: Option<crate::schema::Graph>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thrown: Option<Thrown>,
    warnings: Vec<JsString>,
    order: Vec<&'static str>,
    call: &'static str,
}
fn observe(request: Request) -> Result<Observation, String> {
    let rules = NodeKindRules::parse(&request.kind_rules).map_err(|error| error.to_string())?;
    let binary = TsgoBinary::from_native_preview_manifest(std::path::Path::new(
        &request.native_preview_manifest,
    ))
    .map_err(|error| error.to_string())?;
    let repo = PathBuf::from(request.repo_root.to_lossy());
    let call = match request.mode {
        Mode::Callback => "crate::extract::assemble::assemble_graph_with_analysis_text_and_warning",
        Mode::DefaultText => {
            "demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text"
        }
        Mode::DefaultPath => "demlik_code_graph::extract::assemble::assemble_graph_with_analysis",
    };
    for change in &request.after_load {
        if std::path::Path::new(&change.file).components().count() != 1
            || !matches!(
                std::path::Path::new(&change.file).components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err("afterLoad files must be fixture basenames".into());
        }
    }
    let mut out = Observation {
        graph: None,
        thrown: None,
        warnings: Vec::new(),
        order: Vec::new(),
        call: "demlik_code_graph::project::load_edge_project_text",
    };
    let loaded = match load_edge_project_text(&request.root, EdgeScope::Package, &repo, None) {
        Ok(loaded) => loaded,
        Err(error) => {
            out.thrown = Some(Thrown {
                stage: "load",
                name: "Error",
                message: error.message(),
                backend_method: None,
            });
            out.order.push("throw");
            return Ok(out);
        }
    };
    for change in request.after_load {
        fs::write(loaded.project.root_absolute.join(change.file), change.text)
            .map_err(|error| error.to_string())?;
    }
    let options = AnalysisOptions {
        cross_runtime: request.cross_runtime,
        kinds: request.kinds,
        reach: false,
        clusters: false,
        interface_width: false,
        kind_rules: &rules,
        repo_root: &repo,
    };
    out.call = call;
    let graph = match request.mode {
        Mode::Callback => {
            let mut warning = |line: &JsString| {
                out.warnings.push(line.clone());
                out.order.push("warning");
            };
            assemble_graph_with_analysis_text_and_warning(
                &loaded,
                Thresholds::default(),
                &binary,
                NodeFields::default(),
                Some(&options),
                None,
                TextAssembly {
                    root: &request.root,
                    warning: &mut warning,
                },
                &crate::project::Collation::try_node22_en_us().unwrap(),
            )
        }
        Mode::DefaultText => super::assemble_graph_with_analysis_text(
            &loaded,
            &request.root,
            Thresholds::default(),
            &binary,
            NodeFields::default(),
            &options,
            &crate::project::Collation::try_node22_en_us().unwrap(),
        ),
        Mode::DefaultPath => super::assemble_graph_with_analysis(
            &loaded,
            Thresholds::default(),
            &binary,
            NodeFields::default(),
            &options,
            &crate::project::Collation::try_node22_en_us().unwrap(),
        ),
    };
    match graph {
        Ok(graph) => {
            out.graph = Some(graph);
            out.order.push("graph");
        }
        Err(error) => {
            let backend_method = match &error {
                AssemblyError::Compiler(crate::engine::tsgo::TsgoError::Compiler {
                    method,
                    ..
                }) => Some(method.clone()),
                _ => None,
            };
            out.thrown = Some(Thrown {
                stage: "assembly",
                name: error.name(),
                message: error.message(),
                backend_method,
            });
            out.order.push("throw");
        }
    }
    Ok(out)
}

#[test]
fn observes_requested_assembly() {
    let Ok(input) = std::env::var("DEMLIK_ASSEMBLY_WARNING_REQUEST") else {
        let fixture = Fixture::new();
        fixture.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
        );
        fixture.write("ordinary.ts", "export function run(){ return 1; }\n");
        let root = JsString::from(fixture.0.to_string_lossy().as_ref());
        let observation = observe(Request {
            mode: Mode::Callback,
            root: root.clone(),
            repo_root: root,
            native_preview_manifest: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json")
                .to_string_lossy().into_owned(),
            kind_rules: crate::text::JsValue::Object(crate::text::JsObject::new()),
            after_load: Vec::new(), cross_runtime: true, kinds: true,
        }).unwrap();
        assert!(observation.graph.is_some());
        assert!(observation.warnings.is_empty());
        assert_eq!(observation.order, ["graph"]);
        return;
    };
    let report = std::env::var("DEMLIK_ASSEMBLY_WARNING_REPORT").expect("explicit report path");
    let result = std::fs::read_to_string(input)
        .map_err(|error| error.to_string())
        .and_then(|input| {
            serde_json::from_str::<Request>(&input).map_err(|error| error.to_string())
        })
        .and_then(observe);
    match result {
        Ok(observation) => fs::write(report, serde_json::to_vec(&observation).unwrap()).unwrap(),
        Err(message) => fs::write(
            report,
            serde_json::to_vec(&serde_json::json!({"protocol":{"message":message}})).unwrap(),
        )
        .unwrap(),
    }
}
