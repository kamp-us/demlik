use demlik_code_graph::{
    data::{access::access_of, extract::binding_sites},
    engine::oxc::parse_type_script,
    schema::{DataAccess, DataBindingKind},
    text::JsString,
};
use indexmap::IndexMap;
use std::{fs, path::Path};

#[test]
fn finds_each_handlers_own_binding_and_classifies_its_literal_sql() {
    struct Binding {
        name: JsString,
        kind: DataBindingKind,
    }
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/test/data/alias-scope/workers/app/src/handlers.ts");
    let text = fs::read_to_string(&file).unwrap();
    let syntax = parse_type_script(&file, &text).unwrap();
    let bindings: IndexMap<_, _> = ["DB", "OTHER"]
        .into_iter()
        .map(|name| {
            (
                JsString::from(name),
                Binding {
                    name: name.into(),
                    kind: DataBindingKind::D1,
                },
            )
        })
        .collect();
    let sites = binding_sites(&syntax, &bindings);
    assert_eq!(
        sites
            .iter()
            .map(|site| (site.line, site.decl.name.to_utf8().unwrap()))
            .collect::<Vec<_>>(),
        [
            (11, "DB"),
            (15, "OTHER"),
            (23, "DB"),
            (27, "OTHER"),
            (39, "DB"),
            (46, "DB"),
            (51, "DB"),
            (59, "DB"),
            (71, "DB")
        ]
        .into_iter()
        .map(|(line, name)| (line, name.to_owned()))
        .collect::<Vec<_>>()
    );
    assert!(sites.iter().all(|site| {
        site.method
            .as_ref()
            .is_some_and(|method| method == "prepare")
    }));
    assert!(sites.iter().all(|site| matches!(
        access_of(site.decl.kind, site.method.as_ref(), site.sql.as_ref()),
        DataAccess::Read
    )));
}

#[test]
fn loads_real_worker_reports_with_named_holders_unattributed_handlers_and_distinct_columns() {
    let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
    use demlik_code_graph::{
        data::extract::load_data_report,
        extract::{functions::discover_functions, wrangler_config::CatalogError},
        project::load_cheap_project,
    };
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};
    let root = std::env::temp_dir().join(format!(
        "demlik-native-data-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/code-graph/test/data/fixture");
    for (source, destination) in [
        ("tsconfig.json", "tsconfig.json"),
        (
            "workers/api/wrangler.fixture.jsonc",
            "workers/api/wrangler.jsonc",
        ),
        (
            "workers/billing/wrangler.fixture.toml",
            "workers/billing/wrangler.toml",
        ),
        ("workers/api/src/orgs.ts", "workers/api/src/orgs.ts"),
        ("workers/api/src/routes.ts", "workers/api/src/routes.ts"),
        ("workers/api/src/storage.ts", "workers/api/src/storage.ts"),
        (
            "workers/billing/src/invoices.ts",
            "workers/billing/src/invoices.ts",
        ),
    ] {
        let destination = root.join(destination);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(fixture.join(source), destination).unwrap();
    }
    let root = fs::canonicalize(root).unwrap();
    let loaded = load_cheap_project(&root, None, &project_collation).unwrap();
    assert!(loaded.parse_failures.is_empty());
    let functions = discover_functions(&loaded.source_files, &project_collation)
        .unwrap()
        .functions;
    let report =
        load_data_report(&loaded.source_files, &functions, &root, &project_collation).unwrap();
    assert_eq!(
        report.config_files,
        [
            "workers/api/wrangler.jsonc",
            "workers/billing/wrangler.toml"
        ]
    );
    assert!(report.unparsed_configs.is_empty());
    let value: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&report).unwrap()).unwrap();
    let edges = value["edges"].as_array().unwrap();
    let rows = edges
        .iter()
        .map(|row| {
            json!([
                row["functionId"],
                row["line"],
                row["ownerService"],
                row["bindingKind"],
                row["binding"],
                row["method"],
                row["access"]
            ])
        })
        .collect::<Vec<_>>();
    assert_eq!(
        rows,
        json!([
            [
                "workers/api/src/orgs.ts:cachedOrganization",
                17,
                "api",
                "kv",
                "CACHE",
                "get",
                "read"
            ],
            [
                "workers/api/src/orgs.ts:cachedOrganization",
                20,
                "api",
                "kv",
                "CACHE",
                "put",
                "write"
            ],
            [
                "workers/api/src/orgs.ts:getOrganization",
                7,
                "api",
                "d1",
                "DB",
                "prepare",
                "read"
            ],
            [
                "workers/api/src/orgs.ts:renameOrganization",
                11,
                "api",
                "d1",
                "DB",
                "prepare",
                "write"
            ],
            [
                "workers/api/src/orgs.ts:renameOrganization",
                12,
                "api",
                "kv",
                "CACHE",
                "delete",
                "write"
            ],
            [
                "workers/api/src/orgs.ts:repository",
                33,
                "api",
                "d1",
                "DB",
                null,
                "unknown"
            ],
            [
                "workers/api/src/orgs.ts:runQuery",
                25,
                "api",
                "d1",
                "DB",
                "prepare",
                "unknown"
            ],
            [
                "workers/api/src/routes.ts:purgeOrganizations",
                20,
                "api",
                "d1",
                "DB",
                "batch",
                "unknown"
            ],
            [
                "workers/api/src/routes.ts:purgeOrganizations",
                20,
                "api",
                "d1",
                "DB",
                "prepare",
                "read"
            ],
            [
                "workers/api/src/routes.ts:purgeOrganizations",
                20,
                "api",
                "d1",
                "DB",
                "prepare",
                "write"
            ],
            [
                "workers/api/src/storage.ts:archive",
                14,
                "api",
                "r2",
                "ASSETS",
                "put",
                "write"
            ],
            [
                "workers/api/src/storage.ts:archive",
                15,
                "api",
                "queue",
                "EVENTS",
                "send",
                "write"
            ],
            [
                "workers/api/src/storage.ts:bump",
                9,
                "api",
                "durable-object",
                "COUNTER",
                "get",
                "unknown"
            ],
            [
                "workers/api/src/storage.ts:bump",
                9,
                "api",
                "durable-object",
                "COUNTER",
                "idFromName",
                "unknown"
            ],
            [
                "workers/api/src/storage.ts:exists",
                22,
                "api",
                "r2",
                "ASSETS",
                "head",
                "read"
            ],
            [
                "workers/billing/src/invoices.ts:endSessions",
                12,
                "billing",
                "kv",
                "SESSIONS",
                "delete",
                "write"
            ],
            [
                "workers/billing/src/invoices.ts:exportAll",
                16,
                "billing",
                "d1",
                "DB",
                "dump",
                "read"
            ],
            [
                "workers/billing/src/invoices.ts:listInvoices",
                8,
                "billing",
                "d1",
                "DB",
                "prepare",
                "read"
            ]
        ])
        .as_array()
        .unwrap()
        .to_vec()
    );
    let columns = edges
        .iter()
        .filter(|row| row["functionId"] == "workers/api/src/routes.ts:purgeOrganizations")
        .map(|row| row["column"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(columns, [10, 20, 55]);
    assert_eq!(
        value["unattributed"],
        json!([
            {"file":"workers/api/src/routes.ts","line":10,"column":25,"ownerService":"api","bindingKind":"d1","binding":"DB","method":"prepare","access":"read"},
            {"file":"workers/api/src/routes.ts","line":14,"column":9,"ownerService":"api","bindingKind":"kv","binding":"CACHE","method":"delete","access":"write"}
        ])
    );
    fs::create_dir_all(root.join("workers/broken")).unwrap();
    fs::write(
        root.join("workers/broken/wrangler.jsonc"),
        "{\"d1_databases\":[{\"binding\":\"DB\"}",
    )
    .unwrap();
    fs::write(
        root.join("workers/broken/entry.ts"),
        "export function ignored(env: any) {env.DB.prepare('SELECT 1');}",
    )
    .unwrap();
    let broken = load_cheap_project(&root, None, &project_collation).unwrap();
    assert!(broken.parse_failures.is_empty());
    let broken_functions = discover_functions(&broken.source_files, &project_collation)
        .unwrap()
        .functions;
    let broken_report = load_data_report(
        &broken.source_files,
        &broken_functions,
        &root,
        &project_collation,
    )
    .unwrap();
    assert_eq!(
        broken_report.unparsed_configs,
        ["workers/broken/wrangler.jsonc"]
    );
    assert_eq!(broken_report.edges.len(), 18);
    assert_eq!(broken_report.unattributed.len(), 2);
    fs::write(
        root.join("workers/broken/wrangler.jsonc"),
        r#"{"vars":{"constructor":null}}"#,
    )
    .unwrap();
    assert!(matches!(
        load_data_report(
            &broken.source_files,
            &broken_functions,
            &root,
            &project_collation
        ),
        Err(CatalogError::Record(_))
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn assembles_requested_data_in_both_passes_and_preserves_unrequested_empty_and_failed_reports() {
    let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
    use demlik_code_graph::{
        engine::tsgo::TsgoBinary,
        extract::{
            analysis::AnalysisOptions,
            assemble::{
                AssemblyError, DataOptions, NodeFields, assemble_graph, assemble_graph_with_data,
                assemble_graph_with_reports,
            },
            wrangler_config::CatalogError,
        },
        kinds::rules::NodeKindRules,
        project::{EdgeScope, load_cheap_project, load_edge_project},
        schema::Thresholds,
    };
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};
    let root = std::env::temp_dir().join(format!(
        "demlik-data-assembly-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
    )
    .unwrap();
    fs::write(
        root.join("wrangler.json"),
        r#"{"name":"worker","main":"src/entry.ts","d1_databases":[{"binding":"DB"}]}"#,
    )
    .unwrap();
    fs::write(root.join("src/entry.ts"), "declare const env: any;\nenv.DB.exec('SELECT boot');\nexport function read(env: any) { return env.DB.prepare('SELECT 1'); }\nexport function fetch(env: any) { return read(env); }\n").unwrap();
    let root = fs::canonicalize(root).unwrap();
    let loaded = load_cheap_project(&root, None, &project_collation).unwrap();
    let fields = NodeFields { headers: true };
    assert!(
        assemble_graph(&loaded, Thresholds::default(), fields, &project_collation)
            .unwrap()
            .data
            .is_none()
    );
    let data = DataOptions { repo_root: &root };
    let cheap = assemble_graph_with_data(
        &loaded,
        Thresholds::default(),
        fields,
        data,
        &project_collation,
    )
    .unwrap();
    let report = cheap.data.as_ref().unwrap();
    assert_eq!((report.edges.len(), report.unattributed.len()), (1, 1));
    assert_eq!(report.edges[0].function_id, "src/entry.ts:read");
    assert_eq!(report.edges[0].site.line, 3);
    assert_eq!(report.edges[0].site.access, DataAccess::Read);
    assert_eq!(report.unattributed[0].site.line, 2);
    let expected_data = serde_json::to_value(report).unwrap();
    let binary = TsgoBinary::from_native_preview_manifest(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json"),
    )
    .unwrap();
    let measured =
        load_edge_project(&root, EdgeScope::Package, &root, None, &project_collation).unwrap();
    let rules = NodeKindRules::default();
    let analysis = AnalysisOptions {
        cross_runtime: true,
        kinds: true,
        reach: true,
        clusters: true,
        interface_width: true,
        kind_rules: &rules,
        repo_root: &root,
    };
    for options in [None, Some(&analysis)] {
        let graph = assemble_graph_with_reports(
            &measured,
            Thresholds::default(),
            &binary,
            fields,
            options,
            Some(data),
            &project_collation,
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&graph.data).unwrap(), expected_data);
        let fetch = graph
            .functions
            .iter()
            .find(|function| function.name == "fetch")
            .unwrap();
        assert!(
            fetch
                .edges
                .as_ref()
                .unwrap()
                .calls
                .iter()
                .any(|call| call.callee_id == "src/entry.ts:read")
        );
        assert_eq!(graph.cross_runtime.is_some(), options.is_some());
        assert_eq!(graph.reachability.is_some(), options.is_some());
        assert_eq!(graph.clusters.is_some(), options.is_some());
        assert_eq!(graph.interface_width.is_some(), options.is_some());
    }
    let empty = root.join("empty");
    fs::create_dir_all(&empty).unwrap();
    let empty_graph = assemble_graph_with_data(
        &loaded,
        Thresholds::default(),
        fields,
        DataOptions { repo_root: &empty },
        &project_collation,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(empty_graph.data).unwrap(),
        json!({"configFiles":[],"unparsedConfigs":[],"edges":[],"unattributed":[]})
    );
    fs::write(
        root.join("wrangler.json"),
        r#"{"vars":{"constructor":null}}"#,
    )
    .unwrap();
    assert!(
        assemble_graph(&loaded, Thresholds::default(), fields, &project_collation)
            .unwrap()
            .data
            .is_none()
    );
    assert!(
        assemble_graph_with_reports(
            &measured,
            Thresholds::default(),
            &binary,
            fields,
            None,
            None,
            &project_collation
        )
        .unwrap()
        .data
        .is_none()
    );
    assert!(matches!(
        assemble_graph_with_data(
            &loaded,
            Thresholds::default(),
            fields,
            data,
            &project_collation
        ),
        Err(AssemblyError::Data(CatalogError::Record(_)))
    ));
    assert!(matches!(
        assemble_graph_with_reports(
            &measured,
            Thresholds::default(),
            &binary,
            fields,
            None,
            Some(data),
            &project_collation
        ),
        Err(AssemblyError::Data(CatalogError::Record(_)))
    ));
    fs::remove_dir_all(root).unwrap();
}
