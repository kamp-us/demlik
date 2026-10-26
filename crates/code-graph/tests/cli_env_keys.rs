use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, BoundaryDispatch, EnvKeyDispatch, GatePreflightDispatch, HexagonDispatch,
            LayerDispatch, Preparation, PreparedGatesCli, prepare_cli,
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
struct Workspace {
    root: PathBuf,
}
impl Workspace {
    fn empty() -> Self {
        let root = loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-env-cli-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => break fs::canonicalize(root).unwrap(),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => panic!("fixture: {e}"),
            }
        };
        let workspace = Self { root };
        workspace.put("pnpm-workspace.yaml", "packages: []\n");
        workspace
    }
    fn new() -> Self {
        let workspace = Self::empty();
        for (file, body) in [
            (
                "workers/api/wrangler.jsonc",
                r#"{"name":"api","vars":{"API_KEY":"x"}}"#,
            ),
            (
                "workers/api/src/index.ts",
                "export const read=(env: Env)=>env.API_KEY;",
            ),
            (
                "workers/billing/wrangler.toml",
                "name=\"billing\"\n[vars]\nSTRIPE_KEY=\"x\"\nLEGACY_FLAG=\"x\"\n",
            ),
            (
                "workers/billing/src/index.ts",
                "export const read=(env: Env)=>env.STRIPE_KEY;",
            ),
            (
                "workers/auth/wrangler.jsonc",
                r#"{"name":"auth","vars":{"SESSION_SECRET":"x","JWT_ISSUER":"x"},"d1_databases":[{"binding":"DB"],"services":[]}"#,
            ),
            (
                "workers/auth/src/index.ts",
                "export const read=(env: Env)=>[env.SESSION_SECRET,env.JWT_ISSUER];",
            ),
            (
                "workers/api/edge/wrangler.jsonc",
                r#"{"name":"edge" "vars":{"EDGE_TOKEN":"x"}}"#,
            ),
            (
                "workers/api/edge/src/index.ts",
                "export const read=(env: Env)=>env.EDGE_TOKEN;",
            ),
        ] {
            workspace.put(file, body);
        }
        workspace
    }
    fn put(&self, file: &str, body: &str) {
        let file = self.root.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, body).unwrap();
    }
    fn args(&self, flags: &[&str]) -> Vec<JsString> {
        let mut argv = vec![
            self.root.to_string_lossy().as_ref().into(),
            "--env-keys".into(),
            "--json".into(),
        ];
        argv.extend(flags.iter().map(|f| JsString::from(*f)));
        argv
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.root)
            && !std::thread::panicking()
        {
            panic!("fixture cleanup: {e}")
        }
    }
}
fn prepare(argv: &[JsString], host: &mut CliIo<'_>) -> Box<PreparedGatesCli> {
    let Preparation::Prepared(prepared) = prepare_cli(argv, None, host).unwrap() else {
        panic!("preparation refused")
    };
    let ApiDispatch::Continue(prepared) = prepared
        .dispatch_api_blocking(&TsgoBinary::pinned("/unused/no-go"), host)
        .unwrap()
    else {
        panic!("API active")
    };
    let HexagonDispatch::Continue(prepared) = prepared.dispatch_hexagon(host).unwrap() else {
        panic!("hexagon active")
    };
    let GatePreflightDispatch::Continue(prepared) = prepared.prepare_gates(host).unwrap() else {
        panic!("gate preparation refused")
    };
    let LayerDispatch::Continue(prepared) = prepared.dispatch_layers(host).unwrap() else {
        panic!("layers active")
    };
    let BoundaryDispatch::Continue(prepared) = prepared.dispatch_boundaries(host).unwrap() else {
        panic!("boundaries active")
    };
    prepared
}
#[test]
fn four_workers_report_their_real_mismatches_without_a_compiler_or_gate_exit() {
    let workspace = Workspace::new();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut out, &mut err, Some(7));
    let prepared = prepare(&workspace.args(&[]), &mut io);
    let EnvKeyDispatch::Complete(report) = prepared.dispatch_env_keys(&mut io).unwrap() else {
        panic!("env inactive")
    };
    assert_eq!(report.declared_count, 3.0);
    assert_eq!(report.read_count, 5.0);
    assert_eq!(report.declared_unreferenced.len(), 1);
    assert_eq!(report.declared_unreferenced[0].key, "LEGACY_FLAG");
    assert_eq!(report.withheld.len(), 3);
    assert!(report.read_not_declared.is_empty());
    assert_eq!(io.exit_state().stored_code(), Some(7));
    drop(io);
    let payload = JsValue::parse(std::str::from_utf8(&out).unwrap()).unwrap();
    assert_eq!(
        payload
            .get("unparsedConfigs")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(payload.get("declaredCount").unwrap().as_number(), Some(3.0));
    assert!(err.is_empty());
}

#[test]
fn destructuring_and_typed_parameters_keep_the_source_syntactic_rules() {
    let workspace = Workspace::empty();
    workspace.put("wrangler.jsonc", r#"{"name":"worker","vars":{"KEY":"x","LITERAL":"x","DESTRUCT":"x","DEFAULT":"x","ONLY_TEXT":"x","DYNAMIC":"x"}}"#);
    workspace.put("src/index.ts", "export const read=(env: Env, ctx: any)=>[env.KEY,process.env.KEY,ctx.env.BAG,ctx.process.env.PROC,env['LITERAL'],env[dynamic],env?.OPTIONAL,process?.env.ODD];\nconst {DESTRUCT: renamed,...rest}=env;\nfunction typed({DEFAULT=1}: Env = {}) {}\nfunction ignored({DYNAMIC}: SomeEnv) {}\nconst note='ONLY_TEXT';");
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut out, &mut err, None);
    let EnvKeyDispatch::Complete(report) = prepare(&workspace.args(&[]), &mut io)
        .dispatch_env_keys(&mut io)
        .unwrap()
    else {
        panic!("env inactive")
    };
    assert_eq!(report.declared_count, 6.0);
    assert_eq!(report.read_count, 10.0);
    assert!(report.declared_unreferenced.is_empty());
    assert_eq!(
        report
            .read_not_declared
            .iter()
            .map(|r| r.key.to_lossy())
            .collect::<Vec<_>>(),
        ["BAG", "ODD", "OPTIONAL", "rest"]
    );
    assert_eq!(
        report
            .withheld
            .iter()
            .map(|r| r.key.to_lossy())
            .collect::<Vec<_>>(),
        ["DYNAMIC", "ONLY_TEXT"]
    );
}

#[test]
fn catalog_type_errors_keep_their_name_message_and_original_cause() {
    use demlik_code_graph::{
        cli::frontdoor::FrontdoorError, env_keys::EnvKeyError,
        extract::wrangler_config::CatalogError,
    };
    use std::error::Error;
    let workspace = Workspace::empty();
    workspace.put(
        "wrangler.jsonc",
        r#"{"name":"bad","vars":{"constructor":null}}"#,
    );
    workspace.put("src/index.ts", "env.UNKNOWN;");
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut out, &mut err, Some(9));
    let error = prepare(&workspace.args(&[]), &mut io)
        .dispatch_env_keys(&mut io)
        .unwrap_err();
    assert_eq!(error.name(), "TypeError");
    assert_eq!(
        error.message(),
        "Cannot read properties of null (reading 'prototype')"
    );
    let FrontdoorError::EnvKeys(EnvKeyError::Catalog(catalog @ CatalogError::Record(record))) =
        &error
    else {
        panic!("lost catalog cause: {error:?}")
    };
    assert!(std::ptr::eq(
        catalog.source().unwrap().downcast_ref().unwrap(),
        record
    ));
    assert_eq!(io.exit_state().stored_code(), Some(9));
    drop(io);
    assert!(out.is_empty() && err.is_empty());
}

#[test]
fn inactive_env_keys_returns_the_same_carrier_without_reading_the_bad_catalog() {
    let workspace = Workspace::empty();
    workspace.put(
        "wrangler.jsonc",
        r#"{"name":"bad","vars":{"constructor":null}}"#,
    );
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut out, &mut err, Some(7));
    let args = vec![
        workspace.root.to_string_lossy().as_ref().into(),
        "--json".into(),
        "--comments".into(),
    ];
    let prepared = prepare(&args, &mut io);
    let carrier = std::ptr::from_ref(prepared.as_ref());
    let original = std::ptr::from_ref(prepared.prepared.as_ref());
    let EnvKeyDispatch::Continue(prepared) = prepared.dispatch_env_keys(&mut io).unwrap() else {
        panic!("inactive mode ran")
    };
    assert!(std::ptr::eq(carrier, prepared.as_ref()));
    assert!(std::ptr::eq(original, prepared.prepared.as_ref()));
    assert_eq!(io.exit_state().stored_code(), Some(7));
    drop(io);
    assert!(out.is_empty() && err.is_empty());
}

#[test]
fn env_dispatch_performs_the_second_repository_lookup() {
    let workspace = Workspace::new();
    let argv = [
        workspace
            .root
            .join("workers/api")
            .to_string_lossy()
            .as_ref()
            .into(),
        "--env-keys".into(),
        "--json".into(),
    ];
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut out, &mut err, None);
    let prepared = prepare(&argv, &mut io);
    fs::remove_file(workspace.root.join("pnpm-workspace.yaml")).unwrap();
    let EnvKeyDispatch::Complete(report) = prepared.dispatch_env_keys(&mut io).unwrap() else {
        panic!("env inactive")
    };
    assert_eq!(report.declared_count, 1.0);
    assert_eq!(report.read_count, 2.0);
    assert_eq!(report.unparsed_configs, ["edge/wrangler.jsonc"]);
    assert_eq!(
        report.withheld[0].reason.as_str(),
        "read-site-owner-unparsed"
    );
}

#[test]
fn raw_scope_prefix_is_preserved_for_a_read_under_its_parsed_ancestor() {
    let workspace = Workspace::empty();
    workspace.put("workers/api/wrangler.jsonc", r#"{"name":"api","vars":{}}"#);
    workspace.put("workers/api/nested�/src/index.ts", "env.UNKNOWN;");
    let mut target = JsString::from(workspace.root.to_string_lossy().as_ref());
    target.push_str("/workers/api/nested");
    target.extend(&JsString::from_units(vec![0xd800]));
    let argv = [target, "--env-keys".into(), "--json".into()];
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut out, &mut err, None);
    let EnvKeyDispatch::Complete(report) =
        prepare(&argv, &mut io).dispatch_env_keys(&mut io).unwrap()
    else {
        panic!("env inactive")
    };
    let mut file = JsString::from("workers/api/nested");
    file.extend(&JsString::from_units(vec![0xd800]));
    file.push_str("/src/index.ts");
    assert_eq!(report.read_not_declared[0].file, file);
    assert_eq!(report.read_not_declared[0].service, "api");
    assert!(report.withheld.is_empty());
}
