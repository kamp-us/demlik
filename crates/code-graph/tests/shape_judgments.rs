use demlik_code_graph::{
    boundaries::{
        libraries::{LibrariesRead, read_libraries},
        rules::{BoundaryRules, place_of, scope_zoning},
        shape::{
            ShapeRead,
            judge::{ShapeContext, ShapedFile, judge_shape},
            read_shape,
        },
        violation::BoundaryViolation,
    },
    extract::wrangler_config::load_binding_catalog,
    project::load_cheap_project,
    syntax::imports::{resolve_imports, runtime_specifiers},
    text::{JsString, JsValue},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-shape-judgment-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create fixture: {error}"),
            }
        }
    }
    fn write(&self, file: &str, source: &str) {
        let file = self.0.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, source).unwrap();
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove fixture: {error}");
        }
    }
}
#[test]
fn real_application_imports_keep_only_the_allowlist_verdicts_and_fold_the_first_edge() {
    let repo = Repo::new();
    repo.write(
        "tsconfig.json",
        r#"{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}"#,
    );
    repo.write("packages/core/package.json", r#"{"name":"@shop/core"}"#);
    repo.write(
        "packages/adapter/package.json",
        r#"{"name":"@shop/adapter"}"#,
    );
    for file in [
        "src/orders/ports.ts",
        "src/orders/index.ts",
        "src/orders/adapters/driven/db.ts",
        "src/billing/index.ts",
        "src/generated/client.ts",
        "src/lib/format.ts",
    ] {
        repo.write(&format!("services/api/{file}"), "export const value=1;");
    }
    let file = JsString::from("src/orders/application/use.ts");
    repo.write(&format!("services/api/{}",file.to_utf8().unwrap()), "import type { First } from 'hono';\nimport { second } from 'hono';\nimport { value as a } from '../../generated/client';\nimport { value as b } from '../../generated/../generated/client';\nimport '../ports'; import '../../billing/index'; import '../../lib/format'; import '../adapters/driven/db'; import '@shop/core'; import '@shop/adapter'; import 'node:fs';");
    let rules=BoundaryRules::parse(&JsValue::parse(r#"{
      "features":{"services/api":["orders","billing"]},
      "libraryTypes":{"core":{"imports":[],"pure":true},"adapter":{"imports":[],"pure":false,"importedFrom":["driven"]}},
      "libraries":{"packages/core":"core","packages/adapter":"adapter"},
      "applicationShape":["application-import-outside-allowlist"],"applicationMayImport":["core"]
    }"#).unwrap()).unwrap();
    let scope = JsString::from("services/api");
    let absolute = repo.0.join("services/api");
    let loaded = load_cheap_project(&absolute, None).unwrap();
    let graph = resolve_imports(
        &absolute,
        &loaded.source_files,
        &repo.0.join("tsconfig.json"),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let edges = &graph.import_edges_by_file[&file.to_utf8().unwrap()];
    let judged: Vec<_> = edges
        .iter()
        .filter(|edge| edge.target.as_deref() == Some("src/orders/adapters/driven/db.ts"))
        .collect();
    let unit = loaded
        .source_files
        .iter()
        .find(|unit| unit.file == file.to_utf8().unwrap())
        .unwrap();
    let runtime = runtime_specifiers(&unit.syntax);
    let catalog = load_binding_catalog(
        &repo.0,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let ShapeRead::Read(shape) = read_shape(&rules, &catalog).unwrap() else {
        panic!("shape refused")
    };
    let LibrariesRead::Read(libraries) = read_libraries(
        &rules,
        &repo.0,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap() else {
        panic!("libraries refused")
    };
    let zoning = scope_zoning(&rules, &scope).unwrap();
    let found = judge_shape(
        ShapeContext {
            scope: &scope,
            shape: &shape,
            libraries: &libraries,
            zoning: &zoning,
        },
        ShapedFile {
            file: &file,
            import_edges: edges,
            runtime_specifiers: &runtime,
            offending_form: None,
        },
        &place_of(&file, &zoning),
        &judged,
    );
    let expected = vec![
        BoundaryViolation::ApplicationImportOutsideAllowlist {
            from: "services/api/src/orders/application/use.ts".into(),
            to: Some("services/api/src/generated/client.ts".into()),
            specifier: "../../generated/../generated/client".into(),
            type_only: false,
        },
        BoundaryViolation::ApplicationImportOutsideAllowlist {
            from: "services/api/src/orders/application/use.ts".into(),
            to: None,
            specifier: "hono".into(),
            type_only: false,
        },
    ];
    assert_eq!(found, expected);
}

#[test]
fn judged_edges_use_reference_identity_instead_of_equal_field_values() {
    use demlik_code_graph::{
        boundaries::{
            libraries::Libraries,
            rules::Place,
            shape::application::{ApplicationFile, ApplicationWorld, application_violations},
        },
        extract::wrangler_config::BindingCatalog,
        syntax::imports::{ImportEdge, ImportKind},
    };
    let rules =
        BoundaryRules::parse(&JsValue::parse(r#"{"features":{".":["orders"]}}"#).unwrap()).unwrap();
    let catalog = BindingCatalog {
        manifests: vec![],
        unparsed_configs: vec![],
    };
    let ShapeRead::Read(shape) = read_shape(&rules, &catalog).unwrap() else {
        panic!("shape refused")
    };
    let scope = JsString::from(".");
    let file = JsString::from("src/orders/application/use.ts");
    let zoning = scope_zoning(&rules, &scope).unwrap();
    let Place::Feature(place) = place_of(&file, &zoning) else {
        panic!("file has no feature")
    };
    let edges = vec![ImportEdge {
        specifier: "hono".into(),
        kind: ImportKind::Static,
        type_only: true,
        target: None,
    }];
    let copy = edges[0].clone();
    let libraries = Libraries::default();
    let runtime = Default::default();
    let judge = |judged: &[&ImportEdge]| {
        application_violations(
            ApplicationFile {
                scope: &scope,
                file: &file,
                feature: place.feature(),
                own: place.zone_rule().import_allowlist.unwrap(),
                import_edges: &edges,
                runtime_specifiers: &runtime,
                judged,
            },
            ApplicationWorld {
                rules: &shape,
                libraries: &libraries,
                place_of: &|target| place_of(target, &zoning),
            },
        )
    };
    assert_eq!(
        judge(&[&copy]),
        vec![BoundaryViolation::ApplicationImportOutsideAllowlist {
            from: file.clone(),
            to: None,
            specifier: "hono".into(),
            type_only: true
        }]
    );
    assert!(judge(&[&edges[0]]).is_empty());
    assert_eq!(judge(&[&copy, &copy]), judge(&[]));
}

#[test]
fn extracted_entry_forms_judge_the_feature_entry_and_only_a_librarys_own_entry() {
    use demlik_code_graph::{boundaries::shape::shape_facts_of, engine::oxc::parse_type_script};
    let repo = Repo::new();
    repo.write("packages/core/package.json", r#"{"name":"@shop/core"}"#);
    let rules=BoundaryRules::parse(&JsValue::parse(r#"{"features":{"services/api":["orders"]},"libraryTypes":{"core":{"imports":[],"pure":true}},"libraries":{"packages/core":"core"},"applicationShape":["index-not-exports-only"]}"#).unwrap()).unwrap();
    let catalog = load_binding_catalog(
        &repo.0,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let ShapeRead::Read(shape) = read_shape(&rules, &catalog).unwrap() else {
        panic!("shape refused")
    };
    let LibrariesRead::Read(libraries) = read_libraries(
        &rules,
        &repo.0,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap() else {
        panic!("libraries refused")
    };
    for (scope, file, expected) in [
        ("services/api", "src/orders/index.ts", true),
        ("services/api", "src/orders/application/index.ts", false),
        ("packages/core", "src/index.ts", true),
        ("packages/core", "src/schema/index.ts", false),
        ("services/api", "src/index.ts", false),
    ] {
        let scope = JsString::from(scope);
        let file = JsString::from(file);
        let source = "export { a } from './a'; export default {};";
        repo.write(
            &format!("{}/{}", scope.to_utf8().unwrap(), file.to_utf8().unwrap()),
            source,
        );
        let syntax = parse_type_script(
            &repo
                .0
                .join(scope.to_utf8().unwrap())
                .join(file.to_utf8().unwrap()),
            source,
        )
        .unwrap();
        let facts = shape_facts_of(&shape, &scope, &file, &syntax);
        let zoning = scope_zoning(&rules, &scope).unwrap();
        let found = judge_shape(
            ShapeContext {
                scope: &scope,
                shape: &shape,
                libraries: &libraries,
                zoning: &zoning,
            },
            ShapedFile {
                file: &file,
                import_edges: &[],
                runtime_specifiers: &Default::default(),
                offending_form: facts.offending_form.as_ref(),
            },
            &place_of(&file, &zoning),
            &[],
        );
        assert_eq!(found.len(), usize::from(expected), "{scope:?}/{file:?}");
        if expected {
            let Some(BoundaryViolation::IndexNotExportsOnly {
                specifier, from, ..
            }) = found.first()
            else {
                panic!("entry verdict changed kind");
            };
            assert_eq!(specifier, &JsString::from("export default"));
            assert_eq!(
                from,
                &demlik_code_graph::boundaries::rules::in_scope(&scope, &file)
            );
        }
    }
}
