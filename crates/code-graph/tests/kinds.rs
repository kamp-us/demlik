use demlik_code_graph::extract::assemble::{NodeFields, assemble_graph};
use demlik_code_graph::kinds::classify::{ClassifyContext, classify_function, compile_kind_rules};
use demlik_code_graph::kinds::rules::NodeKindRules;
use demlik_code_graph::project::load_cheap_project;
use demlik_code_graph::schema::{NodeKind, Thresholds};
use demlik_code_graph::text::JsValue;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn classifies_real_functions_with_default_rules_and_precise_custom_utf16_labels() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("demlik-kind-{}-{unique}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("entry.ts"), "export function fetch() {} export function requireAuth() {} export function plain() {} export function custom() {} ").unwrap();
    let loaded = load_cheap_project(&root, None).unwrap();
    let graph = assemble_graph(&loaded, Thresholds::default(), NodeFields::default()).unwrap();
    let rules =
        NodeKindRules::parse(&JsValue::parse(r#"{"entryNames":{"\ud800":["^custom$"]}}"#).unwrap())
            .unwrap();
    let custom = compile_kind_rules(&rules).unwrap();
    let defaults = compile_kind_rules(&NodeKindRules::default()).unwrap();
    let context = ClassifyContext::default();
    for function in &graph.functions {
        let kind = classify_function(function, &defaults, &context);
        match function.name.as_str() {
            "fetch" => assert!(matches!(kind, NodeKind::Entry { .. })),
            "requireAuth" => assert!(matches!(kind, NodeKind::Auth { .. })),
            "custom" => {
                assert!(matches!(kind, NodeKind::Plain));
                let classified = classify_function(function, &custom, &context);
                assert_eq!(
                    serde_json::to_string(&classified).unwrap(),
                    r#"{"kind":"entry","evidence":["\ud800"],"guards":[],"reach":"public"}"#
                );
            }
            _ => assert!(matches!(kind, NodeKind::Plain)),
        }
    }
    let bad = NodeKindRules::parse(
        &JsValue::parse(r#"{"entryExportConventions":{"bad":{"files":"x","exports":[]}}}"#)
            .unwrap(),
    )
    .unwrap_err();
    assert_eq!(
        bad.to_string(),
        "entryExportConventions.bad.exports: Too small: expected array to have >=1 items"
    );
    let invalid =
        NodeKindRules::parse(&JsValue::parse(r#"{"authNames":{"bad":["["]}}"#).unwrap()).unwrap();
    assert!(compile_kind_rules(&invalid).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn compiles_framework_globs_as_ucs2_patterns_with_literal_dynamic_segments() {
    use demlik_code_graph::kinds::glob::glob_to_regexp;
    for (glob, file, expected) in [
        ("{,src/}app/**/page.tsx", "app/page.tsx", true),
        (
            "{,src/}app/**/page.tsx",
            "src/app/(marketing)/[id]/page.tsx",
            true,
        ),
        ("{,src/}app/**/page.tsx", "lib/app/page.tsx", false),
        ("jobs/?.ts", "jobs/😀.ts", false),
        ("jobs/??.ts", "jobs/😀.ts", true),
        ("docs/**", "docs/a/b.ts", true),
        ("docs/**", "docs/a\nb.ts", false),
        ("docs/*", "docs/a\nb.ts", true),
    ] {
        assert_eq!(
            glob_to_regexp(&glob.into()).unwrap().test(&file.into()),
            expected,
            "{glob:?} / {file:?}"
        );
    }
    assert_eq!(
        glob_to_regexp(&"😀a,b".into()).unwrap_err().to_string(),
        "unbalanced \",\" at 3 in glob \"😀a,b\""
    );
}

#[test]
fn selects_framework_export_conventions_from_each_functions_actual_owning_package() {
    use demlik_code_graph::extract::conventions::{convention_entries, export_names_by_id};
    use demlik_code_graph::extract::functions::discover_functions;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "demlik-conventions-{}-{unique}",
        std::process::id()
    ));
    for (file, source) in [
        ("package.json", r#"{"name":"workspace"}"#),
        (
            "apps/web/package.json",
            r#"{"devDependencies":{"next":"*"}}"#,
        ),
        (
            "apps/web/app/[slug]/page.tsx",
            "function Home() { return <div/>; } export default Home; export function helper() {} export function generateMetadata() { return {}; }",
        ),
        ("apps/plain/package.json", "{}"),
        (
            "apps/plain/app/page.tsx",
            "export default function Plain() { return <div/>; }",
        ),
        ("apps/jobs/package.json", "{}"),
        (
            "apps/jobs/jobs/run.ts",
            "const run = () => 1; export { run as execute };",
        ),
    ] {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }
    let loaded = load_cheap_project(&root, None).unwrap();
    let functions = discover_functions(&loaded.source_files).functions;
    let rules = NodeKindRules::parse(&JsValue::parse(r#"{"entryExportConventions":{"job-runner":{"files":"jobs/*.ts","exports":["execute"]}}}"#).unwrap()).unwrap();
    let names = export_names_by_id(&functions);
    assert_eq!(names["apps/web/app/[slug]/page.tsx:Home"], ["default"]);
    assert_eq!(names["apps/jobs/jobs/run.ts:run"], ["execute"]);
    let entries = convention_entries(&functions, &rules, &root, &root).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(
        entries["apps/web/app/[slug]/page.tsx:Home"],
        ["nextjs/app-file"]
    );
    assert_eq!(
        entries["apps/web/app/[slug]/page.tsx:generateMetadata"],
        ["nextjs/app-metadata"]
    );
    assert_eq!(entries["apps/jobs/jobs/run.ts:run"], ["job-runner"]);
    assert!(!entries.contains_key("apps/plain/app/page.tsx:Plain"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn finds_public_base_class_entries_and_pothos_guards_through_native_compiler_declarations() {
    use demlik_code_graph::checker::context::{TypeContextInput, with_type_context};
    use demlik_code_graph::engine::tsgo::TsgoBinary;
    use demlik_code_graph::extract::functions::discover_functions;
    use demlik_code_graph::kinds::declarations::{
        merge_rule_maps, public_method_rules_by_base_class, sibling_property_rules,
        type_scope_rules,
    };
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "demlik-declared-kind-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    fs::write(root.join("entry.ts"), "declare class WorkerEntrypoint<E> {}\nclass Worker extends WorkerEntrypoint<unknown> { public call() {} private hidden() {} protected family() {} static build() {} #secret() {} get value() { return 1; } }\ndeclare const builder: any;\nconst Project = builder.objectRef('Project');\nProject.implement({ authScopes: { user: true }, fields: (t: any) => ({ one: t.field({ resolve: () => 101 }) }) });\nbuilder.objectField(Project, 'more', (t: any) => t.field({ resolve: () => 102 }));\nbuilder.objectField(Project, 'skip', (t: any) => t.field({ skipTypeScopes: true, resolve: () => 103 }));\nconst direct = { authScopes: { user: true }, resolve() { return 104; } };\nconst quoted = { 'authScopes': true, resolve() { return 105; } };\n").unwrap();
    let loaded = load_cheap_project(&root, None).unwrap();
    let functions = discover_functions(&loaded.source_files).functions;
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
    let binary = TsgoBinary::from_native_preview_manifest(&manifest).unwrap();
    let rules = compile_kind_rules(&NodeKindRules::default()).unwrap();
    with_type_context(
        &binary,
        TypeContextInput {
            project: &loaded,
            ts_config_path: &root.join("tsconfig.json"),
            functions: &functions,
        },
        |context| {
            let base = public_method_rules_by_base_class(context, &rules.entry_base_classes)?;
            assert_eq!(base.len(), 1);
            assert!(base.contains_key("entry.ts:call"));
            let siblings = sibling_property_rules(context, &rules.entry_guard_properties)?;
            let scopes = type_scope_rules(context, &rules.entry_guard_properties)?;
            let guards = merge_rule_maps([&siblings, &scopes]);
            for function in functions
                .iter()
                .filter(|function| function.name == "resolve")
            {
                assert_eq!(
                    guards.contains_key(&function.id),
                    matches!(function.start_line, 5 | 6 | 8),
                    "{} at {}",
                    function.id,
                    function.start_line
                );
            }
            Ok(())
        },
    )
    .unwrap();
    fs::remove_dir_all(root).unwrap();
}
