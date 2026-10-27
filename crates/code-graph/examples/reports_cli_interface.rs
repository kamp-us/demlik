use demlik_code_graph::{
    cli::{
        frontdoor::{GatePreflightDispatch, Preparation, prepare_cli},
        io::CliIo,
    },
    engine::tsgo::TsgoBinary,
    text::JsString,
};
use std::{
    cell::RefCell,
    io::{self, Write},
    rc::Rc,
};
struct Borrowed<'a>(&'a Rc<RefCell<Vec<u8>>>);
impl Write for Borrowed<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn main() {
    let root = std::env::args().nth(1).expect("project path");
    let bytes = Rc::new(RefCell::new(Vec::new()));
    let mut output = Borrowed(&bytes);
    let mut errors = Vec::new();
    {
        let mut host = CliIo::new(&mut output, &mut errors, None);
        let p = match prepare_cli(&[JsString::from(root)], None, &mut host).unwrap() {
            Preparation::Prepared(p) => p,
            other => panic!("{other:?}"),
        };
        let p = match p.prepare_gates(&mut host).unwrap() {
            GatePreflightDispatch::Continue(p) => p,
            other => panic!("{other:?}"),
        };
        let _ = p
            .dispatch_reports_blocking(&mut host, &TsgoBinary::pinned("/nonexistent/explicit-tsgo"))
            .unwrap();
        assert_eq!(host.normal_exit_code(), 0);
    }
    let out = String::from_utf8(bytes.borrow().clone()).unwrap();
    assert!(out.contains("\"functionCount\":1"), "{out}");
    assert!(errors.is_empty());
    println!("borrowed Rc host: cheap summary without tsconfig or compiler");
}
