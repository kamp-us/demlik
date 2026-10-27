use demlik_code_graph::{
    cli::{
        frontdoor::{GatePreflightDispatch, Preparation, prepare_cli},
        io::CliIo,
    },
    engine::tsgo::TsgoBinary,
    text::JsString,
};
use std::{
    cell::Cell,
    io::{self, Write},
    path::PathBuf,
    rc::Rc,
};
struct Borrowed<'a> {
    bytes: &'a mut Vec<u8>,
    writes: Rc<Cell<usize>>,
}
impl Write for Borrowed<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.writes.set(self.writes.get() + 1);
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn main() {
    let fixture = PathBuf::from(std::env::args_os().nth(1).expect("fixture root"));
    assert!(!fixture.join("tsconfig.json").exists());
    let compiler = TsgoBinary::pinned(fixture.join("compiler-does-not-exist"));
    assert!(!compiler.path().exists());
    let marker = Rc::new(Cell::new(0));
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut stdout = Borrowed {
        bytes: &mut out,
        writes: Rc::clone(&marker),
    };
    let mut stderr = Borrowed {
        bytes: &mut err,
        writes: Rc::clone(&marker),
    };
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let argv: Vec<JsString> = vec![
        fixture.to_string_lossy().as_ref().into(),
        "--accept-smells".into(),
        "--reason".into(),
        "reviewed".into(),
        "--thresholds".into(),
        fixture
            .join("thresholds.json")
            .to_string_lossy()
            .as_ref()
            .into(),
    ];
    let Preparation::Prepared(prepared) = prepare_cli(&argv, None, &mut host).unwrap() else {
        panic!("preparation refused")
    };
    let GatePreflightDispatch::Continue(prepared) = prepared.prepare_gates(&mut host).unwrap()
    else {
        panic!("gate refused")
    };
    let result = prepared
        .dispatch_smell_ledger_blocking(&mut host, &compiler)
        .unwrap();
    assert_eq!(format!("{result:?}"), "Complete");
    assert_eq!(host.normal_exit_code(), 0);
    assert!(host.pending_stdio_failures().is_empty());
    drop(host);
    assert!(marker.get() > 0);
    assert!(!out.is_empty());
    assert!(err.is_empty());
    let ledger = std::fs::read_to_string(fixture.join("smell-ledger.json")).unwrap();
    assert!(ledger.contains("reviewed"));
    println!(
        "cheap prepared smell dispatch preserved borrowed/Rc host without tsconfig or compiler"
    );
}
