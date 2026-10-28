use demlik_code_graph::{
    cli::{
        frontdoor::{
            ApiDispatch, BoundaryDispatch, EnvKeyDispatch, GatePreflightDispatch, HexagonDispatch,
            LayerDispatch, Preparation, prepare_cli,
        },
        io::CliIo,
    },
    engine::tsgo::TsgoBinary,
    text::{JsString, JsValue},
};
use std::{
    cell::RefCell,
    error::Error,
    io::{self, Write},
    rc::Rc,
};

struct LocalWriter(Rc<RefCell<Vec<u8>>>);
impl Write for LocalWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let root = std::env::args()
        .nth(1)
        .ok_or("three-worker fixture root required")?;
    let stdout = Rc::new(RefCell::new(Vec::new()));
    let stderr = Rc::new(RefCell::new(Vec::new()));
    let mut out = LocalWriter(Rc::clone(&stdout));
    let mut err = LocalWriter(Rc::clone(&stderr));
    let report = {
        let mut io = CliIo::new(&mut out, &mut err, Some(7));
        let args: Vec<JsString> = vec![root.into(), "--env-keys".into(), "--json".into()];
        let Preparation::Prepared(prepared) = prepare_cli(&args, None, &mut io)? else {
            panic!("preparation stopped")
        };
        let ApiDispatch::Continue(prepared) =
            prepared.dispatch_api_blocking(&TsgoBinary::pinned("/missing/no-go"), &mut io)?
        else {
            panic!("API active")
        };
        let HexagonDispatch::Continue(prepared) = prepared.dispatch_hexagon(&mut io)? else {
            panic!("hexagon active")
        };
        let GatePreflightDispatch::Continue(prepared) = prepared.prepare_gates(&mut io)? else {
            panic!("gate preflight stopped")
        };
        let LayerDispatch::Continue(prepared) = prepared.dispatch_layers(&mut io)? else {
            panic!("layers active")
        };
        let BoundaryDispatch::Continue(prepared) = prepared.dispatch_boundaries(&mut io)? else {
            panic!("boundaries active")
        };
        let EnvKeyDispatch::Complete(report) = prepared.dispatch_env_keys(&mut io)? else {
            panic!("env keys inactive")
        };
        assert_eq!(io.exit_state().stored_code(), Some(7));
        report
    };
    // Completion drops the prepared handle; returned facts and borrowed local IO remain usable.
    assert_eq!(report.read_count, 4.0);
    assert!(report.declared_count > 2.0);
    assert!(stderr.borrow().is_empty());
    let encoded = JsValue::parse(std::str::from_utf8(&stdout.borrow())?)?;
    assert_eq!(
        encoded.get("readCount").and_then(JsValue::as_number),
        Some(4.0)
    );
    println!(
        "cheap/no tsconfig/no compiler; owned report survives prepared Collation; borrowed Rc writers retain output and exit7"
    );
    Ok(())
}
