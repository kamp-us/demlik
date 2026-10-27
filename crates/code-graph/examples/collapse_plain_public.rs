use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, BoundaryDispatch, CollapseDispatch, CommentDispatch, EnvKeyDispatch,
            FrontdoorError, GatePreflightDispatch, HexagonDispatch, LayerDispatch,
            PlainCollapseDispatch, Preparation, PreparedGatesCli, prepare_cli,
        },
        io::CliIo,
    },
    engine::tsgo::TsgoBinary,
    project::ProjectLoadError,
    text::JsString,
};
use std::{
    cell::RefCell,
    error::Error,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    rc::Rc,
};
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
struct LocalWriter<'a> {
    bytes: &'a Rc<RefCell<Vec<u8>>>,
    label: &'a str,
}
impl Write for LocalWriter<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        assert_eq!(self.label, "borrowed local IO");
        self.bytes.borrow_mut().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn prepared(
    root: &Path,
    io: &mut CliIo<'_>,
    binary: &TsgoBinary,
) -> Result<Box<PreparedGatesCli>, FrontdoorError> {
    let args = [
        JsString::from(root.to_string_lossy().as_ref()),
        "--collapse".into(),
        "--by".into(),
        "loc".into(),
    ];
    let Preparation::Prepared(p) = prepare_cli(&args, None, io)? else {
        panic!("prepare")
    };
    let ApiDispatch::Continue(p) = p.dispatch_api_blocking(binary, io)? else {
        panic!("api")
    };
    let HexagonDispatch::Continue(p) = p.dispatch_hexagon(io)? else {
        panic!("hexagon")
    };
    let GatePreflightDispatch::Continue(p) = p.prepare_gates(io)? else {
        panic!("preflight")
    };
    let LayerDispatch::Continue(p) = p.dispatch_layers(io)? else {
        panic!("layers")
    };
    let BoundaryDispatch::Continue(p) = p.dispatch_boundaries(io)? else {
        panic!("boundaries")
    };
    let EnvKeyDispatch::Continue(p) = p.dispatch_env_keys(io)? else {
        panic!("env keys")
    };
    let CommentDispatch::Continue(p) = p.dispatch_comments(io)? else {
        panic!("comments")
    };
    let CollapseDispatch::Continue(p) = p.dispatch_collapse_gate(io, binary)? else {
        panic!("early collapse")
    };
    Ok(p)
}
fn main() -> Result<(), Box<dyn Error>> {
    let scratch = Scratch(
        std::env::current_dir()?
            .join("target/parity")
            .join(format!("collapse-cli-borrowed-{}", std::process::id())),
    );
    fs::create_dir_all(&scratch.0)?;
    fs::write(scratch.0.join("pnpm-workspace.yaml"), "packages: []\n")?;
    let label = String::from("borrowed local IO");
    let out = Rc::new(RefCell::new(Vec::new()));
    let err = Rc::new(RefCell::new(Vec::new()));
    let (mut stdout, mut stderr) = (
        LocalWriter {
            bytes: &out,
            label: &label,
        },
        LocalWriter {
            bytes: &err,
            label: &label,
        },
    );
    let mut io = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let binary = TsgoBinary::pinned("/must-not-start-compiler");
    let p = prepared(&scratch.0, &mut io, &binary)?;
    let PlainCollapseDispatch::Refused { cause } =
        p.dispatch_plain_collapse_blocking(&mut io, &binary)?
    else {
        panic!("load refuses")
    };
    assert!(matches!(cause, ProjectLoadError::MissingTsConfig(_)));
    assert_eq!(io.exit_state().stored_code(), Some(2));
    drop(io);
    assert!(out.borrow().is_empty());
    let text = String::from_utf8(err.borrow().clone())?;
    assert_eq!(
        text,
        format!(
            "warning: --by loc has no effect without --plan.\ncode-graph: no tsconfig found for edge pass at {}; edges unavailable\n",
            scratch.0.display()
        )
    );
    drop(scratch);
    assert!(cause.to_string().contains("tsconfig"));
    println!(
        "actual prepared route, borrowed Rc IO, warning-before-refusal and retained load cause: passed"
    );
    Ok(())
}
