#![cfg(unix)]

use demlik_code_graph::engine::tsgo::{NATIVE_PREVIEW_PIN, TsgoBinary, TsgoError};
use std::{fs, os::unix::fs::symlink, path::PathBuf};

#[test]
fn installed_package_lookup_keeps_the_nearest_packages_typed_validation_failure() {
    let root = std::env::temp_dir().join(format!(
        "demlik-compiler-installation-{}",
        std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    let fixture = Fixture(root);
    let packages = fixture.0.join("node_modules/@typescript");
    fs::create_dir_all(&packages).unwrap();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json")
        .canonicalize()
        .unwrap();
    symlink(manifest.parent().unwrap(), packages.join("native-preview")).unwrap();
    let nested_bin = fixture.0.join("nested/bin");
    fs::create_dir_all(&nested_bin).unwrap();
    let installed = TsgoBinary::from_installation(&nested_bin).unwrap();
    let explicit = TsgoBinary::from_native_preview_manifest(&manifest).unwrap();
    assert_eq!(installed.path(), explicit.path());
    assert_eq!(installed.version(), NATIVE_PREVIEW_PIN);

    let nearest = fixture
        .0
        .join("nested/node_modules/@typescript/native-preview");
    fs::create_dir_all(&nearest).unwrap();
    fs::write(
        nearest.join("package.json"),
        r#"{"name":"@typescript/native-preview","version":"0.0.0","bin":{"tsgo":"lib/tsgo"}}"#,
    )
    .unwrap();
    match TsgoBinary::from_installation(&nested_bin) {
        Err(TsgoError::VersionMismatch { expected, actual }) => {
            assert_eq!(expected, NATIVE_PREVIEW_PIN);
            assert_eq!(actual, "0.0.0");
        }
        _ => panic!("nearest invalid installation must not fall through to the valid ancestor"),
    }
}

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
