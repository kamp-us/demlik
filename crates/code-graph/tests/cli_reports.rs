use demlik_code_graph::{
    api::map::ApiError,
    cli::{
        frontdoor::{
            FrontdoorError, GatePreflightDispatch, Preparation, PreparedGatesCli, ReportDispatch,
            prepare_cli,
        },
        io::{CliIo, StdioStream},
    },
    engine::tsgo::TsgoBinary,
    text::JsString,
};
use std::{
    error::Error,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-report-native-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    fs::write(path.join("pnpm-workspace.yaml"), "packages: []\n").unwrap();
                    fs::write(path.join("one.ts"), "export function one(){return 1;}\n").unwrap();
                    return Self(fs::canonicalize(path).unwrap());
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("{e}"),
            }
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn prepared(root: &Path, flags: &[&str], host: &mut CliIo<'_>) -> Box<PreparedGatesCli> {
    let args = std::iter::once(JsString::from(root.to_string_lossy().as_ref()))
        .chain(flags.iter().copied().map(JsString::from))
        .collect::<Vec<_>>();
    let Preparation::Prepared(p) = prepare_cli(&args, None, host).unwrap() else {
        panic!("prepare")
    };
    let GatePreflightDispatch::Continue(p) = p.prepare_gates(host).unwrap() else {
        panic!("gates")
    };
    p
}
#[test]
fn unsupported_higher_output_keeps_both_original_boxes_without_graph_or_io() {
    let fixture = Fixture::new();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut out, &mut err, None);
    let p = prepared(&fixture.0, &["--hotspots"], &mut host);
    let original = std::ptr::from_ref(p.as_ref());
    let input = std::ptr::from_ref(p.prepared.as_ref());
    let ReportDispatch::Continue(p) = p
        .dispatch_reports_blocking(&mut host, &TsgoBinary::pinned("/missing/tsgo"))
        .unwrap()
    else {
        panic!("continued")
    };
    assert!(std::ptr::eq(original, p.as_ref()));
    assert!(std::ptr::eq(input, p.prepared.as_ref()));
    assert_eq!(host.exit_state().stored_code(), None);
    assert!(out.is_empty() && err.is_empty());
}
#[test]
fn report_output_failure_retains_the_actual_concrete_cause() {
    let fixture = Fixture::new();
    let destination = fixture.0.join("directory");
    fs::create_dir(&destination).unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut out, &mut err, None);
    let p = prepared(
        &fixture.0,
        &["--out", destination.to_str().unwrap()],
        &mut host,
    );
    let failure = p
        .dispatch_reports_blocking(&mut host, &TsgoBinary::pinned("/missing/tsgo"))
        .unwrap_err();
    let FrontdoorError::ReportEmit(original) = &failure else {
        panic!("{failure:?}")
    };
    assert!(std::ptr::eq(
        original,
        failure
            .source()
            .unwrap()
            .downcast_ref::<ApiError>()
            .unwrap()
    ));
    let ApiError::Io { path, source } = original else {
        panic!("{original:?}")
    };
    assert_eq!(path, destination.to_str().unwrap());
    assert!(std::ptr::eq(
        source,
        original
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .unwrap()
    ));
    assert!(out.is_empty() && err.is_empty());
}
struct BadStderr;
impl Write for BadStderr {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::from_raw_os_error(9))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn real_file_is_written_before_banner_stdio_failure_becomes_pending() {
    let fixture = Fixture::new();
    let destination = fixture.0.join("summary.json");
    let mut out = Vec::new();
    let mut err = BadStderr;
    let mut host = CliIo::new(&mut out, &mut err, Some(7));
    let p = prepared(
        &fixture.0,
        &["--out", destination.to_str().unwrap()],
        &mut host,
    );
    assert!(matches!(
        p.dispatch_reports_blocking(&mut host, &TsgoBinary::pinned("/missing/tsgo"))
            .unwrap(),
        ReportDispatch::Complete
    ));
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(&destination).unwrap()).unwrap();
    assert_eq!(value["functionCount"], 1);
    assert_eq!(host.exit_state().stored_code(), Some(7));
    assert_eq!(host.normal_exit_code(), 1);
    assert_eq!(host.pending_stdio_failures().len(), 1);
    assert_eq!(host.pending_stdio_failures()[0].stream, StdioStream::Stderr);
    assert_eq!(
        host.pending_stdio_failures()[0].source.raw_os_error(),
        Some(9)
    );
}
