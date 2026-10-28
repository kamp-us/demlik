use demlik_code_graph::{
    checker::context::{TypeContextInput, with_type_context},
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::{NamedSymbol, analysis_inputs},
        edges::resolve_edges,
        functions::discover_functions,
        references::resolve_references,
    },
    project::{Collation, EdgeScope, load_cheap_project, load_edge_project},
    syntax::imports::resolve_imports,
};
use std::{cell::Cell, path::Path, rc::Rc};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let root = Path::new(&args[2]);
    let calls = Rc::new(Cell::new(0usize));
    let borrowed = &calls;
    if args[1] == "cheap" {
        let loaded = load_cheap_project(root, None)?;
        let found = {
            let collation = Collation::try_node22_en_us()?;
            discover_functions(&loaded.source_files, &collation)?
        };
        assert_eq!(found.functions.len(), 2);
        assert!(
            found
                .functions
                .iter()
                .all(|f| loaded.source_files.iter().any(|u| Rc::ptr_eq(u, &f.unit)))
        );
        println!("syntax-only original Rc facts survive Collation; no compiler/config accessed");
        return Ok(());
    }
    let loaded = load_edge_project(root, EdgeScope::Package, root, None)?;
    let binary = TsgoBinary::from_native_preview_manifest(Path::new(&args[3]))?;
    let (edges, references) = {
        let collation = Collation::try_node22_en_us()?;
        let found = discover_functions(&loaded.project.source_files, &collation)?;
        assert!(found.functions.len() > 4);
        let ids: Vec<_> = found.functions.iter().map(|f| f.id.clone()).collect();
        let inputs = analysis_inputs(found.functions.iter().map(NamedSymbol::from));
        let imports = resolve_imports(
            root,
            &loaded.project.source_files,
            &loaded.ts_config_path,
            &collation,
        )?;
        let (edges, references) = with_type_context(
            &binary,
            TypeContextInput {
                project: &loaded.project,
                ts_config_path: &loaded.ts_config_path,
                functions: &found.functions,
            },
            |context| {
                for file in &context.files {
                    assert!(
                        loaded
                            .project
                            .source_files
                            .iter()
                            .any(|u| Rc::ptr_eq(u, &file.unit))
                    );
                }
                let (node, id) = context
                    .node_to_id
                    .iter()
                    .next()
                    .map(|(n, id)| (n.clone(), id.clone()))
                    .unwrap();
                assert_eq!(context.node_to_id.get(&node.clone()), Some(&id));
                if let Some(name) = node.node("name")? {
                    let first = context.symbol_of(&name)?;
                    assert!(first == context.symbol_of(&name)?);
                }
                borrowed.set(borrowed.get() + context.files.len());
                Ok((
                    resolve_edges(context, imports, &ids, &collation),
                    resolve_references(context, &inputs.names, &inputs.exports_by_file, &collation),
                ))
            },
        )?;
        (edges?, references?)
    };
    assert!(calls.get() > 2);
    assert!(
        edges
            .calls_by_id
            .values()
            .flatten()
            .any(|c| c.const_args.len() >= 2)
    );
    assert!(!references.module_scope_roots.is_empty());
    assert!(
        edges
            .calls_by_id
            .iter()
            .any(|(id, sites)| id.ends_with(":invoke") && sites.len() == 2)
    );
    println!(
        "official Go, original Rc/NativeNode/symbol caches, borrowed Rc host and returned facts after Collation passed"
    );
    Ok(())
}
