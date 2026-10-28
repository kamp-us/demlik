use demlik_code_graph::layers::resolve_target::{match_package, workspace_packages};
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn a_workspace_package_keeps_its_first_owner_and_source_entry_for_subpath_imports() {
    let root = std::env::temp_dir().join(format!(
        "demlik-workspace-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (dir, name) in [
        ("packages/a", "@shop/api"),
        ("packages/b", "@shop/api"),
        ("packages/plain", "plain"),
    ] {
        fs::create_dir_all(root.join(dir).join("src")).unwrap();
        fs::write(
            root.join(dir).join("package.json"),
            format!(r#"{{"name":"{name}","main":"dist/index.js"}}"#),
        )
        .unwrap();
        fs::write(
            root.join(dir).join("src/index.ts"),
            "export const value = 1;",
        )
        .unwrap();
    }
    let packages = workspace_packages(
        &root,
        &[
            "".into(),
            "packages/a".into(),
            "packages/b".into(),
            "packages/plain".into(),
        ],
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(packages.len(), 2);
    let api = match_package(&"@shop/api/sub/path".into(), &packages).unwrap();
    assert_eq!(api.dir, "packages/a");
    assert_eq!(api.entry.as_ref().unwrap(), "packages/a/src/index.ts");
    assert_eq!(
        match_package(&"plain/sub".into(), &packages).unwrap().dir,
        "packages/plain"
    );
    assert!(match_package(&"@shop/api-extra".into(), &packages).is_none());
    fs::remove_dir_all(root).unwrap();
}
