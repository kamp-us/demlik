use demlik_code_graph::{
    collapse::{
        candidates::find_collapse_candidates,
        render::{partial_twin_lines, render_collapse, short_callee_name},
        settings::CollapseSettings,
    },
    extract::assemble::{NodeFields, assemble_graph},
    project::{Collation, load_cheap_project},
    schema::Thresholds,
    text::JsString,
};
use std::{cell::Cell, error::Error, fs, path::PathBuf, rc::Rc};
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn main() -> Result<(), Box<dyn Error>> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()?;

    let scratch = Scratch(
        std::env::current_dir()?
            .join("target/parity")
            .join(format!("collapse-render-borrowed-{}", std::process::id())),
    );
    fs::create_dir_all(&scratch.0)?;
    let loaded = load_cheap_project(&scratch.0, None)?;
    let graph = assemble_graph(
        &loaded,
        Thresholds::default(),
        NodeFields::default(),
        &metadata_collation,
    )?;
    let root: JsString = scratch.0.to_string_lossy().as_ref().into();
    let settings = CollapseSettings::default();
    let label = String::from("borrowed local renderer context");
    let visits = Rc::new(Cell::new(0));
    let collation = Collation::try_node22_en_us()?;
    let text = {
        let render = || {
            assert_eq!(label, "borrowed local renderer context");
            visits.set(visits.get() + 1);
            render_collapse(&graph, &root, &settings, false, false, &collation)
        };
        render()?
    };
    assert_eq!(
        text,
        JsString::from("collapse: needs the call graph; add --edges (--collapse implies it).")
    );
    let report = find_collapse_candidates(&graph.functions, &[], &settings, &collation)?;
    drop(collation);
    assert_eq!(
        partial_twin_lines(&report),
        vec![JsString::from(
            "partial twins: 0 — no shared decision block diverges on the same named constants"
        )]
    );
    let raw = JsString::from_units(vec![
        b'e' as u16,
        b'x' as u16,
        b't' as u16,
        b'e' as u16,
        b'r' as u16,
        b'n' as u16,
        b'a' as u16,
        b'l' as u16,
        b':' as u16,
        b'm' as u16,
        b':' as u16,
        0xd800,
    ]);
    assert_eq!(short_callee_name(&raw).units(), &[0xd800]);
    drop(report);
    drop(graph);
    drop(loaded);
    assert_eq!(visits.get(), 1);
    assert_eq!(text.units().last(), Some(&(b'.' as u16)));
    println!(
        "borrowed Rc context, lossless callee, fresh renderer result and no trailing LF: passed"
    );
    Ok(())
}
