use demlik_code_graph::{
    checker::context::{TypeContextInput, with_type_context},
    engine::tsgo::TsgoBinary,
    extract::references::ReferenceResult,
    extract::{
        analysis::{NamedSymbol, analysis_inputs},
        assemble::{NodeFields, assemble_graph},
        edges::resolve_edges,
        functions::discover_functions,
        references::resolve_references,
    },
    project::{Collation, EdgeScope, load_cheap_project, load_edge_project},
    query::{
        clusters::build_cluster_report,
        interface_width::find_interface_width,
        louvain::{Edge, louvain},
    },
    schema::{Edges, Thresholds},
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
        let (graph, report, width, part) = {
            let collation = Collation::try_node22_en_us()?;
            let graph = assemble_graph(
                &loaded,
                Thresholds::default(),
                NodeFields::default(),
                &collation,
            )?;
            let refs = ReferenceResult {
                references_by_id: Default::default(),
                module_scope_roots: vec![],
                test_module_scope_roots: vec![],
                identifier_files: Default::default(),
            };
            let original = graph.functions.as_ptr();
            let report = build_cluster_report(&graph.functions, &graph.modules, &collation)?;
            let width = find_interface_width(
                &graph.functions,
                &refs,
                &["packages/a".into(), "packages/b".into()],
                &collation,
            )?;
            let part = louvain(
                &["z".into(), "middle".into(), "a".into()],
                &[
                    Edge {
                        a: "middle".into(),
                        b: "z".into(),
                        weight: 1.0,
                    },
                    Edge {
                        a: "middle".into(),
                        b: "a".into(),
                        weight: 1.0,
                    },
                ],
                &collation,
            )?;
            assert_eq!(original, graph.functions.as_ptr());
            (graph, report, width, part)
        };
        assert!(graph.functions.len() > 4);
        assert_eq!(report.cluster_count, 0);
        assert_eq!(width.len(), 2);
        assert_eq!(part.membership.len(), 3);
        borrowed.set(graph.functions.len());
        assert!(calls.get() > 4);
        println!(
            "syntax-only/no config/no compiler; borrowed original graph and query results usable after Collation drop"
        );
        return Ok(());
    }
    let loaded = load_edge_project(root, EdgeScope::Package, root, None)?;
    let binary = TsgoBinary::from_native_preview_manifest(Path::new(&args[3]))?;
    let (graph, report, width, part) = {
        let collation = Collation::try_node22_en_us()?;
        let found = discover_functions(&loaded.project.source_files, &collation)?;
        assert!(found.functions.len() > 4);
        let ids: Vec<_> = found.functions.iter().map(|f| f.id.clone()).collect();
        let inputs = analysis_inputs(found.functions.iter().map(NamedSymbol::from), &collation)?;
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
        let mut edges = edges?;
        let references = references?;
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
        let original = graph.functions.as_ptr();
        let report = build_cluster_report(&graph.functions, &graph.modules, &collation)?;
        let width = find_interface_width(
            &graph.functions,
            &references,
            &["packages/a".into(), "packages/b".into()],
            &collation,
        )?;
        let part = louvain(&["z".into(), "a".into(), "m".into()], &[], &collation)?;
        assert_eq!(original, graph.functions.as_ptr());
        (graph, report, width, part)
    };
    assert!(calls.get() > 2);
    assert!(graph.functions.len() > 4);
    assert_eq!(report.cluster_count, 3);
    assert!(!report.scattered_clusters.is_empty());
    assert!(!report.split_directories.is_empty());
    assert_eq!(width.len(), 2);
    assert!(
        width
            .iter()
            .flat_map(|p| &p.exports)
            .any(|e| !e.external_consumers.is_empty())
    );
    assert_eq!(
        part.membership
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["z", "a", "m"]
    );
    println!(
        "official Go facts/original Rc/NativeNode/symbol cache; borrowed query input/results survive Collation drop"
    );
    Ok(())
}
