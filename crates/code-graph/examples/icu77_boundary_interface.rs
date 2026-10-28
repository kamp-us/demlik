use demlik_code_graph::{
    boundaries::{
        analyze::{BoundaryModule, ScopeInputs, analyze_boundaries},
        deployables::{DeployablesRead, read_deployables, worker_of},
        impure_uses::detect_impure_uses,
        libraries::{LibrariesRead, read_libraries},
        rules::BoundaryRules,
        shape::{ShapeRead, read_shape, shape_facts_of},
    },
    extract::wrangler_config::load_binding_catalog,
    project::{Collation, EdgeScope, load_edge_project},
    syntax::imports::{resolve_imports, runtime_specifiers},
    text::{JsString, JsValue},
};
use std::{path::Path, rc::Rc};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args().nth(1).expect("workflow root");
    let root = Path::new(&root);
    let rules = BoundaryRules::parse(&JsValue::parse(&std::fs::read_to_string(
        root.join("rules.json"),
    )?)?)?;
    let c = Collation::try_node22_en_us()?;
    let catalog = load_binding_catalog(root, None, &c)?;
    let LibrariesRead::Read(libraries) = read_libraries(&rules, root, None, &c)? else {
        panic!("valid libraries")
    };
    let DeployablesRead::Read(deployables) = read_deployables(&rules, root, None, &catalog, &c)?
    else {
        panic!("valid deployables")
    };
    let ShapeRead::Read(shape) = read_shape(&rules, &catalog)? else {
        panic!("valid shape")
    };
    let scope = JsString::from("services/api");
    let loaded = load_edge_project(
        &root.join("services/api"),
        EdgeScope::Package,
        root,
        None,
        &c,
    )?;
    assert!(loaded.project.source_files.len() > 2);
    let original = Rc::clone(&loaded.project.source_files[0]);
    let graph = resolve_imports(
        &loaded.project.root_absolute,
        &loaded.project.source_files,
        &loaded.ts_config_path,
        &c,
    )?;
    let facts: Vec<_> = loaded
        .project
        .source_files
        .iter()
        .map(|u| {
            let file = JsString::from(u.file.as_str());
            let impure = detect_impure_uses(&u.syntax, &c)?;
            let runtime = runtime_specifiers(&u.syntax);
            let names = demlik_code_graph::boundaries::libraries::allowance::imported_names_for(
                &libraries, &scope, &u.syntax,
            );
            let sites = demlik_code_graph::boundaries::deployables::bindings::binding_sites_of(
                &deployables,
                &demlik_code_graph::boundaries::rules::in_scope(&scope, &file),
                &u.syntax,
            );
            let shape_facts = shape_facts_of(&shape, &scope, &file, &u.syntax);
            Ok::<_, Box<dyn std::error::Error>>((file, impure, runtime, names, sites, shape_facts))
        })
        .collect::<Result<_, _>>()?;
    let modules: Vec<_> = facts
        .iter()
        .zip(&loaded.project.source_files)
        .map(|(f, u)| BoundaryModule {
            file: &f.0,
            import_edges: graph
                .import_edges_by_file
                .get(&u.file)
                .map_or(&[], Vec::as_slice),
            impure_uses: &f.1,
            runtime_specifiers: &f.2,
            imported_names: &f.3,
            binding_sites: &f.4,
            shape: &f.5,
        })
        .collect();
    let report = analyze_boundaries(
        &scope,
        &modules,
        &rules,
        ScopeInputs {
            libraries: &libraries,
            deployables: &deployables,
            shape: &shape,
        },
        &c,
    )?;
    let worker = worker_of(&deployables, &JsString::from("services/api/src/main.ts")).unwrap();
    assert!(catalog.manifests.iter().any(|m| std::ptr::eq(m, worker)));
    assert!(Rc::ptr_eq(&original, &loaded.project.source_files[0]));
    drop(c);
    assert!(report.report.files_scanned > 2.0);
    assert!(!report.report.violations.is_empty());
    println!(
        "{} original modules, {} original manifests, {} verdicts",
        report.report.files_scanned,
        catalog.manifests.len(),
        report.report.violations.len()
    );
    Ok(())
}
