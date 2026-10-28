use demlik_code_graph::{
    extract::assemble::{NodeFields, assemble_graph},
    project::{Collation, load_cheap_project},
    render::html::{build_html_model, render_html},
    schema::Thresholds,
};
use std::path::Path;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()?;

    let root = std::env::args().nth(1).expect("project path");
    let loaded = load_cheap_project(Path::new(&root), None, &metadata_collation)?;
    let graph = assemble_graph(
        &loaded,
        Thresholds::default(),
        NodeFields { headers: false },
        &metadata_collation,
    )?;
    let model = {
        let collation = Collation::try_node22_en_us()?;
        build_html_model(&graph, &collation)?
    };
    assert!(std::ptr::eq(model.summary, &graph.summary));
    assert_eq!(model.plan.len(), 1);
    let html = {
        let collation = Collation::try_node22_en_us()?;
        render_html(&graph, &collation)?
    };
    drop(model);
    drop(graph);
    assert!(html.to_lossy().starts_with("<!doctype html>"));
    println!(
        "borrowed original Summary survives Collation drop; rendered page survives Graph drop"
    );
    Ok(())
}
