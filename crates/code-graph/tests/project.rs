use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use demlik_code_graph::engine::oxc::{
    FileResolution, ResolveError, create_module_resolver, create_nearest_tsconfig_resolver,
};
use demlik_code_graph::project::{
    EdgeScope, discover_package_roots, find_nearest_tsconfig, find_repo_root, list_repo,
    list_source_files, list_visible_files, resolve_edge_ts_config, to_relative,
};

static ORDINAL: AtomicU64 = AtomicU64::new(0);

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "demlik-native-project-{}-{}",
            std::process::id(),
            ORDINAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    fn write(&self, file: &str, content: &str) {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn git(&self, arguments: &[&str]) {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(&self.0)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn relative(&self, files: &[PathBuf]) -> Vec<String> {
        files
            .iter()
            .map(|file| {
                file.strip_prefix(&self.0)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .replace('\\', "/")
            })
            .collect()
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn discovers_visible_typescript_sources_in_a_real_git_project() {
    let project = Project::new();
    project.git(&["init", "-q"]);
    for file in [
        "src/main.ts",
        "src/view.tsx",
        "packages/lib/src/lib.ts",
        "src/types.d.ts",
        "src/schema.gen.ts",
        "src/main.mts",
        "src/readme.md",
        ".config/tool.ts",
        "src/.hidden.ts",
        "node_modules/dep/a.ts",
        "dist/main.ts",
        "vendor/copied.ts",
        "src/__generated__/query.ts",
        "ignored/leak.ts",
    ] {
        project.write(file, "export {};\n");
    }
    project.write(".gitignore", "ignored/\n");
    project.git(&["add", "src/main.ts"]);
    assert_eq!(
        project.relative(&list_source_files(&project.0)),
        ["packages/lib/src/lib.ts", "src/main.ts", "src/view.tsx"]
    );
    assert!(list_source_files(&project.0.join("missing")).is_empty());
}

#[test]
fn reuses_one_repo_listing_for_a_package_and_filters_deleted_files() {
    let project = Project::new();
    for file in [
        "package.json",
        "packages/app/package.json",
        "packages/app/src/a.ts",
        "packages/lib/package.json",
        "node_modules/dep/package.json",
        "coverage/hidden.ts",
    ] {
        project.write(file, "{}");
    }
    let listing = list_repo(&project.0);
    fs::remove_file(project.0.join("packages/app/src/a.ts")).unwrap();
    project.write("packages/app/src/later.ts", "export {};");
    assert_eq!(
        list_visible_files(&project.0.join("packages/app"), |_| true, Some(&listing)),
        ["package.json"]
    );
    assert_eq!(
        discover_package_roots(&project.0, Some(&listing)),
        ["", "packages/app", "packages/lib"]
    );
    assert_eq!(
        discover_package_roots(&project.0.join("packages/app"), Some(&listing)),
        [""]
    );
    assert!(
        !listing
            .files
            .iter()
            .any(|file| file.starts_with("coverage/"))
    );
    assert_eq!(
        to_relative(
            &project.0.join("packages/app/./src/.."),
            &project.0.join("packages/lib/missing/../entry.ts")
        ),
        "../lib/entry.ts"
    );
}

#[test]
fn orders_visible_names_like_the_reference_locale_compare() {
    let project = Project::new();
    for file in ["z.ts", "B.ts", "a.ts", "é.ts", "e.ts", "_a.ts", "-a.ts"] {
        project.write(file, "export {};");
    }
    assert_eq!(
        list_visible_files(&project.0, |_| true, None),
        ["_a.ts", "-a.ts", "a.ts", "B.ts", "e.ts", "é.ts", "z.ts"]
    );
}

#[cfg(unix)]
#[test]
fn lists_the_supplied_directory_but_normalizes_joined_file_paths_before_stat() {
    let project = Project::new();
    project.write("holder/shared.ts", "export const lexical = true;");
    project.write("holder/lexical-only.ts", "export {};");
    project.write("outside/shared.ts", "export const physical = true;");
    project.write("outside/physical-only.ts", "export {};");
    fs::create_dir_all(project.0.join("outside/nested")).unwrap();
    std::os::unix::fs::symlink(
        project.0.join("outside/nested"),
        project.0.join("holder/link"),
    )
    .unwrap();
    let supplied = project.0.join("holder/link/..");
    assert_eq!(list_visible_files(&supplied, |_| true, None), ["shared.ts"]);
    assert_eq!(
        list_source_files(&supplied),
        [project.0.join("holder/shared.ts")]
    );
}

#[test]
fn selects_the_package_or_workspace_tsconfig_and_reports_missing_configuration() {
    let project = Project::new();
    project.write("pnpm-workspace.yaml", "packages: ['packages/*']\n");
    project.write("tsconfig.json", "{}");
    project.write("packages/app/tsconfig.json", "{}");
    project.write("packages/app/src/main.ts", "export {};");
    let source = project.0.join("packages/app/src");
    assert_eq!(find_repo_root(&source), project.0);
    assert_eq!(
        find_nearest_tsconfig(&source),
        Some(project.0.join("packages/app/tsconfig.json"))
    );
    assert_eq!(
        resolve_edge_ts_config(&source, EdgeScope::Package, &project.0).unwrap(),
        project.0.join("packages/app/tsconfig.json")
    );
    assert_eq!(
        resolve_edge_ts_config(&source, EdgeScope::Deep, &project.0).unwrap(),
        project.0.join("tsconfig.json")
    );
    fs::remove_file(project.0.join("tsconfig.json")).unwrap();
    let error = resolve_edge_ts_config(&source, EdgeScope::Deep, &project.0).unwrap_err();
    assert_eq!(
        error.to_string(),
        format!(
            "code-graph: no tsconfig.json found at or above the repo root ({}); the edge pass needs one to resolve modules (SPEC §3).",
            project.0.display()
        )
    );
    let no_workspace = Project::new();
    no_workspace.write(".git/HEAD", "ref: refs/heads/main\n");
    assert_eq!(find_repo_root(&no_workspace.0), no_workspace.0);
    assert!(find_nearest_tsconfig(&no_workspace.0).is_none());
}

#[test]
fn missing_configuration_retains_the_declared_root_after_the_input_is_dropped() {
    use demlik_code_graph::{
        project::{ProjectLoadError, load_edge_project_text},
        text::JsString,
    };
    let project = Project::new();
    let error = {
        let mut root = JsString::from(format!("{}/services/", project.0.display()));
        root.extend(&JsString::from_units(vec![0xd800]));
        load_edge_project_text(&root, EdgeScope::Package, &project.0, None).unwrap_err()
    };
    assert!(std::error::Error::source(&error).is_some());
    assert!(error.message().units().contains(&0xd800));
    let ProjectLoadError::MissingTsConfig(error) = error else {
        panic!("the loader preserves the typed refusal");
    };
    let mut expected = JsString::from(format!(
        "code-graph: no tsconfig.json found at or above {}/services/",
        project.0.display()
    ));
    expected.extend(&JsString::from_units(vec![0xd800]));
    expected.push_str("; the edge pass needs one to resolve modules (SPEC §3).");
    assert_eq!(error.message(), &expected);
    assert_eq!(error.start, project.0.join("services/\u{fffd}"));
    assert!(error.message().units().contains(&0xd800));
}

#[cfg(unix)]
#[test]
fn native_project_paths_keep_their_original_os_bytes_for_lookup_and_refusal() {
    use demlik_code_graph::project::{ProjectLoadError, load_edge_project};
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let project = Project::new();
    let root = project.0.join(OsString::from_vec(b"native-\xff".to_vec()));
    let shadow = project.0.join("native-\u{fffd}");
    fs::create_dir_all(shadow.join("src")).unwrap();
    fs::write(project.0.join("tsconfig.json"), "{}").unwrap();
    fs::write(shadow.join("tsconfig.json"), "{}").unwrap();
    fs::write(shadow.join("src/main.ts"), "export const shadow = true;").unwrap();
    // A lossy Path conversion would incorrectly load this real replacement-name scope.
    let loaded = load_edge_project(&root, EdgeScope::Package, &project.0, None).unwrap();
    assert_eq!(loaded.project.root_absolute, root);
    assert_eq!(loaded.ts_config_path, project.0.join("tsconfig.json"));
    assert!(loaded.project.source_files.is_empty());
    let visible = load_edge_project(&shadow, EdgeScope::Package, &project.0, None).unwrap();
    assert_eq!(visible.ts_config_path, shadow.join("tsconfig.json"));
    assert_eq!(visible.project.source_files.len(), 1);
    fs::remove_file(project.0.join("tsconfig.json")).unwrap();
    let ProjectLoadError::MissingTsConfig(error) =
        load_edge_project(&root, EdgeScope::Package, &project.0, None).unwrap_err()
    else {
        panic!("the native refusal keeps its typed path");
    };
    assert_eq!(error.start, root);
}

#[test]
fn resolves_tsconfig_aliases_extension_aliases_and_conditional_package_exports() {
    let project = Project::new();
    project.write(
        "tsconfig.json",
        r#"{ "extends": "./tsconfig.base.json", "include": ["src"] }"#,
    );
    project.write(
        "tsconfig.base.json",
        r#"{ // JSONC is a supported TypeScript config
        "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } },
    }"#,
    );
    for file in [
        "src/main.ts",
        "src/helper.ts",
        "src/component.tsx",
        "src/module.mts",
        "src/common.cts",
        "node_modules/widget/types/index.d.ts",
        "node_modules/widget/esm/index.js",
        "node_modules/widget/src/feature.ts",
    ] {
        project.write(file, "export {};\n");
    }
    project.write("node_modules/widget/package.json", r#"{ "name": "widget", "exports": { ".": { "types": "./types/index.d.ts", "import": "./esm/index.js", "default": "./esm/index.js" }, "./feature": "./src/feature.ts" } }"#);
    let resolver = create_module_resolver(&project.0.join("tsconfig.json"));
    let from = project.0.join("src/main.ts");
    for (specifier, expected) in [
        ("@app/helper", "src/helper.ts"),
        ("./helper.js", "src/helper.ts"),
        ("./component.jsx", "src/component.tsx"),
        ("./module.mjs", "src/module.mts"),
        ("./common.cjs", "src/common.cts"),
        ("widget", "node_modules/widget/types/index.d.ts"),
        ("widget/feature", "node_modules/widget/src/feature.ts"),
    ] {
        assert_eq!(
            resolver.resolve(&from, specifier),
            Some(project.0.join(expected)),
            "{specifier}"
        );
    }
    assert_eq!(resolver.resolve(&from, "widget/private"), None);
    assert_eq!(resolver.resolve(&from, "./missing.js"), None);
}

#[test]
fn automatically_selects_referenced_configs_and_resolves_workspace_symlinks_and_builtins() {
    let project = Project::new();
    project.write(
        "tsconfig.json",
        r#"{ "files": [], "references": [{ "path": "./packages/app/tsconfig.project.json" }] }"#,
    );
    project.write("packages/app/tsconfig.project.json", r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@local/*": ["src/*"] } }, "include": ["src"] }"#);
    project.write("packages/app/src/main.ts", "export {};");
    project.write("packages/app/src/local.ts", "export {};");
    project.write(
        "packages/lib/package.json",
        r#"{ "name": "@work/lib", "exports": { ".": "./src/index.ts" } }"#,
    );
    project.write("packages/lib/src/index.ts", "export {};");
    fs::create_dir_all(project.0.join("node_modules/@work")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        project.0.join("packages/lib"),
        project.0.join("node_modules/@work/lib"),
    )
    .unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(
        project.0.join("packages/lib"),
        project.0.join("node_modules/@work/lib"),
    )
    .unwrap();
    let resolver = create_nearest_tsconfig_resolver();
    let from = project.0.join("packages/app/src/main.ts");
    assert_eq!(
        resolver.resolve(&from, "@local/local"),
        FileResolution::Path(project.0.join("packages/app/src/local.ts"))
    );
    assert_eq!(
        resolver.resolve(&from, "@work/lib"),
        FileResolution::Path(project.0.join("packages/lib/src/index.ts"))
    );
    assert_eq!(resolver.resolve(&from, "node:fs"), FileResolution::Builtin);
    assert_eq!(resolver.resolve(&from, "path"), FileResolution::Builtin);
    assert_eq!(
        resolver.resolve(&from, "does-not-exist"),
        FileResolution::Missing
    );
    assert_eq!(
        resolver.locate(from.parent().unwrap(), "@work/lib"),
        Some(project.0.join("packages/lib/src/index.ts"))
    );
    assert_eq!(
        resolver.locate(from.parent().unwrap(), "@local/local"),
        None
    );
}

#[test]
fn preserves_native_failure_details_while_matching_the_missing_path_facade() {
    let project = Project::new();
    project.write("src/main.ts", "export {};");
    project.write("src/target.ts", "export {};");
    let from = project.0.join("src/main.ts");
    let missing_config = create_module_resolver(&project.0.join("missing.json"));
    assert_eq!(missing_config.resolve(&from, "./target"), None);
    assert!(matches!(
        missing_config.resolve_detailed(&from, "./target"),
        Err(ResolveError::TsconfigNotFound(_))
    ));
    project.write("tsconfig.json", r#"{ "compilerOptions": "#);
    let malformed_config = create_module_resolver(&project.0.join("tsconfig.json"));
    assert_eq!(malformed_config.resolve(&from, "./target"), None);
    assert!(matches!(
        malformed_config.resolve_detailed(&from, "./target"),
        Err(ResolveError::TsconfigLoadFailed { .. })
    ));
    let nearest = create_nearest_tsconfig_resolver();
    assert_eq!(nearest.resolve(&from, "./target"), FileResolution::Missing);
    assert!(matches!(
        nearest.resolve_detailed(&from, "./target"),
        Err(ResolveError::TsconfigLoadFailed { .. })
    ));
    project.write("tsconfig.json", "{}");
    project.write("node_modules/broken/package.json", r#"{ "exports": "#);
    let valid_config = create_module_resolver(&project.0.join("tsconfig.json"));
    assert_eq!(valid_config.resolve(&from, "broken"), None);
    assert!(matches!(
        valid_config.resolve_detailed(&from, "broken"),
        Err(ResolveError::Json(_))
    ));
    assert!(matches!(
        valid_config.resolve_detailed(&from, ""),
        Err(ResolveError::Specifier(_))
    ));
}
