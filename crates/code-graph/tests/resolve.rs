use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use demlik_code_graph::engine::tsgo::{TsgoBinary, TsgoError};
use demlik_code_graph::resolve::{
    ExportDeclaration, ExportOrigin, InProcessGraphOptions, SubpathEntries, load_in_process_graph,
};
use serde_json::json;

static ORDINAL: AtomicU64 = AtomicU64::new(0);

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "demlik-native-resolve-{}-{}",
            std::process::id(),
            ORDINAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        Self(fs::canonicalize(directory).unwrap())
    }

    fn write(&self, file: &str, content: &str) {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn options(&self) -> InProcessGraphOptions {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
        InProcessGraphOptions::new(TsgoBinary::from_native_preview_manifest(&manifest).unwrap())
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn resolves_a_renamed_barrel_export_to_the_compilers_original_declaration() {
    let project = Project::new();
    project.write(
        "tsconfig.json",
        r#"{ "compilerOptions": { "strict": true }, "include": ["*.ts"] }"#,
    );
    project.write("origin.ts", "/** original declaration */\nexport function realName(): number { return 1; }\nexport default () => 2;\n");
    project.write(
        "barrel.ts",
        "export { realName as renamed } from './origin';\nexport { default } from './origin';\n",
    );
    project.write(
        "consumer.ts",
        "import { renamed } from './barrel';\nexport const value = renamed();\n",
    );
    let mut graph = load_in_process_graph(&project.0, project.options())
        .unwrap()
        .unwrap();
    assert_eq!(
        graph
            .resolve_export_origin(&project.0.join("consumer.ts"), "./barrel", "renamed")
            .unwrap(),
        Some(ExportOrigin {
            file: project.0.join("origin.ts"),
            name: "realName".into()
        })
    );
    assert_eq!(
        graph
            .resolve_module_export(&project.0.join("barrel.ts"), "renamed")
            .unwrap(),
        Some(ExportDeclaration {
            file: project.0.join("origin.ts"),
            name: "realName".into(),
            line: 2
        })
    );
    assert_eq!(
        graph
            .resolve_export_origin(&project.0.join("barrel.ts"), "./origin", "realName")
            .unwrap(),
        None
    );
}

#[test]
fn preserves_first_overloads_merged_declarations_default_names_and_unicode_lines() {
    let project = Project::new();
    project.write(
        "tsconfig.json",
        r#"{ "compilerOptions": { "strict": true }, "files": ["definitions.ts", "consumer.ts"] }"#,
    );
    project.write(
        "definitions.ts",
        concat!(
            "// 😀 Ω before the declaration\r\n",
            "/** API documentation\r\n * for both overloads\r\n */\r\n",
            "export function run(value: string): string;\r\n",
            "export function run(value: number): number;\r\n",
            "export function run(value: string | number): string | number { return value; }\r\n",
            "export interface Merged { value: number }\r\n",
            "export namespace Merged { export const marker = 1; }\r\n",
            "export const { external: bound } = { external: 1 };\r\n",
            "export const __internal = 1;\r\n",
            "export default class Named {}\r\n",
        ),
    );
    project.write(
        "consumer.ts",
        "import { run } from './definitions';\nexport const called = run('x');\n",
    );
    project.write(
        "anonymous.ts",
        "\u{feff}/** description */\nexport default () => 2;\n",
    );
    let mut graph = load_in_process_graph(&project.0, project.options())
        .unwrap()
        .unwrap();
    for (export, name, line) in [
        ("run", "run", 5),
        ("Merged", "Merged", 8),
        ("bound", "bound", 10),
        ("__internal", "__internal", 11),
        ("default", "Named", 12),
    ] {
        assert_eq!(
            graph
                .resolve_module_export(&project.0.join("definitions.ts"), export)
                .unwrap(),
            Some(ExportDeclaration {
                file: project.0.join("definitions.ts"),
                name: name.into(),
                line
            }),
            "{export}"
        );
    }
    assert_eq!(
        graph
            .resolve_module_export(&project.0.join("anonymous.ts"), "default")
            .unwrap(),
        Some(ExportDeclaration {
            file: project.0.join("anonymous.ts"),
            name: "default".into(),
            line: 2
        })
    );
    assert_eq!(
        graph
            .resolve_export_origin(&project.0.join("consumer.ts"), "./definitions", "default")
            .unwrap(),
        Some(ExportOrigin {
            file: project.0.join("definitions.ts"),
            name: "Named".into()
        })
    );
}

#[test]
fn publishing_subpaths_preserve_missing_entries_and_javascript_record_order() {
    let project = Project::new();
    project.write("tsconfig.json", "{}");
    project.write("entry.ts", "export const published = 1;\n");
    project.write("empty.ts", "export const unrelated = 2;\n");
    let entry = project.0.join("entry.ts");
    let missing = project.0.join("absent.ts");
    let mut entries = SubpathEntries::new();
    for (subpath, file) in [
        ("2", &entry),
        ("1", &entry),
        ("./unpublished", &project.0.join("empty.ts")),
        ("./missing", &missing),
        (".", &entry),
    ] {
        entries.insert(subpath.into(), file.to_str().unwrap().into());
    }
    let mut graph = load_in_process_graph(&project.0, project.options())
        .unwrap()
        .unwrap();
    let answers = graph
        .resolve_publishing_subpaths(&entries, "published")
        .unwrap();
    assert_eq!(
        serde_json::to_value(answers).unwrap(),
        json!([
            { "subpath": "1", "entry": entry, "declaration": { "file": entry, "name": "published", "line": 1 } },
            { "subpath": "2", "entry": entry, "declaration": { "file": entry, "name": "published", "line": 1 } },
            { "subpath": "./missing", "given": missing, "entry": missing, "unresolvable": "missing-entry-file" },
            { "subpath": ".", "entry": entry, "declaration": { "file": entry, "name": "published", "line": 1 } }
        ])
    );
}

#[test]
fn starts_lazily_and_preserves_disposal_and_binary_failures_as_data() {
    let project = Project::new();
    let invalid = TsgoBinary::pinned(project.0.join("missing-compiler"));
    assert!(
        load_in_process_graph(&project.0, InProcessGraphOptions::new(invalid.clone()))
            .unwrap()
            .is_none()
    );
    project.write("tsconfig.json", "{}");
    project.write("entry.ts", "export const published = 1;\n");
    let mut unopened =
        load_in_process_graph(&project.0, InProcessGraphOptions::new(invalid.clone()))
            .unwrap()
            .unwrap();
    assert_eq!(
        unopened
            .resolve_module_export(&project.0.join("missing.ts"), "published")
            .unwrap(),
        None
    );
    unopened.dispose();
    unopened.dispose();
    assert!(matches!(
        unopened.resolve_module_export(&project.0.join("entry.ts"), "published"),
        Err(TsgoError::Disposed)
    ));
    assert_eq!(
        unopened
            .resolve_module_export(&project.0.join("missing.ts"), "published")
            .unwrap(),
        None
    );
    let mut needs_compiler = load_in_process_graph(&project.0, InProcessGraphOptions::new(invalid))
        .unwrap()
        .unwrap();
    assert!(matches!(
        needs_compiler.resolve_module_export(&project.0.join("entry.ts"), "published"),
        Err(TsgoError::Io(_))
    ));
    let wrong_binary = TsgoBinary::pinned(std::env::current_exe().unwrap());
    let mut wrong_version =
        load_in_process_graph(&project.0, InProcessGraphOptions::new(wrong_binary))
            .unwrap()
            .unwrap();
    assert!(matches!(
        wrong_version.resolve_module_export(&project.0.join("entry.ts"), "published"),
        Err(TsgoError::VersionMismatch { .. })
    ));
}

#[test]
fn gives_each_lookup_its_own_program_without_leaking_module_augmentations() {
    let project = Project::new();
    project.write(
        "tsconfig.json",
        r#"{ "compilerOptions": { "strict": true }, "include": ["*.ts"] }"#,
    );
    project.write("origin.ts", "export const original = 1;\n");
    project.write("augmentation.ts", "import './origin';\ndeclare module './origin' { export const injected: number; }\nexport const marker = 1;\n");
    project.write(
        "consumer.ts",
        "import { original } from './origin';\nexport const observed = original;\n",
    );
    project.write("global.ts", "declare const globalOnly: number;\n");
    let mut graph = load_in_process_graph(&project.0, project.options())
        .unwrap()
        .unwrap();
    let augmented = Some(ExportOrigin {
        file: project.0.join("augmentation.ts"),
        name: "injected".into(),
    });
    assert_eq!(
        graph
            .resolve_export_origin(&project.0.join("augmentation.ts"), "./origin", "injected")
            .unwrap(),
        augmented
    );
    assert_eq!(
        graph
            .resolve_export_origin(&project.0.join("consumer.ts"), "./origin", "injected")
            .unwrap(),
        None
    );
    assert_eq!(
        graph
            .resolve_export_origin(&project.0.join("augmentation.ts"), "./origin", "injected")
            .unwrap(),
        augmented
    );
    assert_eq!(
        graph
            .resolve_module_export(&project.0.join("global.ts"), "globalOnly")
            .unwrap(),
        None
    );
    graph.dispose();
    assert!(matches!(
        graph.resolve_module_export(&project.0.join("origin.ts"), "original"),
        Err(TsgoError::Disposed)
    ));
}

#[test]
fn resolves_a_valid_import_after_an_unpaired_surrogate_specifier() {
    let project = Project::new();
    project.write("tsconfig.json", "{}");
    project.write("origin.ts", "export const value = 1;\n");
    project.write("consumer.ts", "import unused from '\\ud800';\nimport { value } from './origin';\nexport const result = value;\n");
    let mut graph = load_in_process_graph(&project.0, project.options())
        .unwrap()
        .unwrap();
    assert_eq!(
        graph
            .resolve_export_origin(&project.0.join("consumer.ts"), "./origin", "value")
            .unwrap(),
        Some(ExportOrigin {
            file: project.0.join("origin.ts"),
            name: "value".into()
        })
    );
}
