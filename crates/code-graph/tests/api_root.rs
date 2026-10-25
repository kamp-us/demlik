use demlik_code_graph::{
    api::{map::ApiError, package_root, project_relative},
    text::JsString,
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Package(PathBuf);
impl Package {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-api-root-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create root fixture: {error}"),
            }
        }
    }
}
impl Drop for Package {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove root fixture: {error}");
        }
    }
}
#[test]
fn package_root_checks_real_directories_and_project_relative_uses_current_directory() {
    let package = Package::new();
    let given = JsString::from(format!("{}/./", package.0.display()));
    let root = package_root(&given).unwrap();
    let canonical = fs::canonicalize(&package.0).unwrap();
    assert_eq!(root, canonical.to_str().unwrap());
    let cwd = fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
    assert_eq!(
        project_relative(&JsString::from(cwd.to_str().unwrap())).unwrap(),
        "."
    );
    fs::write(package.0.join("file.ts"), "export {};").unwrap();
    let file = JsString::from(package.0.join("file.ts").to_str().unwrap());
    let error = package_root(&file).unwrap_err();
    let ApiError::Input(error) = error else {
        panic!("expected input refusal")
    };
    let mut expected = file;
    expected.push_str(" is not a directory");
    assert_eq!(error.message(), &expected);
}
#[test]
fn a_missing_raw_root_keeps_its_code_units_in_the_refusal() {
    let package = Package::new();
    let mut given = JsString::from(package.0.to_str().unwrap());
    given.push_str("/missing-");
    given.extend(&JsString::from_units(vec![0xd800]));
    let error = package_root(&given).unwrap_err();
    let ApiError::Input(error) = error else {
        panic!("expected raw input refusal")
    };
    let mut expected = given;
    expected.push_str(" is not a directory");
    assert_eq!(error.message(), &expected);
}
#[cfg(unix)]
#[test]
fn package_root_follows_a_real_symlink_without_changing_its_target() {
    let package = Package::new();
    let target = package.0.join("target");
    fs::create_dir(&target).unwrap();
    let link = package.0.join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let root = package_root(&link.to_str().unwrap().into()).unwrap();
    assert_eq!(root, fs::canonicalize(&target).unwrap().to_str().unwrap());
    assert!(link.is_symlink());
    assert!(target.is_dir());
}
