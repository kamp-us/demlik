use demlik_code_graph::layers::resolve_target::{ResolvedTarget, create_target_resolver};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_PROJECT: AtomicU64 = AtomicU64::new(0);
struct Project(PathBuf);
impl Project {
    fn new(files: &[(&str, &str)]) -> Self {
        let root = loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-layer-targets-{}-{}",
                std::process::id(),
                NEXT_PROJECT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => break path,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create fixture: {error}"),
            }
        };
        let project = Self(root);
        for (file, source) in files {
            let file = project.0.join(file);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, source).unwrap();
        }
        project
    }
}
impl Drop for Project {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove fixture: {error}");
        }
    }
}

#[test]
fn ordinary_layer_imports_resolve_source_probes_workspace_names_and_external_dependencies() {
    let project = Project::new(&[
        ("apps/web/src/ui/page.tsx", "export {};"),
        ("apps/web/src/lib/money.ts", "export const money = 1;"),
        ("apps/web/src/lib/money.tsx", "export const money = 2;"),
        (
            "apps/web/src/lib/types.d.ts",
            "export declare const type: unknown;",
        ),
        ("apps/web/src/lib/feature/index.tsx", "export {};"),
        (
            "packages/core/package.json",
            r#"{"name":"@shop/core","exports":"./dist/index.js"}"#,
        ),
        ("packages/core/src/index.ts", "export {};"),
        (
            "node_modules/pad/package.json",
            r#"{"name":"pad","main":"index.js"}"#,
        ),
        ("node_modules/pad/index.js", "module.exports = 1;"),
    ]);
    let mut resolver = create_target_resolver(
        &project.0,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let from = "apps/web/src/ui/page.tsx".into();
    for (specifier, expected) in [
        ("../lib/money.js", "apps/web/src/lib/money.ts"),
        ("../lib/types", "apps/web/src/lib/types.d.ts"),
        ("../lib/feature", "apps/web/src/lib/feature/index.tsx"),
    ] {
        let target = resolver.resolve(&from, &specifier.into()).unwrap();
        assert!(matches!(target, ResolvedTarget::File { file } if file == expected));
    }
    let target = resolver
        .resolve(&from, &"@shop/core/private/missing".into())
        .unwrap();
    assert!(
        matches!(target, ResolvedTarget::Package { pkg } if pkg.dir == "packages/core" && pkg.entry.as_ref().unwrap() == "packages/core/src/index.ts")
    );
    assert!(
        matches!(resolver.resolve(&from, &"../lib/gone.js".into()).unwrap(), ResolvedTarget::Unresolved { specifier } if specifier == "../lib/gone.js")
    );
    for specifier in ["node:fs", "pad", "not-installed", "cloudflare:workers"] {
        assert!(matches!(
            resolver.resolve(&from, &specifier.into()).unwrap(),
            ResolvedTarget::External
        ));
    }
}

#[test]
fn nearest_aliases_resolve_files_and_keep_missing_inherited_aliases_distinct_from_npm() {
    let project = Project::new(&[
        ("apps/web/src/page.ts", "export {};"),
        ("apps/web/src/lib/money.ts", "export const money = 1;"),
        (
            "tsconfig.base.json",
            "{\n// shared aliases\n\"compilerOptions\":{\"paths\":{\"@app/*\":[\"./apps/web/src/*\"]}},\n}",
        ),
        (
            "apps/web/tsconfig.json",
            r#"{"extends":"../../tsconfig.base.json"}"#,
        ),
    ]);
    let mut resolver = create_target_resolver(
        &project.0,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let from = "apps/web/src/page.ts".into();
    assert!(
        matches!(resolver.resolve(&from, &"@app/lib/money.js".into()).unwrap(), ResolvedTarget::File { file } if file == "apps/web/src/lib/money.ts")
    );
    assert!(
        matches!(resolver.resolve(&from, &"@app/gone".into()).unwrap(), ResolvedTarget::Unresolved { specifier } if specifier == "@app/gone")
    );
    assert!(matches!(
        resolver.resolve(&from, &"not-installed".into()).unwrap(),
        ResolvedTarget::External
    ));
}

#[test]
fn source_recovered_alias_keys_remain_real_gaps_even_when_the_compiler_rejects_the_config() {
    let project = Project::new(&[("src/page.ts", "export {};")]);
    for raw in [
        r#"{"compilerOptions":{"paths":{"@a/*":[]}}"#,
        r#"{"compilerOptions":{"paths":{"@a/*":[]}}}garbage"#,
        r#"{"compilerOptions":{"paths":{"@a/*":[]}} "x":1}"#,
        r#"{"compilerOptions":{"paths":{"@a/*":[]}}} /*"#,
        r#"{"compilerOptions":{"paths":{"@a/*":[]}}, bad:1}"#,
    ] {
        fs::write(project.0.join("tsconfig.json"), raw).unwrap();
        let mut resolver = create_target_resolver(
            &project.0,
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
        )
        .unwrap();
        assert!(
            matches!(
                resolver
                    .resolve(&"src/page.ts".into(), &"@a/missing".into())
                    .unwrap(),
                ResolvedTarget::Unresolved { .. }
            ),
            "{raw}"
        );
    }
}
