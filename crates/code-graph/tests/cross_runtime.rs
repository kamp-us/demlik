use demlik_code_graph::checker::context::{TypeContextInput, with_type_context};
use demlik_code_graph::engine::tsgo::TsgoBinary;
use demlik_code_graph::extract::cross_runtime::{
    CrossRuntimeInput, create_cross_runtime_resolver, method_ids_of_classes, owner_of,
};
use demlik_code_graph::extract::edges::resolve_edges_with_cross_runtime;
use demlik_code_graph::extract::functions::discover_functions;
use demlik_code_graph::extract::wrangler_config::load_binding_catalog;
use demlik_code_graph::project::load_cheap_project;
use demlik_code_graph::schema::CrossRuntimeReason;
use demlik_code_graph::syntax::imports::resolve_imports;
use indexmap::IndexSet;
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn resolves_real_service_and_workflow_calls_without_losing_missing_targets_or_private_methods() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "demlik-cross-runtime-{}-{unique}",
        std::process::id()
    ));
    for (file, text) in [
        (
            "tsconfig.json",
            r#"{"compilerOptions":{"types":[],"strict":true}}"#,
        ),
        (
            "api/wrangler.json",
            r#"{"name":"api","services":[{"binding":"SEARCH","service":"worker","entrypoint":"Search"},{"binding":"MISSING","service":"\ud800","entrypoint":"Absent"}],"durable_objects":{"bindings":[{"name":"ROOM","class_name":"Room"}]},"workflows":[{"binding":"FLOW","class_name":"Flow","script_name":"worker"}]}"#,
        ),
        ("worker/wrangler.toml", "name='worker'\n"),
        (
            "api/entry.ts",
            "export class Api {\n  constructor(private env: any) {}\n  execute() {\n    this.env.SEARCH.search(); this.env.SEARCH.search();\n    this.env.MISSING.load();\n    this.env.FLOW.create({});\n    this.env.FLOW.createBatch([]);\n    this.env.FLOW.get('ignored');\n    this.env.ROOM.hit();\n  }\n}\n",
        ),
        (
            "api/room.ts",
            "export class Room { hit() {} private hidden() {} static build() {} }\n",
        ),
        ("worker/search.ts", "export class Search { search() {} }\n"),
        (
            "worker/flow.ts",
            "class FlowImpl { run() {} }\ndeclare function wrap<T>(value: T): T;\nconst Flow = wrap(FlowImpl);\n",
        ),
    ] {
        let file = root.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    let root = fs::canonicalize(root).unwrap();
    let catalog = load_binding_catalog(&root, None).unwrap();
    assert_eq!(
        owner_of(&catalog.manifests, "api/entry.ts")
            .unwrap()
            .service,
        "api"
    );
    assert!(owner_of(&catalog.manifests, "api-other/entry.ts").is_none());
    let loaded = load_cheap_project(&root, None).unwrap();
    assert!(loaded.parse_failures.is_empty());
    let functions = discover_functions(&loaded.source_files).functions;
    let ids = functions
        .iter()
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    let imports = resolve_imports(&root, &loaded.source_files, &root.join("tsconfig.json"));
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
    let binary = TsgoBinary::from_native_preview_manifest(&manifest).unwrap();
    with_type_context(
        &binary,
        TypeContextInput {
            project: &loaded,
            ts_config_path: &root.join("tsconfig.json"),
            functions: &functions,
        },
        |context| {
            assert!(context.unjoined.is_empty());
            let classes: IndexSet<_> = ["Room".into(), "Flow".into()].into_iter().collect();
            let methods = method_ids_of_classes(context, &classes)?;
            assert_eq!(methods.len(), 4);
            assert!(methods.contains("api/room.ts:hidden"));
            assert!(methods.contains("api/room.ts:build"));
            assert!(methods.contains("worker/flow.ts:run"));
            let mut resolver = create_cross_runtime_resolver(
                CrossRuntimeInput {
                    catalog: &catalog,
                    root_absolute: &root,
                    repo_root: &root,
                },
                context,
            )?;
            let result =
                resolve_edges_with_cross_runtime(context, imports, &ids, Some(&mut resolver))?;
            let measured = resolver.edges();
            assert_eq!(measured.len(), 5);
            assert_eq!(
                measured
                    .iter()
                    .filter(|edge| edge.binding == "SEARCH")
                    .count(),
                1
            );
            let missing = measured
                .iter()
                .find(|edge| edge.binding == "MISSING")
                .unwrap();
            assert_eq!(
                missing.reason,
                Some(CrossRuntimeReason::TargetServiceUnknown)
            );
            assert!(missing.callee_id.is_none());
            assert_eq!(missing.target_service.units(), [0xd800]);
            for edge in measured.iter().filter(|edge| edge.binding == "FLOW") {
                assert_eq!(edge.callee_id.as_deref(), Some("worker/flow.ts:run"));
                assert!(edge.reason.is_none());
            }
            let calls = &result.calls_by_id["api/entry.ts:execute"];
            assert_eq!(calls.len(), 6);
            let unresolved = calls
                .iter()
                .find(|site| site.callee_id.starts_with("unresolved:"))
                .unwrap();
            assert_eq!(
                serde_json::to_string(&unresolved.callee_id).unwrap(),
                r#""unresolved:\ud800.Absent.load""#
            );
            assert_eq!(result.called_by_id["worker/search.ts:search"].len(), 1);
            assert_eq!(result.called_by_id["worker/flow.ts:run"].len(), 2);
            Ok(())
        },
    )
    .unwrap();
    fs::remove_dir_all(root).unwrap();
}
