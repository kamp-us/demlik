use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, GatePreflightDispatch, HexagonDispatch, LayerDispatch, Preparation,
            prepare_cli,
        },
        io::CliIo,
    },
    engine::tsgo::TsgoBinary,
    text::JsString,
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Project {
    root: PathBuf,
    app: JsString,
    relative: JsString,
}
impl Project {
    fn new(raw: bool) -> Self {
        let root = loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-cli-layer-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => break fs::canonicalize(path).unwrap(),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => panic!("fixture: {e}"),
            }
        };
        let mut relative = JsString::from(if raw { "packages/raw" } else { "packages/app" });
        if raw {
            relative.extend(&JsString::from_units(vec![0xd800]));
        }
        let mut app = JsString::from(root.to_string_lossy().as_ref());
        app.push_str("/");
        app.extend(&relative);
        fs::write(root.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
        for (name, source) in [
            (
                "ui/screen.ts",
                "import { useCase } from '../service/use-case.js';\nimport type { ViewModel } from './view-model.js';\nimport 'node:fs';\nimport './missing.js';\nexport const screen=useCase;",
            ),
            ("ui/view-model.ts", "export type ViewModel={id:string};"),
            (
                "service/use-case.ts",
                "import type {Entity} from '../domain/entity.js';\nimport type {ViewModel} from '../ui/view-model.js';\nexport const useCase=(v:ViewModel):Entity=>v;",
            ),
            (
                "service/local.ts",
                "import {useCase} from './use-case.js';\nexport const local=useCase;",
            ),
            ("domain/entity.ts", "export type Entity={id:string};"),
            (
                "domain/store.ts",
                "import {useCase} from '../service/use-case.js';\nexport const store=useCase;",
            ),
        ] {
            let file = PathBuf::from(app.to_lossy()).join("src").join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, source).unwrap();
        }
        let project = Self {
            root,
            app,
            relative,
        };
        project.rules(false);
        project
    }
    fn rules(&self, self_root: bool) {
        let prefix = if self_root {
            JsString::default()
        } else {
            let mut value = self.relative.clone();
            value.push_str("/");
            value
        };
        let layers: Vec<_> = ["ui", "service", "domain"]
            .into_iter()
            .map(|name| {
                let mut path = prefix.clone();
                path.push_str("src/");
                path.push_str(name);
                demlik_code_graph::layers::rules::Layer {
                    name: name.into(),
                    paths: vec![path],
                }
            })
            .collect();
        fs::write(
            self.root.join("rules.json"),
            serde_json::to_vec(&demlik_code_graph::layers::rules::LayerRules {
                layers,
                allowed: vec![],
            })
            .unwrap(),
        )
        .unwrap();
    }
    fn prepare(
        &self,
        host: &mut CliIo<'_>,
    ) -> Box<demlik_code_graph::cli::frontdoor::PreparedGatesCli> {
        let args = vec![
            self.app.clone(),
            "--layers".into(),
            "--layer-rules".into(),
            self.root
                .join("rules.json")
                .to_string_lossy()
                .as_ref()
                .into(),
            "--json".into(),
        ];
        prepared(&args, host)
    }
}
fn prepared(
    args: &[JsString],
    host: &mut CliIo<'_>,
) -> Box<demlik_code_graph::cli::frontdoor::PreparedGatesCli> {
    let Preparation::Prepared(prepared) = prepare_cli(args, None, host).unwrap() else {
        panic!("path/config refused")
    };
    let ApiDispatch::Continue(prepared) = prepared
        .dispatch_api_blocking(&TsgoBinary::pinned("/missing/unused/compiler"), host)
        .unwrap()
    else {
        panic!("API active")
    };
    let HexagonDispatch::Continue(prepared) = prepared.dispatch_hexagon(host).unwrap() else {
        panic!("hexagon active")
    };
    let GatePreflightDispatch::Continue(prepared) = prepared.prepare_gates(host).unwrap() else {
        panic!("ledger refused")
    };
    prepared
}
impl Drop for Project {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.root)
            && !std::thread::panicking()
        {
            panic!("fixture cleanup: {e}");
        }
    }
}
#[test]
fn a_raw_application_root_keeps_its_layer_claims_and_import_sites() {
    let project = Project::new(true);
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let prepared = project.prepare(&mut host);
    let LayerDispatch::Complete(result) = prepared.dispatch_layers(&mut host).unwrap() else {
        panic!("layers inactive")
    };
    assert_eq!(result.exit_code, 1);
    assert_eq!(host.normal_exit_code(), 1);
    drop(host);
    let report =
        demlik_code_graph::text::JsValue::parse(std::str::from_utf8(&stdout).unwrap()).unwrap();
    assert_eq!(
        report.get("census").unwrap().get("up").unwrap().as_number(),
        Some(2.0)
    );
    assert_eq!(
        report
            .get("census")
            .unwrap()
            .get("unlayered")
            .unwrap()
            .as_number(),
        Some(0.0)
    );
    assert_eq!(report.get("filesScanned").unwrap().as_number(), Some(6.0));
    let raw =
        demlik_code_graph::text::JsValue::parse(std::str::from_utf8(&stdout).unwrap()).unwrap();
    let from = raw.get("violations").unwrap().as_array().unwrap()[0]
        .get("from")
        .unwrap()
        .as_string()
        .unwrap();
    assert!(from.units().contains(&0xd800));
    assert!(stderr.is_empty());
}

#[test]
fn a_raw_self_root_keeps_the_sources_external_alias_classification() {
    let project = Project::new(true);
    let app = PathBuf::from(project.app.to_lossy());
    fs::write(app.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
    project.rules(true);
    fs::write(
        app.join("tsconfig.json"),
        r#"{"compilerOptions":{"baseUrl":".","paths":{"@local/*":["src/*"]}}}"#,
    )
    .unwrap();
    let file = app.join("src/service/use-case.ts");
    let source = fs::read_to_string(&file)
        .unwrap()
        .replace("../domain/entity.js", "@local/domain/entity.js");
    fs::write(file, source).unwrap();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let prepared = project.prepare(&mut host);
    let LayerDispatch::Complete(result) = prepared.dispatch_layers(&mut host).unwrap() else {
        panic!("layers inactive")
    };
    assert_eq!(result.exit_code, 1);
    drop(host);
    let report =
        demlik_code_graph::text::JsValue::parse(std::str::from_utf8(&stdout).unwrap()).unwrap();
    let census = report.get("census").unwrap();
    assert_eq!(census.get("external").unwrap().as_number(), Some(2.0));
    assert_eq!(census.get("down").unwrap().as_number(), Some(1.0));
    assert_eq!(census.get("up").unwrap().as_number(), Some(2.0));
    assert!(stderr.is_empty());
}

#[test]
fn layers_observe_the_workspace_marker_again_after_ledger_preparation() {
    let project = Project::new(false);
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let prepared = project.prepare(&mut host);
    assert_eq!(
        prepared.repo_root,
        JsString::from(project.root.to_string_lossy().as_ref())
    );
    fs::remove_file(project.root.join("pnpm-workspace.yaml")).unwrap();
    let LayerDispatch::Complete(result) = prepared.dispatch_layers(&mut host).unwrap() else {
        panic!("layers inactive")
    };
    assert_eq!(result.exit_code, 0);
    drop(host);
    let report =
        demlik_code_graph::text::JsValue::parse(std::str::from_utf8(&stdout).unwrap()).unwrap();
    assert_eq!(
        report
            .get("census")
            .unwrap()
            .get("unlayered")
            .unwrap()
            .as_number(),
        Some(6.0)
    );
    assert!(stderr.is_empty());
}

#[test]
fn inactive_layers_return_the_same_prepared_carrier_without_reading_rules() {
    let project = Project::new(false);
    fs::write(project.root.join("rules.json"), "{broken").unwrap();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let args = vec![
        project.app.clone(),
        "--graph".into(),
        "--layer-rules".into(),
        project
            .root
            .join("rules.json")
            .to_string_lossy()
            .as_ref()
            .into(),
    ];
    let before = prepared(&args, &mut host);
    let carrier = std::ptr::from_ref(before.as_ref());
    let original = std::ptr::from_ref(before.prepared.as_ref());
    let LayerDispatch::Continue(after) = before.dispatch_layers(&mut host).unwrap() else {
        panic!("inactive layers ran")
    };
    assert_eq!(carrier, std::ptr::from_ref(after.as_ref()));
    assert_eq!(original, std::ptr::from_ref(after.prepared.as_ref()));
    assert_eq!(after.prepared.options.graph(), Some(true));
    assert_eq!(host.normal_exit_code(), 7);
    drop(host);
    assert!(stdout.is_empty() && stderr.is_empty());
}

#[test]
fn a_file_output_error_escapes_before_the_gate_assigns_its_exit_code() {
    use demlik_code_graph::{api::map::ApiError, cli::frontdoor::FrontdoorError};
    let project = Project::new(false);
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let args = vec![
        project.app.clone(),
        "--layers".into(),
        "--layer-rules".into(),
        project
            .root
            .join("rules.json")
            .to_string_lossy()
            .as_ref()
            .into(),
        "--out".into(),
        project.app.clone(),
    ];
    let error = prepared(&args, &mut host)
        .dispatch_layers(&mut host)
        .unwrap_err();
    let FrontdoorError::LayerEmit(ApiError::Io { path, source }) = error else {
        panic!("file failure was replaced: {error:?}")
    };
    assert_eq!(path, project.app);
    assert_eq!(source.kind(), std::io::ErrorKind::IsADirectory);
    assert_eq!(host.exit_state().stored_code(), Some(7));
    drop(host);
    assert!(stdout.is_empty() && stderr.is_empty());
}

#[test]
fn the_file_exists_when_a_local_banner_writer_fails_and_the_failure_stays_pending() {
    use std::{
        cell::Cell,
        io::{self, Write},
        rc::Rc,
    };
    struct Banner {
        file: PathBuf,
        observed: Rc<Cell<bool>>,
    }
    impl Write for Banner {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            self.observed.set(self.file.is_file());
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "banner witness"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let project = Project::new(false);
    let output = project.root.join("result.json");
    let observed = Rc::new(Cell::new(false));
    let mut banner = Banner {
        file: output.clone(),
        observed: Rc::clone(&observed),
    };
    let mut stdout = Vec::new();
    let mut host = CliIo::new(&mut stdout, &mut banner, None);
    let args = vec![
        project.app.clone(),
        "--layers".into(),
        "--json".into(),
        "--layer-rules".into(),
        project
            .root
            .join("rules.json")
            .to_string_lossy()
            .as_ref()
            .into(),
        "--out".into(),
        output.to_string_lossy().as_ref().into(),
    ];
    let LayerDispatch::Complete(result) = prepared(&args, &mut host)
        .dispatch_layers(&mut host)
        .unwrap()
    else {
        panic!("layers inactive")
    };
    assert_eq!(result.exit_code, 1);
    assert!(observed.get());
    assert_eq!(host.exit_state().requested_code(), Some(1.0));
    assert_eq!(host.pending_stdio_failures().len(), 1);
    assert_eq!(
        host.pending_stdio_failures()[0].source.kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(host.normal_exit_code(), 1);
    let report =
        demlik_code_graph::text::JsValue::parse(&fs::read_to_string(output).unwrap()).unwrap();
    assert_eq!(
        report.get("census").unwrap().get("up").unwrap().as_number(),
        Some(2.0)
    );
    drop(host);
    assert!(stdout.is_empty());
}

#[test]
fn the_existing_path_gate_keeps_its_supplied_filesystem_spelling() {
    use demlik_code_graph::layers::gate::{LayerGateArgs, run_layer_gate};
    let project = Project::new(true);
    let app = PathBuf::from(project.app.to_lossy());
    let file: JsString = project
        .root
        .join("rules.json")
        .to_string_lossy()
        .as_ref()
        .into();
    let result = run_layer_gate(
        LayerGateArgs {
            root_absolute: &app,
            repo_root: &project.root,
            layer_rules_file: Some(&file),
            json: true,
            pretty: false,
        },
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(result.exit_code, 0);
    let report =
        demlik_code_graph::text::JsValue::parse(&result.emitted[0].to_utf8().unwrap()).unwrap();
    assert_eq!(
        report
            .get("census")
            .unwrap()
            .get("unlayered")
            .unwrap()
            .as_number(),
        Some(6.0)
    );
}
