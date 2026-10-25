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

#[cfg(unix)]
#[test]
fn raw_realpath_components_follow_the_nine_pinned_source_symlink_cases() {
    let package = Package::new();
    let root = fs::canonicalize(&package.0).unwrap();
    let root: JsString = root.to_str().unwrap().into();
    let join = |tail: &str| {
        let mut path = root.clone();
        path.push_str("/");
        path.push_str(tail);
        path
    };
    let raw = JsString::from_units(
        root.units()
            .iter()
            .copied()
            .chain("/raw".encode_utf16())
            .chain([0xd800])
            .collect(),
    );
    fs::create_dir_all(format!("{}/ordinary", raw.to_lossy())).unwrap();
    fs::create_dir_all(join("target/suffix�").to_lossy()).unwrap();
    std::os::unix::fs::symlink("ordinary", format!("{}/relative-link", raw.to_lossy())).unwrap();
    std::os::unix::fs::symlink(
        join("target").to_lossy(),
        format!("{}/absolute-link", raw.to_lossy()),
    )
    .unwrap();
    std::os::unix::fs::symlink(raw.to_lossy(), join("entry-link").to_lossy()).unwrap();
    std::os::unix::fs::symlink("entry-link", join("chain").to_lossy()).unwrap();
    let mut low = root.clone();
    low.push_str("/raw");
    low.extend(&JsString::from_units(vec![0xdfff]));
    let suffix = |path: &JsString, tail: &str| {
        let mut value = path.clone();
        value.push_str(tail);
        value
    };
    let raw_suffix = JsString::from_units("/suffix".encode_utf16().chain([0xd800]).collect());
    let mut after_link = suffix(&raw, "/absolute-link");
    after_link.extend(&raw_suffix);
    let mut expected_after_link = join("target");
    expected_after_link.extend(&raw_suffix);
    for (given, expected) in [
        (raw.clone(), raw.clone()),
        (low.clone(), low),
        (join("raw�"), join("raw�")),
        (suffix(&raw, "/ordinary"), suffix(&raw, "/ordinary")),
        (suffix(&raw, "/relative-link"), suffix(&raw, "/ordinary")),
        (suffix(&raw, "/absolute-link"), join("target")),
        (after_link, expected_after_link),
        (join("entry-link"), join("raw�")),
        (join("chain/ordinary"), join("raw�/ordinary")),
    ] {
        assert_eq!(package_root(&given).unwrap(), expected, "{given:?}");
    }
}

#[cfg(unix)]
#[test]
fn dangling_and_broken_links_remain_directory_refusals() {
    let package = Package::new();
    for (name, target) in [("dangling", "missing"), ("broken-parent", "missing/child")] {
        let path = package.0.join(name);
        std::os::unix::fs::symlink(target, &path).unwrap();
        let raw = JsString::from(path.to_str().unwrap());
        let error = package_root(&raw).unwrap_err();
        let ApiError::Input(error) = error else {
            panic!("expected directory refusal")
        };
        let mut expected = raw;
        expected.push_str(" is not a directory");
        assert_eq!(error.message(), &expected);
    }
}
