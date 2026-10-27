use demlik_code_graph::{
    cli::{
        frontdoor::{GatePreflightDispatch, Preparation, ReportDispatch, prepare_cli},
        io::CliIo,
    },
    declarations::find::{FindMatch, find_by_name},
    engine::tsgo::TsgoBinary,
    extract::assemble::{NodeFields, assemble_graph},
    project::{Collation, load_cheap_project},
    render::{
        blast::render_blast,
        tree::{TreeStyle, render_tree},
    },
    schema::Thresholds,
    text::JsString,
};
use std::{
    cell::RefCell,
    io::{self, Write},
    path::Path,
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
    let root = std::env::args().nth(1).expect("owned cheap fixture");
    let loaded = load_cheap_project(Path::new(&root), None).unwrap();
    let graph = assemble_graph(&loaded, Thresholds::default(), NodeFields::default()).unwrap();
    let collation = Collation::try_node22_en_us().unwrap();
    let tree = render_tree(&graph, TreeStyle::Plain, &collation).unwrap();
    assert!(tree.to_lossy().contains("Shared"));
    let matches = find_by_name(&graph, &JsString::from("Shared"), &collation).unwrap();
    assert!(matches.iter().any(|m| {
        match m {
            FindMatch::Function { node, .. } => graph
                .functions
                .iter()
                .any(|original| std::ptr::eq(*node, original)),
            FindMatch::Declaration(node) => graph
                .declarations
                .iter()
                .any(|original| std::ptr::eq(*node, original)),
        }
    }));
    let blast = render_blast(&graph, &JsString::from("Shared"), false, false, &collation).unwrap();
    assert_eq!(blast.exit_code, 2);
    let shared = Rc::new(RefCell::new(Vec::new()));
    let mut out = Borrowed(&shared);
    let mut errors = Vec::new();
    {
        let mut host = CliIo::new(&mut out, &mut errors, Some(7));
        let Preparation::Prepared(p) =
            prepare_cli(&[root.into(), "--tree".into()], None, &mut host).unwrap()
        else {
            panic!("prepared")
        };
        let GatePreflightDispatch::Continue(p) = p.prepare_gates(&mut host).unwrap() else {
            panic!("gates")
        };
        let result = p
            .dispatch_reports_with_style_blocking(
                &mut host,
                &TsgoBinary::pinned("/nonexistent/compiler"),
                TreeStyle::Plain,
            )
            .unwrap();
        assert!(matches!(result, ReportDispatch::Complete));
        assert_eq!(host.normal_exit_code(), 7);
    }
    assert!(
        String::from_utf8(shared.borrow().clone())
            .unwrap()
            .contains("Shared")
    );
    assert!(errors.is_empty());
    println!(
        "borrowed original graph nodes and Rc writer; cheap tree without config or compiler; exit preserved"
    );
}
