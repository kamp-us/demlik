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
    let LibrariesRead::Read(libraries) = read_libraries(&rules, &root, None).unwrap() else {
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
