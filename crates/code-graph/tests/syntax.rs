use std::fs;
use std::path::Path;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use demlik_code_graph::engine::oxc::{ParseFailure, parse_type_script};
use demlik_code_graph::extract::functions::{FunctionKind, discover_functions};
use demlik_code_graph::extract::metrics::{
    compute_function_metrics, module_comment_lines, module_loc,
};
use demlik_code_graph::project::SourceUnit;
use demlik_code_graph::project::{EdgeScope, list_repo, load_cheap_project, load_edge_project};
use demlik_code_graph::syntax::bindings::pattern_names;
use demlik_code_graph::syntax::headers::function_header;
use demlik_code_graph::syntax::imports::{
    ImportKind, import_declaration_specifiers, import_literals, imported_names_of, resolve_imports,
    runtime_specifiers,
};

#[test]
fn parses_tsx_modules_with_utf16_spans_comments_and_observable_syntax_errors() {
    let syntax = parse_type_script(
        Path::new("view.tsx"),
        "// 😀\r\nexport const view = () => (<div />);\r\n",
    )
    .unwrap();
    let exported = syntax.root().children()[0];
    assert_eq!(exported.kind(), "ExportNamedDeclaration");
    assert_eq!(exported.start(), 7);
    assert_eq!(exported.start_line(), 2);
    assert_eq!(exported.start_column(), 1);
    assert_eq!(syntax.line_count(), 3);
    assert_eq!(syntax.comments()[0].start, 0);
    assert_eq!(syntax.comments()[0].end, 5);
    assert_eq!(syntax.comments()[0].value, " 😀");
    let declaration = exported.node("declaration").unwrap();
    assert_eq!(declaration.kind(), "VariableDeclaration");
    assert_eq!(declaration.ts_start(), 7);
    let value = declaration.nodes("declarations")[0].node("init").unwrap();
    assert_eq!(value.kind(), "ArrowFunctionExpression");
    assert_eq!(
        value.node("body").unwrap().kind(),
        "ParenthesizedExpression"
    );
    assert!(matches!(
        parse_type_script(Path::new("broken.ts"), "export function broken( {"),
        Err(ParseFailure::Syntax(_))
    ));
}

#[test]
fn loads_real_projects_removing_bom_and_retaining_parse_failures() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "demlik-syntax-project-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    fs::write(
        root.join("good.ts"),
        "\u{feff}export function good() { return 1; }\n",
    )
    .unwrap();
    fs::write(root.join("bad.ts"), "export function broken( {\n").unwrap();
    fs::write(
        root.join("ignored.d.ts"),
        "declare function skipped(): void;\n",
    )
    .unwrap();
    let listing = list_repo(&root);
    let loaded = load_cheap_project(&root, Some(&listing)).unwrap();
    assert_eq!(loaded.parse_failures, ["bad.ts"]);
    assert_eq!(loaded.source_files.len(), 1);
    assert_eq!(loaded.source_files[0].file, "good.ts");
    assert!(loaded.source_files[0].syntax.text().starts_with("export"));
    let edged = load_edge_project(&root, EdgeScope::Package, &root, Some(&listing)).unwrap();
    assert_eq!(edged.ts_config_path, root.join("tsconfig.json"));
    assert_eq!(edged.project.parse_failures, ["bad.ts"]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn discovers_named_callables_preserving_ordinals_kinds_and_export_status() {
    let text = concat!(
        "export function overloaded(x: string): string;\n",
        "export function overloaded(x: string) { return x; }\n",
        "const outer = () => { const nested = () => 1; return [1].map(x => x); };\n",
        "class Box { get value() { return 1; } set value(x: number) {} }\n",
        "interface I { get signature(): number; }\n",
        "const object = { method() {}, 'quoted'() {}, [Symbol.iterator]() {} };\n",
        "export default (value: number) => value;\n",
    );
    let unit = Rc::new(SourceUnit {
        absolute_path: "/fixture.test.ts".into(),
        file: "fixture.test.ts".into(),
        syntax: parse_type_script(Path::new("fixture.test.ts"), text).unwrap(),
    });
    let found = discover_functions(&[unit]);
    let names: Vec<_> = found
        .functions
        .iter()
        .map(|function| function.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "overloaded",
            "nested",
            "outer",
            "value",
            "value",
            "signature",
            "'quoted'",
            "[Symbol.iterator]",
            "method",
            "default"
        ]
    );
    assert_eq!(found.functions[0].kind, FunctionKind::Function);
    assert!(found.functions[0].is_exported);
    assert_eq!(found.functions[0].start_line, 2);
    assert_eq!(found.functions[3].id, "fixture.test.ts:value#0");
    assert_eq!(found.functions[3].kind, FunctionKind::Getter);
    assert_eq!(found.functions[4].kind, FunctionKind::Setter);
    assert!(found.functions.iter().all(|function| function.is_test));
    assert!(found.functions.last().unwrap().is_exported);
}

#[test]
fn computes_body_metrics_without_charging_named_nested_functions_to_the_parent() {
    let text = concat!(
        "/** Public entry. */\n",
        "export function parent(xs: number[]) {\n",
        "  function child(x: number) { if (x) { if (x > 1) { return x; } } return 0; }\n",
        "  // Keep anonymous callback work here.\n",
        "  return xs.map(x => { if (x) { return x && 1; } return 0; });\n",
        "}\n",
    );
    let unit = Rc::new(SourceUnit {
        absolute_path: "/metrics.ts".into(),
        file: "metrics.ts".into(),
        syntax: parse_type_script(Path::new("metrics.ts"), text).unwrap(),
    });
    let discovered = discover_functions(std::slice::from_ref(&unit));
    let parent = discovered
        .functions
        .iter()
        .find(|function| function.name == "parent")
        .unwrap();
    let child = discovered
        .functions
        .iter()
        .find(|function| function.name == "child")
        .unwrap();
    let parent_metrics = compute_function_metrics(parent);
    assert_eq!(parent_metrics.loc, 5);
    assert_eq!(parent_metrics.comment_lines, 2);
    assert_eq!(parent_metrics.complexity, 3);
    assert_eq!(parent_metrics.nesting_depth, 2);
    let child_metrics = compute_function_metrics(child);
    assert_eq!(child_metrics.loc, 1);
    assert_eq!(child_metrics.complexity, 3);
    assert_eq!(child_metrics.nesting_depth, 2);
    assert_eq!(module_comment_lines(&unit.syntax), 2);
    assert_eq!(module_loc(&unit.syntax), 7);
}

#[test]
fn keeps_verbatim_headers_and_only_contiguous_matching_overloads() {
    let text = concat!(
        "// First signature.\n",
        "export function pick(a: string): string;\n",
        "/** Second signature. */\n",
        "export function pick(a: number): number;\n",
        "// Implementation.\n",
        "export function pick(a: string | number): string | number /* note */ { return a; }\n",
        "const make = (value: number) => /* body */ ({ value });\n",
        "class C { static run(value: string): string; static run(value: string) { return value; } }\n",
    );
    let unit = Rc::new(SourceUnit {
        absolute_path: "/headers.ts".into(),
        file: "headers.ts".into(),
        syntax: parse_type_script(Path::new("headers.ts"), text).unwrap(),
    });
    let discovered = discover_functions(&[unit]);
    let pick = discovered
        .functions
        .iter()
        .find(|function| function.name == "pick")
        .unwrap();
    let header = function_header(pick.node());
    assert_eq!(
        header.text,
        "export function pick(a: string | number): string | number"
    );
    assert_eq!(
        header
            .overloads
            .iter()
            .map(|signature| (signature.start_line, signature.text.as_str()))
            .collect::<Vec<_>>(),
        [
            (2, "export function pick(a: string): string"),
            (4, "export function pick(a: number): number")
        ]
    );
    let make = discovered
        .functions
        .iter()
        .find(|function| function.name == "make")
        .unwrap();
    assert_eq!(function_header(make.node()).text, "(value: number) =>");
    let method = discovered
        .functions
        .iter()
        .find(|function| function.name == "run")
        .unwrap();
    let method_header = function_header(method.node());
    assert_eq!(method_header.text, "static run(value: string)");
    assert_eq!(
        method_header.overloads[0].text,
        "static run(value: string): string"
    );
}

#[test]
fn reads_real_parameter_properties_and_nested_binding_patterns() {
    let syntax = parse_type_script(Path::new("bindings.ts"), "class Service { constructor(private readonly db: DB, { left: renamed, flag = 1, ...rest }: Options, [head, , ...tail]: unknown[]) {} }").unwrap();
    let constructor = syntax
        .root()
        .ts_descendants()
        .into_iter()
        .find(|node| node.kind() == "MethodDefinition")
        .unwrap();
    let names: Vec<_> = constructor
        .node("value")
        .unwrap()
        .nodes("params")
        .into_iter()
        .flat_map(|parameter| pattern_names(Some(parameter)))
        .collect();
    assert_eq!(names, ["db", "renamed", "flag", "rest", "head", "tail"]);
}

#[test]
fn preserves_lone_surrogates_in_literal_values_without_rejecting_valid_typescript() {
    let syntax = parse_type_script(Path::new("strings.ts"), r"const high = '\ud800'; const low = '\udc00'; const cooked = `\ud800\uFFFD`; export function alive() {}").unwrap();
    let literals: Vec<_> = syntax
        .root()
        .ts_descendants()
        .into_iter()
        .filter(|node| node.kind() == "Literal")
        .collect();
    assert_eq!(
        literals[0].string_units("value").unwrap().as_ref(),
        [0xd800]
    );
    assert_eq!(
        literals[1].string_units("value").unwrap().as_ref(),
        [0xdc00]
    );
    assert!(literals[0].string("value").is_none());
    let template = syntax
        .root()
        .ts_descendants()
        .into_iter()
        .find(|node| node.kind() == "TemplateElement")
        .unwrap();
    assert_eq!(
        template
            .string_units_path(&["value", "cooked"])
            .unwrap()
            .as_ref(),
        [0xd800, 0xfffd]
    );
    assert!(
        syntax
            .root()
            .ts_descendants()
            .iter()
            .any(|node| node.kind() == "FunctionDeclaration")
    );
}

#[test]
fn parses_nested_expressions_beyond_serde_jsons_default_container_limit() {
    let source = format!(
        "export const nested = {}1{};",
        "(".repeat(160),
        ")".repeat(160)
    );
    let syntax = parse_type_script(Path::new("nested.ts"), &source).unwrap();
    assert_eq!(
        syntax
            .root()
            .ts_descendants()
            .iter()
            .filter(|node| node.kind() == "ParenthesizedExpression")
            .count(),
        160
    );
}

#[test]
fn classifies_import_reach_names_ambient_modules_and_dynamic_literals() {
    let source = concat!(
        "import { type A, type B as C } from 'types';\n",
        "import value, { named as local } from 'mixed';\n",
        "import type Old = require('old');\n",
        "export { type A } from 'types';\n",
        "declare module 'ambient' { import './relative'; import { Remote } from 'remote'; }\n",
        "const lazy = () => import(`dynamic`); type Imported = import('shape').Value;\n",
        "import ''; import '\\ud800';\n",
    );
    let syntax = parse_type_script(Path::new("imports.ts"), source).unwrap();
    let literals = import_literals(&syntax);
    assert_eq!(literals.len(), 8);
    assert_eq!(
        (literals[0].kind, literals[0].type_only, literals[0].runtime),
        (ImportKind::Static, false, false)
    );
    assert!(!literals[2].type_only);
    assert!(!literals[2].runtime);
    assert_eq!(literals[4].specifier, "remote");
    assert!(!literals[4].runtime);
    assert_eq!(literals[5].specifier.units(), [0xd800]);
    assert_eq!(literals[6].kind, ImportKind::Dynamic);
    assert!(!literals[7].runtime);
    let taken = imported_names_of(&syntax);
    let types = demlik_code_graph::text::JsString::from("types");
    assert_eq!(
        taken
            .get(&types)
            .unwrap()
            .names
            .iter()
            .map(|name| name.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["A", "B"]
    );
    assert!(!taken.get(&types).unwrap().unreadable);
    let opened: Vec<_> = runtime_specifiers(&syntax)
        .iter()
        .map(|name| name.to_lossy())
        .collect();
    assert_eq!(opened, ["mixed", "\u{fffd}", "dynamic"]);
    assert!(
        import_declaration_specifiers(
            &syntax,
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
        )
        .unwrap()
        .iter()
        .any(|name| name.units().is_empty())
    );
    assert!(
        serde_json::to_string(&literals)
            .unwrap()
            .contains(r#""specifier":"\ud800""#)
    );
}

#[test]
fn resolves_import_targets_only_for_loaded_external_modules() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("demlik-imports-{}-{unique}", std::process::id()));
    fs::create_dir(&root).unwrap();
    fs::write(
        root.join("tsconfig.json"),
        r#"{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["*"]}}}"#,
    )
    .unwrap();
    fs::write(root.join("entry.ts"), "import { value } from '@app/value.js'; import './script'; import './meta'; export { value } from './value'; const later = import('./value');").unwrap();
    fs::write(root.join("value.ts"), "export const value = 1;").unwrap();
    fs::write(root.join("script.ts"), "const globalValue = 2;").unwrap();
    fs::write(root.join("meta.ts"), "const url = import.meta.url;").unwrap();
    let loaded = load_cheap_project(&root, None).unwrap();
    let graph = resolve_imports(
        &root,
        &loaded.source_files,
        &root.join("tsconfig.json"),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let edges = &graph.import_edges_by_file["entry.ts"];
    assert_eq!(edges.len(), 5);
    assert_eq!(
        edges
            .iter()
            .find(|edge| edge.specifier == "./script")
            .unwrap()
            .target,
        None
    );
    assert_eq!(
        edges
            .iter()
            .find(|edge| edge.specifier == "./meta")
            .unwrap()
            .target
            .as_deref(),
        Some("meta.ts")
    );
    assert_eq!(
        edges
            .iter()
            .find(|edge| edge.specifier == "@app/value.js")
            .unwrap()
            .target
            .as_deref(),
        Some("value.ts")
    );
    assert_eq!(graph.imported_by_file["value.ts"], ["entry.ts"]);
    fs::remove_dir_all(root).unwrap();
}
