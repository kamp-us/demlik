use demlik_code_graph::{
    checker::context::{TypeContextInput, with_type_context},
    declarations::discover::discover_declarations,
    engine::tsgo::TsgoBinary,
    project::{Collation, EdgeScope, load_edge_project},
};
use std::{cell::Cell, path::Path, rc::Rc};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let root = Path::new(&args[1]);
    let loaded = load_edge_project(root, EdgeScope::Package, root, None)?;
    let binary = TsgoBinary::from_native_preview_manifest(Path::new(&args[2]))?;
    let observed = Rc::new(Cell::new(0usize));
    let borrowed_host = &observed;
    let declarations = {
        let collation = Collation::try_node22_en_us()?;
        let declarations = discover_declarations(&loaded.project.source_files, &collation)?;
        let file_count = with_type_context(
            &binary,
            TypeContextInput {
                project: &loaded.project,
                ts_config_path: &loaded.ts_config_path,
                functions: &[],
            },
            |context| {
                for file in &context.files {
                    assert!(
                        loaded
                            .project
                            .source_files
                            .iter()
                            .any(|unit| Rc::ptr_eq(unit, &file.unit))
                    );
                    borrowed_host
                        .set(borrowed_host.get() + file.source.root().descendants()?.len());
                }
                Ok(context.files.len())
            },
        )?;
        assert!(file_count > 1);
        declarations
    };
    assert!(observed.get() > 0);
    assert!(
        declarations
            .iter()
            .any(|declaration| declaration.name == "Shape")
    );
    assert!(
        declarations
            .iter()
            .any(|declaration| declaration.name == "TOKEN")
    );
    println!(
        "original Rc files and borrowed host used by official Go; declaration facts survive Collation drop"
    );
    Ok(())
}
