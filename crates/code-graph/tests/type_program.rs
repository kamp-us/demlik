use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use demlik_code_graph::checker::context::{TypeContextInput, with_type_context};
use demlik_code_graph::engine::tsgo::{
    LibraryKind, ProgramInput, TsgoBinary, TsgoError, open_type_session,
};
use demlik_code_graph::extract::functions::discover_functions;
use demlik_code_graph::project::load_cheap_project;

static ORDINAL: AtomicU64 = AtomicU64::new(0);
struct Project(PathBuf);
impl Project {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "demlik-native-program-{}-{}",
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

#[test]
fn joins_oxc_callables_to_native_compiler_nodes_and_resolves_their_symbols() {
    let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
    let project = Project::new();
    project.write("tsconfig.json", r#"{"compilerOptions":{"types":[]}}"#);
    project.write("entry.ts", "// 😀\nexport function run() { return 1; }\nconst arrow = () => 2;\nclass Box { get value() { return 1; } method() {} }\ninterface I { get size(): number; }\n");
    project.write("bom.ts", "\u{feff}export function bom() { return 1; }\n");
    let loaded = load_cheap_project(&project.0, None, &project_collation).unwrap();
    let functions = discover_functions(&loaded.source_files, &project_collation)
        .unwrap()
        .functions;
    with_type_context(
        &project.binary(),
        TypeContextInput {
            project: &loaded,
            ts_config_path: &project.0.join("tsconfig.json"),
            functions: &functions,
        },
        |context| {
            assert!(context.unjoined.is_empty());
            assert_eq!(
                context
                    .node_to_id
                    .values()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                [
                    "bom.ts:bom",
                    "entry.ts:run",
                    "entry.ts:arrow",
                    "entry.ts:value",
                    "entry.ts:method",
                    "entry.ts:size"
                ]
            );
            let run = context
                .node_to_id
                .iter()
                .find(|(_, id)| *id == "entry.ts:run")
                .unwrap()
                .0
                .clone();
            assert_eq!(context.text(&run)?, "export function run() { return 1; }");
            assert_eq!(context.start_line(&run)?, 2);
            assert_eq!(context.relative_path(&run.source_file()), "entry.ts");
            assert_eq!(
                context.unit_of(&run.source_file()).unwrap().file,
                "entry.ts"
            );
            let symbol = context.symbol_of(&run)?.unwrap();
            assert_eq!(symbol.name(), "run");
            assert_eq!(context.declarations_of(&symbol)?.len(), 1);
            assert!(context.aliased_symbol(&symbol)?.is_none());
            Ok(())
        },
    )
    .unwrap();
}
impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn queries_native_ast_symbols_and_aliases_in_the_requested_compilation_scope() {
    let project = Project::new();
    project.write("tsconfig.json", r#"{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext","moduleResolution":"bundler","types":[],"lib":["es2022"]},"include":["src/**/*.ts"]}"#);
    project.write(
        "src/origin.ts",
        "// 😀\nexport function run(value: number) { return value; }\n",
    );
    project.write("src/entry.ts", "import { run as renamed } from './origin';\nexport function entry() { const holder = { renamed }; return renamed(1); }\n");
    project.write(
        "src/unused.ts",
        "export interface Unused { value: number }\n",
    );
    project.write("extra.ts", "export const extra = 1;\n");
    let mut session =
        open_type_session(&project.binary(), &project.0.join("tsconfig.json")).unwrap();
    let roots = [project.0.join("extra.ts")];
    let escaped = session
        .with_compilation(
            ProgramInput {
                root_files: &roots,
                include_config_files: true,
            },
            |program| {
                assert!(
                    program
                        .source_file(&project.0.join("src/unused.ts"))?
                        .is_some()
                );
                assert!(program.source_file(&roots[0])?.is_some());
                let entry = program
                    .source_file(&project.0.join("src/entry.ts"))?
                    .unwrap();
                let module = program.symbol_at(&entry.root())?.unwrap();
                assert!(program.exports_of(&module)?.contains_key("entry"));
                let shorthand = entry
                    .root()
                    .descendants()?
                    .into_iter()
                    .find(|node| node.is_kind("ShorthandPropertyAssignment"))
                    .unwrap();
                let value_symbol = program.shorthand_value_symbol(&shorthand)?.unwrap();
                assert_eq!(program.alias_target(&value_symbol)?.unwrap().name(), "run");
                let calls: Vec<_> = entry
                    .root()
                    .descendants()?
                    .into_iter()
                    .filter(|node| node.is_kind("CallExpression"))
                    .collect();
                assert_eq!(calls.len(), 1);
                let expression = calls[0].node("expression")?.unwrap();
                assert_eq!(expression.text()?, "renamed");
                assert!(expression.parent()?.unwrap().is_kind("CallExpression"));
                let symbols = program.symbols_at(std::slice::from_ref(&expression))?;
                let symbol = symbols[0].as_ref().unwrap();
                assert_eq!(symbol.name(), "renamed");
                let target = program.alias_target(symbol)?.unwrap();
                assert_eq!(target.name(), "run");
                assert!(program.alias_target(&target)?.is_none());
                let declarations = program.declarations(&target)?;
                assert_eq!(declarations.len(), 1);
                let declaration = &declarations[0];
                assert!(declaration.is_kind("FunctionDeclaration"));
                assert_eq!(declaration.start()?, 6);
                assert_eq!(declaration.start_line()?, 2);
                assert_eq!(declaration.file_name(), project.0.join("src/origin.ts"));
                assert_eq!(
                    declaration
                        .node("name")?
                        .unwrap()
                        .literal_text()?
                        .unwrap()
                        .to_utf8()
                        .unwrap(),
                    "run"
                );
                assert_eq!(declaration.nodes("parameters")?.len(), 1);
                assert!(!declaration.source_file().is_declaration_file());
                assert!(
                    entry
                        .root()
                        .descendants()?
                        .iter()
                        .all(|node| !node.is_kind("JSDoc"))
                );
                let source_names = program.source_file_names()?;
                let root_lib = source_names
                    .iter()
                    .find(|file| file.ends_with("lib.es2022.d.ts"))
                    .unwrap();
                let file = program.source_file(root_lib)?.unwrap();
                assert!(file.is_declaration_file());
                assert_eq!(program.library_kind(&file)?, Some(LibraryKind::Root));
                let referenced_lib = source_names
                    .iter()
                    .find(|file| file.ends_with("lib.es5.d.ts"))
                    .unwrap();
                let file = program.source_file(referenced_lib)?.unwrap();
                assert_eq!(program.library_kind(&file)?, Some(LibraryKind::Referenced));
                assert_eq!(program.library_kind(&entry)?, None);
                Ok(expression)
            },
        )
        .unwrap();
    session
        .with_compilation(
            ProgramInput {
                root_files: &roots,
                include_config_files: false,
            },
            |program| {
                assert!(
                    program
                        .source_file(&project.0.join("src/unused.ts"))?
                        .is_none()
                );
                assert!(matches!(
                    program.symbol_at(&escaped),
                    Err(TsgoError::Protocol(_))
                ));
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(escaped.text().unwrap(), "renamed");
    assert!(fs::read_dir(&project.0).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".code-graph-")
    }));
}
