use demlik_code_graph::{
    boundaries::{
        libraries::{LibrariesRead, import_target_of, owner_of, read_libraries, undeclared_under},
        rules::{BoundaryRules, LibraryType},
    },
    text::JsString,
};
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn libraries_share_workspace_owners_and_assign_an_unlisted_package_to_its_nearest_root() {
    let root = std::env::temp_dir().join(format!(
        "demlik-libraries-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (dir, name) in [
        ("packages/core", "@shop/core"),
        ("packages/core/nested", "@shop/nested"),
        ("packages/other", "@shop/other"),
    ] {
        fs::create_dir_all(root.join(dir)).unwrap();
        fs::write(
            root.join(dir).join("package.json"),
            format!(r#"{{"name":"{name}"}}"#),
        )
        .unwrap();
    }
    let mut rules = BoundaryRules {
        library_roots: vec!["packages".into(), "packages/core".into()],
        ..BoundaryRules::default()
    };
    rules.library_types.insert(
        "kernel".into(),
        LibraryType {
            imports: vec![],
            pure: true,
            imported_from: None,
        },
    );
    rules
        .libraries
        .insert("packages/core".into(), "kernel".into());
    let LibrariesRead::Read(libraries) = read_libraries(
        &rules,
        &root,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap() else {
        panic!("valid libraries were refused")
    };
    assert_eq!(
        owner_of(&libraries, &JsString::from("packages/core/nested/src/a.ts")),
        Some("packages/core")
    );
    assert_eq!(
        undeclared_under(&libraries, &"packages/core".into()),
        vec!["packages/core/nested"]
    );
    assert_eq!(
        undeclared_under(&libraries, &"packages".into()),
        vec!["packages/other"]
    );
    assert!(matches!(
        import_target_of(&libraries, &"@shop/core/sub".into()),
        demlik_code_graph::boundaries::libraries::ImportTarget::Library {
            dir: "packages/core",
            ..
        }
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn real_imports_drive_library_verdicts_stale_allowances_and_the_measured_census() {
    use demlik_code_graph::{
        boundaries::{
            impure_uses::{ImpureFacts, detect_impure_uses},
            libraries::{
                allowance::{NamedFile, allowance_issue, imported_names_for},
                census::{MeasuredLibraries, census_lines, library_census},
                violations::{LibraryFile, judge_libraries},
            },
            violation::BoundaryViolation,
        },
        engine::oxc::parse_type_script,
        syntax::imports::{ImportEdge, import_literals, runtime_specifiers},
        text::JsValue,
    };
    let root = std::env::temp_dir().join(format!("demlik-library-verdict-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    for (dir, name) in [
        ("packages/core", "@shop/core"),
        ("packages/adapter", "@shop/adapter"),
        ("packages/free", "@shop/free"),
    ] {
        fs::create_dir_all(root.join(dir)).unwrap();
        fs::write(
            root.join(dir).join("package.json"),
            format!(r#"{{"name":"{name}"}}"#),
        )
        .unwrap();
    }
    let rules = BoundaryRules::parse(&JsValue::parse(r#"{
        "libraryTypes":{"core":{"imports":[],"pure":true},"adapter":{"imports":[],"pure":false,"importedFrom":["driven"]},"unused":{"imports":[],"pure":false}},
        "libraries":{"packages/core":"core","packages/adapter":"adapter"},
        "libraryRoots":["packages"],
        "worldLibraries":["node:*"],
        "allowImportNames":{"packages/core":{"packages/adapter":["A","Never"]}}
    }"#).unwrap()).unwrap();
    let LibrariesRead::Read(libraries) = read_libraries(
        &rules,
        &root,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap() else {
        panic!("fixture refused")
    };
    let scope = JsString::from("packages/core");
    let file = JsString::from("packages/core/src/a.ts");
    let syntax = parse_type_script(std::path::Path::new("a.ts"),"import {A} from '@shop/adapter'; import {B} from '@shop/adapter/sub'; import {F} from '@shop/free'; console.log('x');").unwrap();
    let names = imported_names_for(&libraries, &scope, &syntax);
    let edges: Vec<_> = import_literals(&syntax)
        .into_iter()
        .map(|edge| ImportEdge {
            specifier: edge.specifier,
            kind: edge.kind,
            type_only: edge.type_only,
            target: None,
        })
        .collect();
    let impure = detect_impure_uses(&syntax);
    let runtime = runtime_specifiers(&syntax);
    let verdict = judge_libraries(
        &libraries,
        &scope,
        LibraryFile {
            file: &file,
            imported_names: &names,
            facts: ImpureFacts {
                impure_uses: &impure,
                import_edges: &edges,
                runtime_specifiers: &runtime,
            },
        },
        None,
    )
    .unwrap();
    assert_eq!(verdict.unjudged, 1);
    assert_eq!(verdict.violations.len(), 2);
    assert!(
        matches!(&verdict.violations[0],BoundaryViolation::LibraryImportsUp {specifier,type_only:false,..} if specifier=="@shop/adapter")
    );
    assert!(
        matches!(&verdict.violations[1],BoundaryViolation::Impure {specifier,..} if specifier=="console")
    );
    let rel = JsString::from("src/a.ts");
    assert_eq!(
        allowance_issue(
            &libraries,
            &scope,
            &[NamedFile {
                file: &rel,
                imported_names: &names
            }]
        )
        .unwrap(),
        "allowImportNames \"packages/core\" licenses \"Never\" of \"packages/adapter\", which \"packages/core\" never imports from it: remove the name."
    );
    let census = library_census(
        &libraries,
        MeasuredLibraries {
            scopes: &[scope],
            undeclared: &["packages/free".into()],
            unjudged: 1.0,
        },
    )
    .unwrap();
    assert_eq!(
        census.types[&JsString::from("adapter")],
        Vec::<JsString>::new()
    );
    assert_eq!(
        census.types[&JsString::from("core")],
        vec![JsString::from("packages/core")]
    );
    assert_eq!(
        census_lines(&census)[0],
        "libraries: 1 declared (adapter 0, core 1, unused 0), 1 undeclared, 1 import left unjudged"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn inherited_allowances_keep_function_names_and_eager_getter_errors() {
    use demlik_code_graph::{
        boundaries::libraries::{
            LibraryRuleError,
            allowance::{NamedFile, imported_names_for, is_licensed},
        },
        engine::oxc::parse_type_script,
        text::JsValue,
    };
    let root = std::env::temp_dir().join(format!(
        "demlik-inherited-license-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (dir, name) in [("toString", "@probe/toString"), ("name", "@probe/name")] {
        fs::create_dir_all(root.join(dir)).unwrap();
        fs::write(
            root.join(dir).join("package.json"),
            format!(r#"{{"name":"{name}"}}"#),
        )
        .unwrap();
    }
    let rules=BoundaryRules::parse(&JsValue::parse(r#"{"libraryTypes":{"low":{"imports":[],"pure":false},"high":{"imports":[],"pure":false}},"libraries":{"toString":"low","name":"high"}}"#).unwrap()).unwrap();
    let LibrariesRead::Read(libraries) = read_libraries(
        &rules,
        &root,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap() else {
        panic!("fixture refused")
    };
    let scope = JsString::from("toString");
    let file = JsString::from("toString/a.ts");
    let syntax = parse_type_script(
        std::path::Path::new("a.ts"),
        "import {toString} from '@probe/name';",
    )
    .unwrap();
    let names = imported_names_for(&libraries, &scope, &syntax);
    let specifiers = [JsString::from("@probe/name")].into_iter().collect();
    assert!(
        is_licensed(
            &libraries,
            &scope,
            &"name".into(),
            &specifiers,
            NamedFile {
                file: &file,
                imported_names: &names
            }
        )
        .unwrap()
    );
    assert!(matches!(
        is_licensed(
            &libraries,
            &scope,
            &"caller".into(),
            &Default::default(),
            NamedFile {
                file: &file,
                imported_names: &names
            }
        ),
        Err(LibraryRuleError::RestrictedFunctionProperty)
    ));
    fs::remove_dir_all(root).unwrap();
}
