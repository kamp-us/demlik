use demlik_code_graph::{
    checker::context::{TypeContextInput, with_type_context},
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::{NamedSymbol, analysis_inputs},
        assemble::{NodeFields, assemble_graph},
        edges::resolve_edges,
        functions::discover_functions,
        references::{ReferenceResult, resolve_references},
    },
    project::{Collation, EdgeScope, load_cheap_project, load_edge_project},
    query::{
        reach::{full_adjacency, invoked_adjacency, reachable_from},
        unguarded::find_unguarded,
        unreachable::find_unreachable,
    },
    schema::{Edges, EntryReach, NodeKind, Thresholds, UnreachableCategory},
    syntax::imports::resolve_imports,
};
use std::{cell::Cell, path::Path, rc::Rc};
fn kinds(graph: &mut demlik_code_graph::schema::Graph) {
    for node in &mut graph.functions {
        node.node_kind = match node.name.as_str() {
            "main" => Some(NodeKind::Entry {
                evidence: vec![],
                guards: vec![],
                reach: EntryReach::Public,
            }),
            "write" => Some(NodeKind::Effect { evidence: vec![] }),
            _ => None,
        };
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let root = Path::new(&args[2]);
    let calls = Rc::new(Cell::new(0usize));
    let borrowed = &calls;
    if args[1] == "cheap" {
        let loaded = load_cheap_project(root, None)?;
        let (graph, refs, invoked, full, found, bad, reached) = {
            let collation = Collation::try_node22_en_us()?;
            let mut graph = assemble_graph(
                &loaded,
                Thresholds::default(),
                NodeFields::default(),
                &collation,
            )?;
            kinds(&mut graph);
            let refs = ReferenceResult {
                references_by_id: Default::default(),
                module_scope_roots: vec![],
                test_module_scope_roots: vec![],
                identifier_files: Default::default(),
            };
            let pointer = graph.functions.as_ptr();
            let invoked = invoked_adjacency(&graph.functions, &collation)?;
            let full = full_adjacency(&graph.functions, &refs.references_by_id, &collation)?;
            let found = find_unreachable(
                &graph.functions,
                &graph.modules,
                &refs,
                &[],
                &[],
                &[],
                &collation,
            )?;
            let bad = find_unguarded(&graph.functions, &collation)?;
            let reached = reachable_from(&full, &["unknown".into()]);
            assert_eq!(pointer, graph.functions.as_ptr());
            (graph, refs, invoked, full, found, bad, reached)
        };
        assert!(graph.functions.len() > 4);
        assert_eq!(invoked.len(), graph.functions.len());
        assert_eq!(full.len(), invoked.len());
        assert!(!found.unreachable.is_empty());
        assert!(bad.is_empty());
        assert!(reached.contains("unknown"));
        assert!(refs.identifier_files.is_empty());
        borrowed.set(full.len());
        assert!(calls.get() > 4);
        println!(
            "syntax-only/no config/no compiler; original borrowed graph/refs and returned query facts survive Collation drop"
        );
        return Ok(());
    }
    let loaded = load_edge_project(root, EdgeScope::Package, root, None)?;
    let binary = TsgoBinary::from_native_preview_manifest(Path::new(&args[3]))?;
    let (graph, refs, invoked, full, found, bad, reached) = {
        let collation = Collation::try_node22_en_us()?;
        let found = discover_functions(&loaded.project.source_files, &collation)?;
        let ids = found
            .functions
            .iter()
            .map(|f| f.id.clone())
            .collect::<Vec<_>>();
        let inputs = analysis_inputs(found.functions.iter().map(NamedSymbol::from), &collation)?;
        let imports = resolve_imports(
            root,
            &loaded.project.source_files,
            &loaded.ts_config_path,
            &collation,
        )?;
        let (mut edges, refs) = with_type_context(
            &binary,
            TypeContextInput {
                project: &loaded.project,
                ts_config_path: &loaded.ts_config_path,
                functions: &found.functions,
            },
            |ctx| {
                for file in &ctx.files {
                    assert!(
                        loaded
                            .project
                            .source_files
                            .iter()
                            .any(|u| Rc::ptr_eq(u, &file.unit))
                    );
                }
                let (node, id) = ctx
                    .node_to_id
                    .iter()
                    .next()
                    .map(|(n, id)| (n.clone(), id.clone()))
                    .unwrap();
                assert_eq!(ctx.node_to_id.get(&node.clone()), Some(&id));
                if let Some(name) = node.node("name")? {
                    assert!(ctx.symbol_of(&name)? == ctx.symbol_of(&name)?);
                }
                borrowed.set(borrowed.get() + ctx.files.len());
                Ok(
                    (|| -> Result<_, demlik_code_graph::extract::ResolveError> {
                        let edges = resolve_edges(ctx, imports, &ids, &collation)?;
                        let refs = resolve_references(
                            ctx,
                            &inputs.names,
                            &inputs.exports_by_file,
                            &collation,
                        )?;
                        Ok((edges, refs))
                    })(),
                )
            },
        )??;
        let mut graph = assemble_graph(
            &loaded.project,
            Thresholds::default(),
            NodeFields::default(),
            &collation,
        )?;
        for node in &mut graph.functions {
            node.edges = Some(Edges {
                calls: edges.calls_by_id.shift_remove(&node.id).unwrap_or_default(),
                called_by: edges
                    .called_by_id
                    .shift_remove(&node.id)
                    .unwrap_or_default(),
                call_chain_depth: edges
                    .chain_depth_by_id
                    .shift_remove(&node.id)
                    .unwrap_or_default(),
            });
        }
        for node in &mut graph.modules {
            node.imports = edges
                .imports_by_file
                .shift_remove(&node.file)
                .unwrap_or_default();
            node.imported_by = edges
                .imported_by_file
                .shift_remove(&node.file)
                .unwrap_or_default();
            node.import_edges = edges
                .import_edges_by_file
                .shift_remove(&node.file)
                .unwrap_or_default();
        }
        kinds(&mut graph);
        let pointer = graph.functions.as_ptr();
        let invoked = invoked_adjacency(&graph.functions, &collation)?;
        let full = full_adjacency(&graph.functions, &refs.references_by_id, &collation)?;
        let found = find_unreachable(
            &graph.functions,
            &graph.modules,
            &refs,
            &[],
            &[],
            &[],
            &collation,
        )?;
        let bad = find_unguarded(&graph.functions, &collation)?;
        let reached = reachable_from(&full, &["packages/api/main.ts:main".into()]);
        assert_eq!(pointer, graph.functions.as_ptr());
        (graph, refs, invoked, full, found, bad, reached)
    };
    assert!(calls.get() > 2);
    assert!(graph.modules.len() > 2);
    assert_eq!(invoked.len(), graph.functions.len());
    assert_eq!(full.len(), graph.functions.len());
    assert!(
        refs.references_by_id
            .values()
            .flatten()
            .any(|id| id.ends_with(":callback"))
    );
    assert!(reached.contains("packages/core/worker.ts:callback"));
    assert!(
        found
            .unreachable
            .iter()
            .any(|r| r.id.ends_with(":dead") && r.category == UnreachableCategory::Dead)
    );
    assert!(
        found.unreachable.iter().any(|r| r.id.ends_with(":onlyTest")
            && r.category == UnreachableCategory::OnlyCalledFromTests)
    );
    assert_eq!(bad.len(), 1);
    assert_eq!(bad[0].path.len(), 3);
    assert_eq!(bad[0].entry_id, "packages/api/main.ts:main");
    println!(
        "official Go/original Rc/NativeNode/symbols; borrowed graph+refs and results survive Collation drop"
    );
    Ok(())
}
