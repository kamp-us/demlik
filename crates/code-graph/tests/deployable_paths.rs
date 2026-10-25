use demlik_code_graph::{
    boundaries::{
        deployables::{
            cycles::{worker_cycles, worker_graph},
            workspaces::{cross_workspace_imports, workspace_at},
        },
        violation::BoundaryViolation,
    },
    extract::wrangler_config::load_binding_catalog,
    syntax::imports::{ImportEdge, ImportKind},
    text::JsString,
};
use indexmap::IndexSet;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn real_worker_configs_form_one_cycle_while_workspace_crossings_keep_the_first_spelling() {
    let root = std::env::temp_dir().join(format!(
        "demlik-deployable-native-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (dir, source) in [
        (
            "workers/a",
            r#"{"name":"a","services":[{"binding":"B","service":"b"},{"binding":"SELF","service":"a"},{"binding":"OUT","service":"outside"}],"durable_objects":{"bindings":[{"name":"ROOM","class_name":"Room","script_name":"outside"}]}}"#,
        ),
        (
            "workers/b",
            r#"{"name":"b","services":[{"binding":"A","service":"a"}]}"#,
        ),
    ] {
        fs::create_dir_all(root.join(dir)).unwrap();
        fs::write(root.join(dir).join("wrangler.json"), source).unwrap();
    }
    let catalog = load_binding_catalog(&root, None).unwrap();
    let graph = worker_graph(&catalog);
    assert_eq!(
        graph.workers,
        vec![JsString::from("a"), JsString::from("b")]
    );
    assert_eq!(graph.unresolved, 1);
    assert_eq!(graph.edges.len(), 2);
    let cycles = worker_cycles(&graph);
    assert!(
        matches!(&cycles[..],[BoundaryViolation::WorkerCallCycle {from,specifier,..}] if from=="a, b"&&specifier=="a.B -> b; b.A -> a")
    );
    let roots: IndexSet<_> = [".", "workers/a", "workers/b"]
        .into_iter()
        .map(JsString::from)
        .collect();
    assert_eq!(
        workspace_at(&roots, &"workers/a/src/missing.ts".into()),
        Some(&JsString::from("workers/a"))
    );
    let edges = vec![
        ImportEdge {
            specifier: "../b/missing.ts".into(),
            kind: ImportKind::Static,
            type_only: true,
            target: None,
        },
        ImportEdge {
            specifier: "..\\b\\other.ts".into(),
            kind: ImportKind::Static,
            type_only: false,
            target: None,
        },
    ];
    let crossing = cross_workspace_imports(
        &roots,
        &"workers/a".into(),
        &"workers/a/index.ts".into(),
        &edges,
    );
    assert!(
        matches!(&crossing[..],[BoundaryViolation::RelativeImportCrossesWorkspace {from,to,specifier,type_only:false}] if from=="workers/a/index.ts"&&to=="workers/b"&&specifier=="../b/missing.ts")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn worker_facts_own_binding_policy_and_census_while_disabled_rules_read_nothing() {
    use demlik_code_graph::{
        boundaries::{
            deployables::{
                BindingOwners, DeployableFile, DeployablesRead,
                bindings::{binding_owner_issue, binding_sites_of, binding_violations},
                census::{SiteRow, deployable_census, deployable_census_lines},
                is_worker_main, read_deployables, worker_of,
            },
            rules::BoundaryRules,
        },
        engine::oxc::parse_type_script,
        text::JsValue,
    };
    let root = std::env::temp_dir().join(format!(
        "demlik-binding-native-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (dir, config) in [
        (
            "services/a",
            r#"{"name":"a","main":"src/main.ts","services":[{"binding":"API","service":"b"}],"d1_databases":[{"binding":"DB"}],"workflows":[{"binding":"FLOW","class_name":"Run"}]}"#,
        ),
        ("services/b", r#"{"name":"b"}"#),
    ] {
        fs::create_dir_all(root.join(dir).join("src")).unwrap();
        fs::write(root.join(dir).join("wrangler.json"), config).unwrap();
        fs::write(root.join(dir).join("package.json"), "{}").unwrap();
    }
    let source = "env.DB.prepare('select 1'); env.API.fetch('/'); env.FLOW.create();";
    fs::write(root.join("services/a/src/main.ts"), source).unwrap();
    let catalog = load_binding_catalog(&root, None).unwrap();
    let rules=BoundaryRules::parse(&JsValue::parse(r#"{"acrossDeployables":["binding-outside-driven-adapter","relative-import-crosses-workspace"]}"#).unwrap()).unwrap();
    let DeployablesRead::Read(deployables) = read_deployables(&rules, &root, None, &catalog) else {
        panic!("valid worker configs refused")
    };
    let scope = JsString::from("services/a");
    let from = JsString::from("services/a/src/main.ts");
    let rel = JsString::from("src/main.ts");
    let syntax = parse_type_script(
        std::path::Path::new("main.ts"),
        &fs::read_to_string(root.join("services/a/src/main.ts")).unwrap(),
    )
    .unwrap();
    let sites = binding_sites_of(&deployables, &from, &syntax);
    assert_eq!(
        sites
            .iter()
            .map(|site| site.binding.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["DB", "API"]
    );
    let owner = worker_of(&deployables, &from).unwrap();
    assert_eq!(deployables.judged_for(owner).unwrap().len(), 2);
    assert!(is_worker_main(&deployables, &from));
    let owners = Default::default();
    let facts = DeployableFile {
        scope: &scope,
        file: &rel,
        from: &from,
        import_edges: &[],
        binding_sites: &sites,
        driven: false,
        is_main: true,
        owners: BindingOwners::Record(&owners),
    };
    assert!(binding_violations(&facts).unwrap().is_empty());
    let application = DeployableFile {
        is_main: false,
        ..facts
    };
    assert_eq!(binding_violations(&application).unwrap().len(), 2);
    let driven = DeployableFile {
        driven: true,
        ..application
    };
    assert!(binding_violations(&driven).unwrap().is_empty());
    let ownership = [(JsString::from("DB"), vec![rel.clone()])]
        .into_iter()
        .collect();
    assert!(
        binding_owner_issue(
            &scope,
            &ownership,
            &[rel].into_iter().collect(),
            &deployables
        )
        .is_none()
    );
    let mut rows: Vec<_> = sites
        .iter()
        .map(|site| SiteRow {
            file: from.clone(),
            line: site.line,
            binding: site.binding.clone(),
        })
        .collect();
    rows.push(rows[0].clone());
    let census = deployable_census(&deployables, &rows).unwrap();
    assert_eq!(census.workers.len(), 1);
    assert_eq!(census.workers[0].bindings[&JsString::from("DB")], 2);
    assert_eq!(
        deployable_census_lines(&census)[0],
        "deployables: 1 worker using bindings, 3 sites, 0 service bindings to a worker with no config in the repo"
    );
    let DeployablesRead::Read(disabled) = read_deployables(
        &BoundaryRules::default(),
        &root.join("missing"),
        None,
        &catalog,
    ) else {
        panic!("disabled rules refused")
    };
    assert!(disabled.catalog.manifests.is_empty());
    assert!(disabled.workspaces.is_empty());
    assert!(worker_of(&disabled, &from).is_none());
    fs::remove_dir_all(root).unwrap();
}
