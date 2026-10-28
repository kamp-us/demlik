use demlik_code_graph::{
    engine::tsgo::TsgoBinary,
    extract::assemble::{NodeFields, assemble_graph, assemble_graph_with_edges},
    project::{Collation, EdgeScope, load_cheap_project, load_edge_project},
    render::{html::build_html_model, plan::render_plan},
    schema::Thresholds,
    smells::{
        evaluate::compare_flat_smells,
        plan::{PlanAxis, rank_plan},
    },
};
use std::{cell::Cell, path::Path, rc::Rc};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let root = Path::new(&args[2]);
    let count = Rc::new(Cell::new(0));
    let borrowed = &count;
    let collation = Collation::try_node22_en_us()?;
    let thresholds = Thresholds {
        high_complexity: 1,
        ..Thresholds::default()
    };
    let graph = if args[1] == "cheap" {
        let loaded = load_cheap_project(root, None, &collation)?;
        let unit = Rc::clone(&loaded.source_files[0]);
        let graph = assemble_graph(&loaded, thresholds, NodeFields::default(), &collation)?;
        assert!(Rc::ptr_eq(&unit, &loaded.source_files[0]));
        graph
    } else {
        let loaded = load_edge_project(root, EdgeScope::Deep, root, None, &collation)?;
        let unit = Rc::clone(&loaded.project.source_files[0]);
        let compiler = TsgoBinary::from_native_preview_manifest(Path::new(&args[3]))?;
        let graph = assemble_graph_with_edges(
            &loaded,
            thresholds,
            &compiler,
            NodeFields::default(),
            &collation,
        )?;
        assert!(Rc::ptr_eq(&unit, &loaded.project.source_files[0]));
        graph
    };
    assert!(graph.modules.len() > 2 && graph.functions.len() > 2);
    assert!(!graph.smells.is_empty());
    let original = graph.functions.as_ptr();
    let before = serde_json::to_vec(&graph.functions)?;
    let rows = rank_plan(&graph.functions, PlanAxis::Rot, &collation)?;
    let text = render_plan(&graph, PlanAxis::Rot, false, false, &collation)?;
    let model = build_html_model(&graph, &collation)?;
    assert!(std::ptr::eq(model.summary, &graph.summary));
    for pair in graph.smells.windows(2) {
        assert!(!compare_flat_smells(&pair[0], &pair[1], &collation)?.is_gt());
    }
    assert_eq!(original, graph.functions.as_ptr());
    assert_eq!(before, serde_json::to_vec(&graph.functions)?);
    drop(collation);
    borrowed.set(rows.len());
    assert_eq!(count.get(), graph.functions.len());
    assert_eq!(model.plan.len(), rows.len());
    assert!(!text.is_empty());
    assert!(std::ptr::eq(model.summary, &graph.summary));
    println!(
        "original Rc project/borrowed graph and Summary; inferred plan/render results survive Collation drop"
    );
    Ok(())
}
