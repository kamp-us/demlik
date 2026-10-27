use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, CollapseDispatch, FrontdoorError, GatePreflightDispatch, HexagonDispatch,
            PlainCollapseDispatch, Preparation, PreparedGatesCli, prepare_cli,
        },
        io::CliIo,
    },
    engine::tsgo::{TsgoBinary, TsgoError},
    extract::assemble::AssemblyError,
    text::JsString,
};
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "demlik-plain-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn prepared(path: &Path, flags: &[&str], host: &mut CliIo<'_>) -> Box<PreparedGatesCli> {
    let argv = std::iter::once(JsString::from(path.to_string_lossy().as_ref()))
        .chain(flags.iter().copied().map(JsString::from))
        .collect::<Vec<_>>();
    let Preparation::Prepared(p) = prepare_cli(&argv, None, host).unwrap() else {
        panic!("prepare")
    };
    let ApiDispatch::Continue(p) = p
        .dispatch_api_blocking(&TsgoBinary::pinned("/unused"), host)
        .unwrap()
    else {
        panic!("api")
    };
    let HexagonDispatch::Continue(p) = p.dispatch_hexagon(host).unwrap() else {
        panic!("hexagon")
    };
    let GatePreflightDispatch::Continue(p) = p.prepare_gates(host).unwrap() else {
        panic!("preflight")
    };
    let CollapseDispatch::Continue(p) = p
        .dispatch_collapse_gate(host, &TsgoBinary::pinned("/unused"))
        .unwrap()
    else {
        panic!("early collapse")
    };
    p
}
#[test]
fn html_inactive_and_prepared_ledger_preserve_both_original_boxes_without_loading() {
    for flags in [
        vec![],
        vec!["--collapse", "--html"],
        vec![
            "--collapse",
            "--unreachable",
            "--accept-dead",
            "--reason",
            "reviewed",
        ],
    ] {
        let f = Fixture::new();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut host = CliIo::new(&mut out, &mut err, Some(7));
        let p = prepared(&f.0, &flags, &mut host);
        let carrier = std::ptr::from_ref(p.as_ref());
        let facts = std::ptr::from_ref(p.prepared.as_ref());
        let PlainCollapseDispatch::Continue(p) = p
            .dispatch_plain_collapse_blocking(&mut host, &TsgoBinary::pinned("/must-not-launch"))
            .unwrap()
        else {
            panic!("unchanged continuation")
        };
        assert!(std::ptr::eq(carrier, p.as_ref()));
        assert!(std::ptr::eq(facts, p.prepared.as_ref()));
        assert_eq!(host.exit_state().stored_code(), Some(7));
        drop(host);
        assert!(out.is_empty() && err.is_empty());
    }
}
#[test]
fn missing_compiler_stays_original_assembly_cause_instead_of_clean_loader_refusal() {
    let f = Fixture::new();
    fs::write(
        f.0.join("tsconfig.json"),
        r#"{"compilerOptions":{"types":[]},"include":["*.ts"]}"#,
    )
    .unwrap();
    fs::write(f.0.join("entry.ts"), "export function entry(){return 1;}\n").unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut out, &mut err, Some(7));
    let p = prepared(&f.0, &["--collapse"], &mut host);
    let error = p
        .dispatch_plain_collapse_blocking(&mut host, &TsgoBinary::pinned(f.0.join("missing-tsgo")))
        .unwrap_err();
    let FrontdoorError::Assembly(AssemblyError::Compiler(original)) = &error else {
        panic!("original compiler category")
    };
    let owned = error
        .source()
        .unwrap()
        .downcast_ref::<AssemblyError>()
        .unwrap();
    let retained = owned.source().unwrap().downcast_ref::<TsgoError>().unwrap();
    assert!(std::ptr::eq(original, retained));
    assert_eq!(host.exit_state().stored_code(), Some(7));
    drop(host);
    assert!(out.is_empty() && err.is_empty());
    drop(f);
    assert!(error.message().to_lossy().contains("compiler"));
}
