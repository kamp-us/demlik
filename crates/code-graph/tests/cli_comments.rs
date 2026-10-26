use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, BoundaryDispatch, CommentDispatch, EnvKeyDispatch, GatePreflightDispatch,
            HexagonDispatch, LayerDispatch, Preparation, PreparedGatesCli, prepare_cli,
        },
        io::CliIo,
    },
    comments::gate::CommentGateResult,
    engine::tsgo::TsgoBinary,
    text::JsString,
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
    fn new() -> Self {
        let root = loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-comment-cli-{}-{}",
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
        for (dir, source) in [
            (
                "packages/api",
                "// API prose\nexport const a=1;\nexport const b=2;\n",
            ),
            ("packages/billing", "// billing prose\nexport const b=1;\n"),
            (
                "packages/auth",
                "// @vitest-environment happy-dom\nexport const c=1;\n",
            ),
            (
                "fixtures/demo",
                "// fixture prose\n// fixture detail\nexport const d=1;\n",
            ),
        ] {
            workspace.put(&format!("{dir}/package.json"), "{}");
            workspace.put(&format!("{dir}/src/index.ts"), source);
        }
        workspace
    }
    fn put(&self, file: &str, text: &str) {
        let file = self.root.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    fn args(&self, flags: &[&str]) -> Vec<JsString> {
        let mut args = vec![
            self.root.to_string_lossy().as_ref().into(),
            "--comments".into(),
        ];
        args.extend(flags.iter().map(|s| JsString::from(*s)));
        args
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
fn prepare(args: &[JsString], io: &mut CliIo<'_>) -> Box<PreparedGatesCli> {
    let Preparation::Prepared(p) = prepare_cli(args, None, io).unwrap() else {
        panic!("preflight refused")
    };
    let ApiDispatch::Continue(p) = p
        .dispatch_api_blocking(&TsgoBinary::pinned("/not-installed-tsgo"), io)
        .unwrap()
    else {
        panic!("API active")
    };
    let HexagonDispatch::Continue(p) = p.dispatch_hexagon(io).unwrap() else {
        panic!("hexagon active")
    };
    let GatePreflightDispatch::Continue(p) = p.prepare_gates(io).unwrap() else {
        panic!("gate preflight refused")
    };
    let LayerDispatch::Continue(p) = p.dispatch_layers(io).unwrap() else {
        panic!("layers active")
    };
    let BoundaryDispatch::Continue(p) = p.dispatch_boundaries(io).unwrap() else {
        panic!("boundaries active")
    };
    let EnvKeyDispatch::Continue(p) = p.dispatch_env_keys(io).unwrap() else {
        panic!("env active")
    };
    p
}
fn run(args: &[JsString], io: &mut CliIo<'_>) -> CommentGateResult {
    let CommentDispatch::Complete(result) = prepare(args, io).dispatch_comments(io).unwrap() else {
        panic!("comments inactive")
    };
    result
}
#[test]
fn operator_records_three_packages_repeats_ci_and_writes_the_view_without_go() {
    let w = Workspace::new();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let record = run(&w.args(&["--write-ceilings"]), &mut io);
    assert_eq!(record.exit_code, 0);
    let expected = "{\n  \"default\": 40,\n  \"scopes\": {\n    \"packages/api\": 50,\n    \"packages/auth\": 0,\n    \"packages/billing\": 100\n  },\n  \"slackPoints\": 2\n}\n";
    assert_eq!(
        fs::read_to_string(w.root.join("comment-ceilings.json")).unwrap(),
        expected
    );
    run(
        &w.args(&["--write-ceilings", "--json", "--pretty"]),
        &mut io,
    );
    assert_eq!(
        fs::read_to_string(w.root.join("comment-ceilings.json")).unwrap(),
        expected
    );
    let mut ci_args = w.args(&["--ci", "--json", "--pretty"]);
    ci_args.push("--out".into());
    ci_args.push(w.root.join("report.json").to_string_lossy().as_ref().into());
    let ci = run(&ci_args, &mut io);
    assert_eq!(ci.exit_code, 0);
    assert_eq!(
        fs::read_to_string(w.root.join("report.json")).unwrap(),
        "{\n  \"defaultCeiling\": 40,\n  \"inheritedScopes\": 0,\n  \"passed\": true,\n  \"scopesChecked\": 3,\n  \"slackPoints\": 2,\n  \"violations\": []\n}\n"
    );
    assert_eq!(io.exit_state().stored_code(), Some(7));
    drop(io);
    assert!(
        String::from_utf8(stdout)
            .unwrap()
            .contains("wrote 3 scope ceiling(s)")
    );
    assert!(
        String::from_utf8(stderr)
            .unwrap()
            .starts_with("code-graph: wrote ")
    );
}

#[test]
fn raw_self_root_policy_refusal_keeps_the_original_filename_until_output() {
    let w = Workspace::new();
    w.put("raw�/pnpm-workspace.yaml", "packages: []\n");
    w.put("raw�/src/index.ts", "// prose\nexport const x=1;\n");
    let mut root = JsString::from(w.root.to_string_lossy().as_ref());
    root.push_str("/raw");
    root.extend(&JsString::from_units(vec![0xd800]));
    let args = [root.clone(), "--comments".into(), "--ci".into()];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut stdout, &mut stderr, None);
    let result = run(&args, &mut io);
    assert_eq!(result.exit_code, 2);
    assert_eq!(result.reports.len(), 1);
    assert!(
        result.reports[0].units().contains(&0xd800),
        "original raw policy filename was erased: {:?}",
        result.reports[0]
    );
    let mut expected = JsString::from("cannot read config file \"");
    expected.extend(&root);
    expected.push_str("/comment-ceilings.json\".");
    assert_eq!(result.reports[0], expected);
}

#[test]
fn raw_self_root_recording_acknowledges_the_original_filename() {
    let w = Workspace::new();
    w.put("raw�/pnpm-workspace.yaml", "packages: []\n");
    w.put("raw�/src/index.ts", "// prose\nexport const x=1;\n");
    let mut root = JsString::from(w.root.to_string_lossy().as_ref());
    root.push_str("/raw");
    root.extend(&JsString::from_units(vec![0xd800]));
    let args = [root.clone(), "--comments".into(), "--write-ceilings".into()];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut stdout, &mut stderr, None);
    let result = run(&args, &mut io);
    assert_eq!(result.exit_code, 0);
    assert!(w.root.join("raw�/comment-ceilings.json").is_file());
    let mut expected = JsString::from("wrote 1 scope ceiling(s) to ");
    expected.extend(&root);
    expected.push_str("/comment-ceilings.json\n");
    assert_eq!(result.emitted, [expected]);
}

#[test]
fn comment_policy_type_error_preserves_its_name_message_and_original_cause() {
    use demlik_code_graph::{
        cli::frontdoor::FrontdoorError, comments::gate::CommentGateError,
        validation::RecordTypeError,
    };
    use std::error::Error;
    let w = Workspace::new();
    w.put(
        "comment-ceilings.json",
        r#"{"scopes":{"constructor":null}}"#,
    );
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let error = prepare(&w.args(&["--ci"]), &mut io)
        .dispatch_comments(&mut io)
        .unwrap_err();
    assert_eq!(error.name(), "TypeError");
    assert_eq!(
        error.message(),
        "Cannot read properties of null (reading 'prototype')"
    );
    let FrontdoorError::Comments(gate @ CommentGateError::Record(record)) = &error else {
        panic!("lost record cause: {error:?}")
    };
    assert!(std::ptr::eq(
        gate.source()
            .unwrap()
            .downcast_ref::<RecordTypeError>()
            .unwrap(),
        record
    ));
    assert_eq!(io.exit_state().stored_code(), Some(7));
    drop(io);
    assert!(stdout.is_empty() && stderr.is_empty());
}

#[test]
fn inactive_comments_returns_both_original_boxes_and_does_not_read_policy() {
    let w = Workspace::new();
    w.put(
        "comment-ceilings.json",
        r#"{"scopes":{"constructor":null}}"#,
    );
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let args = [
        JsString::from(w.root.to_string_lossy().as_ref()),
        "--collapse".into(),
        "--json".into(),
    ];
    let prepared = prepare(&args, &mut io);
    let carrier = std::ptr::from_ref(prepared.as_ref());
    let inner = std::ptr::from_ref(prepared.prepared.as_ref());
    let CommentDispatch::Continue(prepared) = prepared.dispatch_comments(&mut io).unwrap() else {
        panic!("inactive comments ran")
    };
    assert!(std::ptr::eq(carrier, prepared.as_ref()));
    assert!(std::ptr::eq(inner, prepared.prepared.as_ref()));
    assert_eq!(prepared.prepared.options.collapse(), Some(true));
    assert_eq!(io.exit_state().stored_code(), Some(7));
    drop(io);
    assert!(stdout.is_empty() && stderr.is_empty());
}

#[test]
fn second_repository_lookup_selects_the_actual_subpackage_write_destination() {
    let w = Workspace::new();
    let prior = r#"{"default":17,"slackPoints":3,"scopes":{"old":90}}"#;
    w.put("comment-ceilings.json", prior);
    let args = [
        JsString::from(w.root.join("packages/api").to_string_lossy().as_ref()),
        "--comments".into(),
        "--write-ceilings".into(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut io = CliIo::new(&mut stdout, &mut stderr, None);
    let prepared = prepare(&args, &mut io);
    fs::remove_file(w.root.join("pnpm-workspace.yaml")).unwrap();
    let CommentDispatch::Complete(result) = prepared.dispatch_comments(&mut io).unwrap() else {
        panic!("comments inactive")
    };
    assert_eq!(result.exit_code, 0);
    assert_eq!(
        fs::read_to_string(w.root.join("comment-ceilings.json")).unwrap(),
        prior
    );
    assert_eq!(
        fs::read_to_string(w.root.join("packages/api/comment-ceilings.json")).unwrap(),
        "{\n  \"default\": 40,\n  \"scopes\": {\n    \".\": 50\n  },\n  \"slackPoints\": 2\n}\n"
    );
}
