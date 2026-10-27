use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, BoundaryDispatch, CollapseDispatch, CommentDispatch, EnvKeyDispatch,
            FrontdoorError, GatePreflightDispatch, HexagonDispatch, LayerDispatch, Preparation,
            PreparedGatesCli, prepare_cli,
        },
        io::CliIo,
    },
    collapse::{ceilings::render_partial_twin_ratchet, gate::CollapseGateError},
    engine::tsgo::TsgoBinary,
    project::ProjectLoadError,
    ratchet::scope_count::{ScopeCount, ScopeCountCeilings, evaluate_scope_ratchet},
    text::JsString,
};
use std::{
    cell::RefCell,
    error::Error,
    fs,
    io::{self, Write},
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "demlik-collapse-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        fs::write(p.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
        Self(fs::canonicalize(p).unwrap())
    }
    fn args(&self, flags: &[&str]) -> Vec<JsString> {
        std::iter::once(self.0.to_string_lossy().as_ref().into())
            .chain(flags.iter().map(|s| (*s).into()))
            .collect()
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn prepared(workspace: &Workspace, flags: &[&str], host: &mut CliIo<'_>) -> Box<PreparedGatesCli> {
    let binary = TsgoBinary::pinned("/unused");
    let Preparation::Prepared(p) = prepare_cli(&workspace.args(flags), None, host).unwrap() else {
        panic!("prepare")
    };
    let ApiDispatch::Continue(p) = p.dispatch_api_blocking(&binary, host).unwrap() else {
        panic!("api")
    };
    let HexagonDispatch::Continue(p) = p.dispatch_hexagon(host).unwrap() else {
        panic!("hexagon")
    };
    let GatePreflightDispatch::Continue(p) = p.prepare_gates(host).unwrap() else {
        panic!("ledgers")
    };
    let LayerDispatch::Continue(p) = p.dispatch_layers(host).unwrap() else {
        panic!("layers")
    };
    let BoundaryDispatch::Continue(p) = p.dispatch_boundaries(host).unwrap() else {
        panic!("boundaries")
    };
    let EnvKeyDispatch::Continue(p) = p.dispatch_env_keys(host).unwrap() else {
        panic!("env")
    };
    let CommentDispatch::Continue(p) = p.dispatch_comments(host).unwrap() else {
        panic!("comments")
    };
    p
}
#[test]
fn inactive_and_plain_collapse_keep_the_original_carrier_and_prepared_owners() {
    for flags in [&[][..], &["--ci"][..], &["--collapse"][..]] {
        let w = Workspace::new();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut host = CliIo::new(&mut out, &mut err, Some(7));
        let p = prepared(&w, flags, &mut host);
        let carrier = std::ptr::from_ref(p.as_ref());
        let facts = std::ptr::from_ref(p.prepared.as_ref());
        let CollapseDispatch::Continue(p) = p
            .dispatch_collapse_gate(&mut host, &TsgoBinary::pinned("/unused"))
            .unwrap()
        else {
            panic!("inactive")
        };
        assert!(std::ptr::eq(carrier, p.as_ref()));
        assert!(std::ptr::eq(facts, p.prepared.as_ref()));
        assert_eq!(host.exit_state().stored_code(), Some(7));
        drop(host);
        assert!(out.is_empty() && err.is_empty());
    }
}
struct BorrowedWriter<'a>(&'a Rc<RefCell<Vec<u8>>>);
impl Write for BorrowedWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn policy_refusal_uses_borrowed_rc_writers_and_does_not_start_a_compiler() {
    let w = Workspace::new();
    let (out, err) = (
        Rc::new(RefCell::new(Vec::new())),
        Rc::new(RefCell::new(Vec::new())),
    );
    let (mut stdout, mut stderr) = (BorrowedWriter(&out), BorrowedWriter(&err));
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let p = prepared(&w, &["--collapse", "--ci"], &mut host);
    let CollapseDispatch::Complete(result) = p
        .dispatch_collapse_gate(&mut host, &TsgoBinary::pinned("/no-compiler-needed"))
        .unwrap()
    else {
        panic!("active")
    };
    assert_eq!(result.exit_code, 2);
    assert_eq!(host.exit_state().stored_code(), Some(2));
    drop(host);
    assert!(out.borrow().is_empty());
    assert_eq!(err.borrow().as_slice(),b"code-graph: no scope at or under \".\" is recorded in collapse-ceilings.json; record one with `--collapse --write-ceilings` before gating on it.\n");
}
#[test]
fn loader_refusal_keeps_the_original_typed_cause_and_owned_message() {
    let w = Workspace::new();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut out, &mut err, None);
    let p = prepared(&w, &["--collapse", "--write-ceilings"], &mut host);
    let error = p
        .dispatch_collapse_gate(&mut host, &TsgoBinary::pinned("/unused"))
        .unwrap_err();
    let FrontdoorError::Collapse(CollapseGateError::Load(original)) = &error else {
        panic!("loader category: {error}")
    };
    assert!(matches!(original, ProjectLoadError::MissingTsConfig(_)));
    let held = error.message();
    let gate = error
        .source()
        .unwrap()
        .downcast_ref::<CollapseGateError>()
        .unwrap();
    let original_reference = gate
        .source()
        .unwrap()
        .downcast_ref::<ProjectLoadError>()
        .unwrap();
    assert!(std::ptr::eq(original_reference, original));
    drop(w);
    assert_eq!(error.message(), held);
    assert_eq!(host.exit_state().stored_code(), None);
    drop(host);
    assert!(out.is_empty() && err.is_empty());
}
#[test]
fn renderer_preserves_exact_pass_text_json_and_caller_newline_ownership() {
    let verdict = evaluate_scope_ratchet(&[], &ScopeCountCeilings::default());
    let text = render_partial_twin_ratchet(&verdict, false, false).unwrap();
    assert_eq!(text.exit_code, 0);
    assert_eq!(
        text.stdout,
        "partial-twin ratchet: PASS — 0 scope(s) on their ceiling."
    );
    assert_eq!(
        render_partial_twin_ratchet(&verdict, true, false)
            .unwrap()
            .stdout,
        "{\"passed\":true,\"scopesChecked\":0,\"violations\":[]}"
    );
}
#[test]
fn renderer_keeps_exceeded_advice_before_slack_and_uses_canonical_scope_order() {
    let mut ceilings = ScopeCountCeilings::default();
    ceilings.scopes.insert("z".into(), 1.0);
    ceilings.scopes.insert("a".into(), 1.0);
    let verdict = evaluate_scope_ratchet(
        &[
            ScopeCount {
                scope: "z".into(),
                count: 0.0,
            },
            ScopeCount {
                scope: "a".into(),
                count: 2.0,
            },
        ],
        &ceilings,
    );
    let rendered = render_partial_twin_ratchet(&verdict, false, false).unwrap();
    let text = rendered.stdout.to_lossy();
    assert_eq!(rendered.exit_code, 1);
    assert!(text.starts_with("PARTIAL-TWIN RATCHET FAILED — 2 of 2 scope(s) off their ceiling.\n"));
    assert!(text.find("  a ").unwrap() < text.find("  z ").unwrap());
    assert!(text.find("  EXCEEDED:").unwrap() < text.find("  SLACK:").unwrap());
    assert!(text.ends_with("  `pnpm code-graph <scope> --collapse --write-ceilings`."));
    assert!(!text.ends_with('\n'));
}
