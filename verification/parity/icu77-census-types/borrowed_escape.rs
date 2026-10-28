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
    let collation = Collation::try_node22_en_us()?;
    let census = {
        let row = SiteRow {
            file: "workers/Z/a.ts".into(),
            line: 1.0,
            binding: "DB".into(),
        };
        deployable_census(&model, [&row], &collation)?
    };
    println!("{}", census.unwrap().workers[0].sites[0].line);
    Ok(())
}
