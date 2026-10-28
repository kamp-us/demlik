//! Intended K interface proof. It is compile-only input until Root approves construction.
use demlik_code_graph::{
    boundaries::{
        deployables::{
            Deployables,
            census::{SiteRow, deployable_census},
        },
        rules::DeployableKind,
    },
    extract::wrangler_config::{BindingCatalog, ServiceManifest},
    project::Collation,
};
use std::{cell::Cell, rc::Rc};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = ServiceManifest {
        service: "Z".into(),
        dir: "workers/Z".into(),
        config_file: "workers/Z/wrangler.json".into(),
        main: None,
        bindings: vec![],
        data_bindings: vec![],
        env_keys: vec![],
        binding_names: vec![],
        dev_vars_keys: vec![],
        dev_vars_files: vec![],
    };
    let catalog = BindingCatalog {
        manifests: vec![manifest],
        unparsed_configs: vec![],
    };
    let mut model: Deployables<'_> = Deployables::empty();
    model.catalog = &catalog;
    model
        .kinds
        .insert(DeployableKind::BindingOutsideDrivenAdapter);
    let same = SiteRow {
        file: "workers/Z/file.ts".into(),
        line: f64::NAN,
        binding: "b".into(),
    };
    let equal = SiteRow {
        file: same.file.clone(),
        line: same.line,
        binding: same.binding.clone(),
    };
    let host = Rc::new(Cell::new(0));
    let note = |row: &SiteRow| {
        host.set(host.get() + 1);
        assert!(std::ptr::eq(row, &same) || std::ptr::eq(row, &equal));
    };
    let collation = Collation::try_node22_en_us()?;
    let census = deployable_census(&model, [&same, &equal, &same], &collation)?;
    drop(collation);
    let census = census.expect("enabled census");
    assert_eq!(census.workers.len(), 1);
    let sites = &census.workers[0].sites;
    assert_eq!(sites.len(), 3);
    assert!(std::ptr::eq(sites[0], &same));
    assert!(std::ptr::eq(sites[1], &equal));
    assert!(std::ptr::eq(sites[2], &same));
    for site in sites {
        note(site);
    }
    assert_eq!(host.get(), 3);
    Ok(())
}
