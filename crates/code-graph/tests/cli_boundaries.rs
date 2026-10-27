use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, BoundaryDispatch, GatePreflightDispatch, HexagonDispatch, LayerDispatch,
            Preparation, PreparedGatesCli, prepare_cli,
        },
        io::CliIo,
    },
    engine::tsgo::TsgoBinary,
    text::{JsString, JsValue},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Project {
    root: PathBuf,
    scope: JsString,
    app: JsString,
}
impl Project {
    fn new(scope: JsString) -> Self {
        let root = loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-cli-boundary-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => break fs::canonicalize(root).unwrap(),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("fixture directory: {error}"),
            }
        };
        let mut app = JsString::from(root.to_string_lossy().as_ref());
        app.push_str("/");
        app.extend(&scope);
        fs::write(root.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
        let project = Self { root, scope, app };
        for (name, source) in [
            (
                "alpha/index.ts",
                "export {run} from './application/run.js';\n",
            ),
            ("alpha/ports.ts", "export interface Clock {now():number}\n"),
            (
                "alpha/application/run.ts",
                "import {secret} from '../../beta/application/private.js'; export const run=()=>secret;\n",
            ),
            (
                "beta/index.ts",
                "export {secret} from './application/private.js';\n",
            ),
            ("beta/ports.ts", "export interface Store {read():number}\n"),
            ("beta/application/private.ts", "export const secret=1;\n"),
        ] {
            let file = PathBuf::from(project.app.to_lossy()).join("src").join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, source).unwrap();
        }
        fs::write(
            PathBuf::from(project.app.to_lossy()).join("tsconfig.json"),
            r#"{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"},"include":["src/**/*.ts"]}"#,
        )
        .unwrap();
        project.rules(&project.scope);
        project
    }
    fn rules(&self, scope: &JsString) {
        fs::write(
            self.root.join("rules.json"),
            format!(
                r#"{{"features":{{{}:["alpha","beta"]}}}}"#,
                serde_json::to_string(scope).unwrap()
            ),
        )
        .unwrap();
    }
    fn prepare(&self, flags: &[&str], host: &mut CliIo<'_>) -> Box<PreparedGatesCli> {
        let mut argv = vec![
            self.app.clone(),
            "--boundaries".into(),
            "--boundary-rules".into(),
            self.root
                .join("rules.json")
                .to_string_lossy()
                .as_ref()
                .into(),
            "--json".into(),
        ];
        argv.extend(flags.iter().map(|flag| JsString::from(*flag)));
        prepared(&argv, host)
    }
}
fn prepared(argv: &[JsString], host: &mut CliIo<'_>) -> Box<PreparedGatesCli> {
    let Preparation::Prepared(prepared) = prepare_cli(argv, None, host).unwrap() else {
        panic!("path/config refused")
    };
    let ApiDispatch::Continue(prepared) = prepared
        .dispatch_api_blocking(&TsgoBinary::pinned("/unused/no-compiler"), host)
        .unwrap()
    else {
        panic!("API active")
    };
    let HexagonDispatch::Continue(prepared) = prepared.dispatch_hexagon(host).unwrap() else {
        panic!("hexagon active")
    };
    let GatePreflightDispatch::Continue(prepared) = prepared.prepare_gates(host).unwrap() else {
        panic!("ledger preparation refused")
    };
    let LayerDispatch::Continue(prepared) = prepared.dispatch_layers(host).unwrap() else {
        panic!("layers active")
    };
    prepared
}
impl Drop for Project {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root)
            && !std::thread::panicking()
        {
            panic!("fixture cleanup: {error}");
        }
    }
}

#[test]
fn boundaries_run_the_existing_gate_and_preserve_the_cli_exit() {
    let project = Project::new("apps/site".into());
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let prepared = project.prepare(&["--ci"], &mut host);
    let BoundaryDispatch::Complete(result) = prepared.dispatch_boundaries(&mut host).unwrap()
    else {
        panic!("boundaries inactive")
    };
    assert_eq!(result.exit_code, 1);
    assert_eq!(host.normal_exit_code(), 1);
    drop(host);
    let payload = JsValue::parse(std::str::from_utf8(&stdout).unwrap()).unwrap();
    assert_eq!(payload.get("scopesChecked").unwrap().as_number(), Some(1.0));
    let unrecorded = payload.get("unrecorded").unwrap().as_array().unwrap();
    assert_eq!(unrecorded.len(), 1);
    assert_eq!(
        unrecorded[0].get("kind").unwrap().as_string().unwrap(),
        "cross-feature"
    );
    assert_eq!(
        unrecorded[0].get("to").unwrap().as_string().unwrap(),
        "apps/site/src/beta/application/private.ts"
    );
    assert!(stderr.is_empty());
}

#[test]
fn a_raw_cli_scope_is_selected_before_its_filesystem_spelling_is_replaced() {
    let mut scope = JsString::from("apps/raw");
    scope.extend(&JsString::from_units(vec![0xd800]));
    let project = Project::new(scope.clone());
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let prepared = project.prepare(&[], &mut host);
    let BoundaryDispatch::Complete(result) = prepared.dispatch_boundaries(&mut host).unwrap()
    else {
        panic!("boundaries inactive")
    };
    assert_eq!(result.exit_code, 0);
    drop(host);
    let payload = JsValue::parse(std::str::from_utf8(&stdout).unwrap()).unwrap();
    let scopes = payload.get("scopes").unwrap().as_array().unwrap();
    assert_eq!(scopes.len(), 1, "Source selects the raw declared scope");
    assert_eq!(scopes[0].get("scope").unwrap().as_string().unwrap(), &scope);
    assert_eq!(
        scopes[0].get("filesScanned").unwrap().as_number(),
        Some(6.0)
    );
    assert!(stderr.is_empty());
}

#[test]
fn a_raw_self_root_keeps_sources_import_comparisons_without_changing_path_callers() {
    use demlik_code_graph::boundaries::gate::{BoundaryFlags, BoundaryGateArgs, run_boundary_gate};
    let mut scope = JsString::from("apps/raw");
    scope.extend(&JsString::from_units(vec![0xd800]));
    let project = Project::new(scope);
    let app_native = PathBuf::from(project.app.to_lossy());
    fs::write(app_native.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
    project.rules(&".".into());
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let prepared = project.prepare(&[], &mut host);
    let BoundaryDispatch::Complete(result) = prepared.dispatch_boundaries(&mut host).unwrap()
    else {
        panic!("boundaries inactive")
    };
    assert_eq!(result.exit_code, 0);
    drop(host);
    let payload = JsValue::parse(std::str::from_utf8(&stdout).unwrap()).unwrap();
    let scopes = payload.get("scopes").unwrap().as_array().unwrap();
    assert_eq!(scopes.len(), 1);
    assert_eq!(
        scopes[0].get("filesScanned").unwrap().as_number(),
        Some(6.0)
    );
    assert_eq!(
        scopes[0]
            .get("violations")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        0,
        "Source keeps a resolved filesystem spelling outside the raw logical root"
    );
    assert!(stderr.is_empty());

    let rules = JsString::from(project.root.join("rules.json").to_string_lossy().as_ref());
    let legacy = run_boundary_gate(
        BoundaryGateArgs {
            root_absolute: &app_native,
            repo_root: &app_native,
            boundary_rules_file: Some(&rules),
            flags: BoundaryFlags::default(),
            json: true,
            pretty: false,
        },
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let payload = JsValue::parse_js(&legacy.emitted[0]).unwrap();
    assert_eq!(
        payload.get("scopes").unwrap().as_array().unwrap()[0]
            .get("violations")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1,
        "the existing Path gate and import resolver retain their filesystem behavior"
    );
}

#[test]
fn a_boundary_schema_type_error_escapes_with_its_original_cause() {
    use demlik_code_graph::{
        boundaries::{config::BoundaryConfigError, gate::BoundaryGateError},
        cli::frontdoor::FrontdoorError,
    };
    use std::error::Error;
    let project = Project::new("apps/site".into());
    fs::write(project.root.join("rules.json"), r#"{"features":{"apps/site":["alpha","beta"]},"bindingOwners":{"apps/site":{"constructor":null}}}"#).unwrap();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let prepared = project.prepare(&[], &mut host);
    let error = prepared.dispatch_boundaries(&mut host).unwrap_err();
    assert_eq!(error.name(), "TypeError");
    assert_eq!(
        error.message(),
        "Cannot read properties of null (reading 'prototype')"
    );
    let FrontdoorError::Boundaries(BoundaryGateError::Config(BoundaryConfigError::RecordType(
        original,
    ))) = &error
    else {
        panic!("original typed boundary failure was lost")
    };
    let cause = error.source().unwrap().source().unwrap().source().unwrap();
    assert!(std::ptr::eq(
        cause
            .downcast_ref::<demlik_code_graph::validation::RecordTypeError>()
            .unwrap(),
        original
    ));
    assert_eq!(host.exit_state().stored_code(), Some(7));
    drop(host);
    assert!(stdout.is_empty() && stderr.is_empty());
}

#[test]
fn inactive_boundaries_keep_the_same_carrier_and_do_not_read_their_rules() {
    let project = Project::new("apps/site".into());
    fs::write(project.root.join("rules.json"), "{broken").unwrap();
    let argv = vec![
        project.app.clone(),
        "--graph".into(),
        "--boundary-rules".into(),
        project
            .root
            .join("rules.json")
            .to_string_lossy()
            .as_ref()
            .into(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let before = prepared(&argv, &mut host);
    let carrier = std::ptr::from_ref(before.as_ref());
    let original = std::ptr::from_ref(before.prepared.as_ref());
    fs::remove_file(project.root.join("pnpm-workspace.yaml")).unwrap();
    let BoundaryDispatch::Continue(after) = before.dispatch_boundaries(&mut host).unwrap() else {
        panic!("inactive boundaries ran")
    };
    assert_eq!(carrier, std::ptr::from_ref(after.as_ref()));
    assert_eq!(original, std::ptr::from_ref(after.prepared.as_ref()));
    assert_eq!(after.prepared.options.graph(), Some(true));
    assert_eq!(after.repo_root, project.root.to_string_lossy().as_ref());
    assert_eq!(host.normal_exit_code(), 7);
    drop(host);
    assert!(stdout.is_empty() && stderr.is_empty());
}

#[test]
fn boundaries_observe_the_workspace_marker_again_after_preparation() {
    let project = Project::new("apps/site".into());
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let prepared = project.prepare(&[], &mut host);
    assert_eq!(prepared.repo_root, project.root.to_string_lossy().as_ref());
    fs::remove_file(project.root.join("pnpm-workspace.yaml")).unwrap();
    let BoundaryDispatch::Complete(result) = prepared.dispatch_boundaries(&mut host).unwrap()
    else {
        panic!("boundaries inactive")
    };
    assert_eq!(result.exit_code, 0);
    drop(host);
    let payload = JsValue::parse(std::str::from_utf8(&stdout).unwrap()).unwrap();
    let scopes = payload.get("scopes").unwrap().as_array().unwrap();
    assert_eq!(scopes.len(), 1);
    assert_eq!(
        scopes[0].get("filesScanned").unwrap().as_number(),
        Some(0.0)
    );
    assert!(
        scopes[0]
            .get("violations")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(stderr.is_empty());
}

#[test]
fn acceptance_is_written_before_a_file_output_failure_escapes() {
    use demlik_code_graph::{api::map::ApiError, cli::frontdoor::FrontdoorError};
    let project = Project::new("apps/site".into());
    let out = project
        .root
        .join("missing/report.json")
        .to_string_lossy()
        .into_owned();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let prepared = project.prepare(
        &[
            "--accept-crossings",
            "--reason",
            "temporary debt",
            "--out",
            &out,
        ],
        &mut host,
    );
    let error = prepared.dispatch_boundaries(&mut host).unwrap_err();
    let FrontdoorError::BoundaryEmit(ApiError::Io { path, source }) = error else {
        panic!("the actual file error was lost")
    };
    assert_eq!(path, out.as_str());
    assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(host.exit_state().stored_code(), Some(7));
    let ledger =
        JsValue::parse(&fs::read_to_string(project.root.join("boundary-ledger.json")).unwrap())
            .unwrap();
    let entries = ledger.get("entries").unwrap().as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].get("reason").unwrap().as_string().unwrap(),
        "temporary debt"
    );
    drop(host);
    assert!(stdout.is_empty() && stderr.is_empty());
}
