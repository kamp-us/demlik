use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use demlik_code_graph::checker::context::{TypeContextInput, with_type_context};
use demlik_code_graph::declarations::discover::discover_declarations;
use demlik_code_graph::declarations::uses::resolve_declaration_uses;
use demlik_code_graph::engine::tsgo::TsgoBinary;
use demlik_code_graph::extract::edges::resolve_edges;
use demlik_code_graph::extract::functions::discover_functions;
use demlik_code_graph::extract::references::resolve_references;
use demlik_code_graph::project::load_cheap_project;
use demlik_code_graph::syntax::imports::resolve_imports;
use indexmap::{IndexMap, IndexSet};

static ORDINAL: AtomicU64 = AtomicU64::new(0);
struct Project(PathBuf);
impl Project {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "demlik-native-edges-{}-{}",
            std::process::id(),
            ORDINAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn write(&self, file: &str, text: &str) {
        let file = self.0.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    fn binary(&self) -> TsgoBinary {
        TsgoBinary::from_native_preview_manifest(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join(
                "../../packages/code-graph/node_modules/@typescript/native-preview/package.json",
            ),
        )
        .unwrap()
    }
}
impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn resolves_real_alias_factory_and_recursive_calls_with_constant_arguments() {
    let project = Project::new();
    project.write(
        "tsconfig.json",
        r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
    );
    project.write("origin.ts", "export const TOKEN = 'fixed';\nexport function target(value: string) { return value; }\nexport function recursion(n: number): string { if (n) return recursion(n - 1); return target(TOKEN); }\n");
    project.write("entry.ts", "import { target as renamed, TOKEN, recursion } from './origin';\nfunction factory(config: { handle: () => number }) { return () => config.handle(); }\nconst wrapped = factory({ handle() { return 1; } });\nexport function run() { renamed(TOKEN); renamed(TOKEN); wrapped(); recursion(1); }\n");
    let loaded = load_cheap_project(&project.0, None).unwrap();
    let functions = discover_functions(&loaded.source_files).functions;
    let ids: Vec<_> = functions
        .iter()
        .map(|function| function.id.clone())
        .collect();
    let imports = resolve_imports(
        &project.0,
        &loaded.source_files,
        &project.0.join("tsconfig.json"),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let edges = with_type_context(
        &project.binary(),
        TypeContextInput {
            project: &loaded,
            ts_config_path: &project.0.join("tsconfig.json"),
            functions: &functions,
        },
        |context| {
            assert!(context.unjoined.is_empty());
            resolve_edges(context, imports, &ids)
        },
    )
    .unwrap();
    let run = &edges.calls_by_id["entry.ts:run"];
    assert_eq!(
        run.iter()
            .map(|site| site.callee_id.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["entry.ts:handle", "origin.ts:recursion", "origin.ts:target"]
    );
    assert!(
        run.iter()
            .all(|site| site.line == 4 && site.declaration.is_none())
    );
    assert_eq!(run[2].const_args, ["TOKEN"]);
    assert_eq!(edges.called_by_id["origin.ts:target"].len(), 2);
    assert_eq!(edges.chain_depth_by_id["origin.ts:target"], 0);
    assert_eq!(edges.chain_depth_by_id["origin.ts:recursion"], 2);
    assert_eq!(edges.chain_depth_by_id["entry.ts:run"], 3);
    assert_eq!(
        edges.import_edges_by_file["entry.ts"][0].target.as_deref(),
        Some("origin.ts")
    );
}

#[test]
fn preserves_a_valid_external_callee_with_a_lone_surrogate_name() {
    let project = Project::new();
    project.write("tsconfig.json", r#"{"compilerOptions":{"types":[]}}"#);
    project.write("entry.ts", "declare const effect: Record<string, () => void>;\nexport function run() { effect['\\ud800'](); }\n");
    let loaded = load_cheap_project(&project.0, None).unwrap();
    let functions = discover_functions(&loaded.source_files).functions;
    let ids: Vec<_> = functions
        .iter()
        .map(|function| function.id.clone())
        .collect();
    let imports = resolve_imports(
        &project.0,
        &loaded.source_files,
        &project.0.join("tsconfig.json"),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let edges = with_type_context(
        &project.binary(),
        TypeContextInput {
            project: &loaded,
            ts_config_path: &project.0.join("tsconfig.json"),
            functions: &functions,
        },
        |context| resolve_edges(context, imports, &ids),
    )
    .unwrap();
    let calls = &edges.calls_by_id["entry.ts:run"];
    assert_eq!(calls.len(), 1);
    let mut expected: Vec<u16> = "external:".encode_utf16().collect();
    expected.push(0xd800);
    assert_eq!(calls[0].callee_id.units(), expected);
    assert!(calls[0].declaration.is_none());
    assert!(
        serde_json::to_string(&edges)
            .unwrap()
            .contains(r#""calleeId":"external:\ud800""#)
    );
    assert_eq!(edges.chain_depth_by_id["entry.ts:run"], 0);
}

#[test]
fn measures_alias_type_uses_shorthand_values_callbacks_and_module_roots() {
    let project = Project::new();
    project.write(
        "tsconfig.json",
        r#"{"compilerOptions":{"strict":true,"types":[]}}"#,
    );
    project.write("types.ts", "export interface Shape { value: number }\nexport const TOKEN = 'fixed';\nexport class Box { method() { return 1; } }\nexport function target() { return 1; }\n");
    project.write("entry.ts", "import { Shape as Alias, TOKEN, Box, target } from './types';\nconst holder = { TOKEN };\nexport function run(value: Alias) { target(); consume(target); return TOKEN; }\ntarget;\nconst lazy = import('./types');\nfunction consume(callback: () => number) { return callback(); }\n");
    project.write(
        "entry.test.ts",
        "import { target } from './types';\ntarget;\n",
    );
    let loaded = load_cheap_project(&project.0, None).unwrap();
    let functions = discover_functions(&loaded.source_files).functions;
    let declarations = discover_declarations(
        &loaded.source_files,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let names: IndexSet<_> = functions
        .iter()
        .map(|function| function.name.clone())
        .collect();
    let mut exported: IndexMap<String, Vec<String>> = IndexMap::new();
    for function in &functions {
        if function.is_exported {
            exported
                .entry(function.file.clone())
                .or_default()
                .push(function.id.clone());
        }
    }
    let (uses, references) = with_type_context(
        &project.binary(),
        TypeContextInput {
            project: &loaded,
            ts_config_path: &project.0.join("tsconfig.json"),
            functions: &functions,
        },
        |context| {
            Ok((
                resolve_declaration_uses(
                    context,
                    &declarations,
                    &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
                )
                .unwrap(),
                resolve_references(context, &names, &exported)?,
            ))
        },
    )
    .unwrap();
    assert!(uses.unjoined.is_empty());
    assert_eq!(
        uses.uses_by_id["types.ts:interface:Shape"]
            .iter()
            .map(|site| (site.file.as_str(), site.line))
            .collect::<Vec<_>>(),
        [("entry.ts", 1), ("entry.ts", 3)]
    );
    assert_eq!(
        uses.uses_by_id["types.ts:constant:TOKEN"]
            .iter()
            .map(|site| site.line)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert!(uses.uses_by_id["entry.ts:constant:holder"].is_empty());
    assert_eq!(
        references.references_by_id["entry.ts:run"],
        ["types.ts:target"]
    );
    assert_eq!(
        references.module_scope_roots,
        ["types.ts:method", "types.ts:target"]
    );
    assert_eq!(references.test_module_scope_roots, ["types.ts:target"]);
    assert_eq!(
        references.identifier_files["target"],
        ["entry.test.ts", "entry.ts", "types.ts"]
    );
}
