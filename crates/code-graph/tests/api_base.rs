use demlik_code_graph::{
    api::{
        base::{checkout_of, names_at_base, resolve_base},
        map::ApiError,
    },
    text::JsString,
};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "demlik-api-git-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let repo = Self(fs::canonicalize(root).unwrap());
        repo.git(&["init", "-q"]);
        repo.git(&["config", "user.name", "Fixture"]);
        repo.git(&["config", "user.email", "fixture@example.test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }
    fn put(&self, file: &str, body: &str) {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }
    fn git(&self, args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.0)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
    fn commit(&self) -> JsString {
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", "fixture"]);
        String::from_utf8(self.git(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .into()
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn git_reads_resolve_commits_and_zero_terminated_names_without_changing_the_checkout() {
    let repo = Repo::new();
    repo.put("packages/demo/package.json", "{\"name\":\"demo\"}");
    repo.put(".changeset/z.md", "---\ndemo: patch\n---\nbody");
    repo.put(".changeset/a\nline.md", "---\ndemo: minor\n---\nbody");
    let sha = repo.commit();
    repo.put("packages/demo/current.txt", "untracked working file");
    let before = (
        repo.git(&["status", "--porcelain=v1", "-z"]),
        fs::read(repo.0.join(".git/index")).unwrap(),
        repo.git(&["show-ref", "--head"]),
    );
    let root = JsString::from(repo.0.join("packages/demo").to_str().unwrap());
    let checkout = checkout_of(&root).unwrap();
    assert_eq!(checkout.top, repo.0.to_str().unwrap());
    assert_eq!(checkout.package_path, "packages/demo");
    assert_eq!(resolve_base(&checkout, &"HEAD".into()).unwrap(), sha);
    let names = names_at_base(&checkout.top, &sha, &".changeset/".into()).unwrap();
    assert_eq!(
        names,
        [
            JsString::from(".changeset/a\nline.md"),
            JsString::from(".changeset/z.md")
        ]
    );
    let error = resolve_base(&checkout, &"--help".into()).unwrap_err();
    assert!(matches!(&error, ApiError::Input(_)));
    assert!(
        error
            .message()
            .to_lossy()
            .contains("does not resolve to a commit")
    );
    assert!(
        std::error::Error::source(&error)
            .unwrap()
            .source()
            .is_some()
    );
    let after = (
        repo.git(&["status", "--porcelain=v1", "-z"]),
        fs::read(repo.0.join(".git/index")).unwrap(),
        repo.git(&["show-ref", "--head"]),
    );
    assert_eq!(after, before);
}

#[test]
fn base_export_streams_commits_and_trees_links_current_dependencies_and_cleans_explicitly() {
    use demlik_code_graph::api::base::{export_base_tree_blocking, remove_base_tree};
    let repo = Repo::new();
    repo.put("packages/demo/package.json", "{\"name\":\"demo\"}");
    repo.put("packages/demo/version.txt", "base");
    let sha = repo.commit();
    repo.put("packages/demo/version.txt", "working");
    repo.put(
        "packages/demo/node_modules/pkg/index.js",
        "package dependency",
    );
    repo.put("node_modules/root/index.js", "root dependency");
    let checkout = checkout_of(&repo.0.join("packages/demo").to_str().unwrap().into()).unwrap();
    let before = (
        repo.git(&["status", "--porcelain=v1", "-z"]),
        fs::read(repo.0.join(".git/index")).unwrap(),
        repo.git(&["show-ref", "--head"]),
    );
    for revision in [
        sha,
        String::from_utf8(repo.git(&["rev-parse", "HEAD^{tree}"]))
            .unwrap()
            .trim()
            .into(),
    ] {
        let tree = export_base_tree_blocking(&checkout, &revision).unwrap();
        assert!(!tree.temp.to_lossy().starts_with(repo.0.to_str().unwrap()));
        assert_eq!(
            fs::read_to_string(format!("{}/version.txt", tree.root.to_lossy())).unwrap(),
            "base"
        );
        assert_eq!(
            fs::read_link(format!("{}/node_modules", tree.root.to_lossy())).unwrap(),
            repo.0.join("packages/demo/node_modules")
        );
        assert_eq!(
            fs::read_link(format!("{}/node_modules", tree.temp.to_lossy())).unwrap(),
            repo.0.join("node_modules")
        );
        remove_base_tree(&tree.temp).unwrap();
        remove_base_tree(&tree.temp).unwrap();
        assert!(!std::path::Path::new(&tree.temp.to_lossy()).exists());
    }
    let dangerous = JsString::from(format!("--output={}/out.tar", repo.0.display()));
    assert!(export_base_tree_blocking(&checkout, &dangerous).is_err());
    assert!(!repo.0.join("out.tar").exists());
    assert_eq!(
        (
            repo.git(&["status", "--porcelain=v1", "-z"]),
            fs::read(repo.0.join(".git/index")).unwrap(),
            repo.git(&["show-ref", "--head"])
        ),
        before
    );
}

#[test]
fn changesets_count_only_added_direct_regular_files_and_refuse_before_filtering_package_bumps() {
    use demlik_code_graph::api::{
        model::ChangesetBump,
        ratchet::changesets::{ChangesetsOptions, read_changesets_since},
    };
    let repo = Repo::new();
    repo.put("packages/demo/package.json", "{\"name\":\"demo\"}");
    repo.put("pnpm-workspace.yaml", "packages: [packages/*]");
    repo.put(".changeset/old.md", "old base content");
    let base = repo.commit();
    repo.put(".changeset/old.md", "malformed but changed, not added");
    repo.put(".changeset/z.md", "---\ndemo: major\n---\n\nZ body\n");
    repo.put(".changeset/a.md", "---\ndemo: minor\n---\nA body");
    repo.put(".changeset/none.md", "---\ndemo: none\n---\n");
    repo.put(".changeset/other.md", "---\nother: patch\n---\n");
    repo.put(".changeset/README.md", "not frontmatter");
    repo.put(".changeset/nested/child.md", "not frontmatter");
    #[cfg(unix)]
    std::os::unix::fs::symlink("README.md", repo.0.join(".changeset/symlink.md")).unwrap();
    let root = repo.0.join("packages/demo").to_str().unwrap().into();
    let value = read_changesets_since(&root, &base, ChangesetsOptions::default()).unwrap();
    assert_eq!(value.package, "demo");
    assert_eq!(
        value
            .changesets
            .iter()
            .map(|item| item.file.to_lossy())
            .collect::<Vec<_>>(),
        [".changeset/a.md", ".changeset/z.md"]
    );
    assert_eq!(value.changesets[0].bump, ChangesetBump::Minor);
    assert_eq!(value.changesets[1].bump, ChangesetBump::Major);
    assert_eq!(value.changesets[1].body, "\nZ body\n");
    repo.put(".changeset/0-unrelated.md", "---\nother: PATCH\n---\n");
    let error = read_changesets_since(&root, &base, ChangesetsOptions::default()).unwrap_err();
    assert!(
        error
            .message()
            .to_lossy()
            .starts_with("changeset .changeset/0-unrelated.md has no frontmatter")
    );
    repo.put("packages/demo/package.json", "null");
    let error = read_changesets_since(&root, &"no-such-base".into(), ChangesetsOptions::default())
        .unwrap_err();
    assert!(error.message().to_lossy().starts_with("cannot read "));
    assert!(
        error
            .message()
            .to_lossy()
            .ends_with("the ratchet needs the package's name")
    );
}

#[test]
fn malformed_process_arguments_and_partial_capture_failures_remain_owned_error_data() {
    use demlik_code_graph::api::{
        base::{Checkout, GitCaptureError, GitReadFailure},
        map::ApiArgumentLocation,
    };
    let checkout = Checkout {
        top: JsString::from_units(vec![b'/' as u16, 0, 0xd800]),
        package_path: "".into(),
    };
    let revision = JsString::from_units(vec![0xdc00, 0, b'x' as u16]);
    let error = resolve_base(&checkout, &revision).unwrap_err();
    let ApiError::Argument(error) = error else {
        panic!("expected typed spawn argument refusal")
    };
    assert_eq!(error.location(), ApiArgumentLocation::Argument(4));
    assert_eq!(error.code(), "ERR_INVALID_ARG_VALUE");
    let mut expected = revision;
    expected.push_str("^{commit}");
    assert_eq!(error.argument(), &expected);
    assert!(std::error::Error::source(&error).is_some());

    let repo = Repo::new();
    for index in 0..4200 {
        repo.put(&format!(".changeset/{index:04}-{}.md", "x".repeat(244)), "");
    }
    let sha = repo.commit();
    let error = names_at_base(
        &repo.0.to_str().unwrap().into(),
        &sha,
        &".changeset/".into(),
    )
    .unwrap_err();
    let cause = std::error::Error::source(&error)
        .unwrap()
        .source()
        .unwrap()
        .downcast_ref::<GitReadFailure>()
        .unwrap();
    assert_eq!(cause.arguments[0], "ls-tree");
    assert!(cause.stdout.len() > 1048576);
    assert!(cause.stdout.len() <= 1048576 + 8192);
    assert!(cause.stderr.is_empty());
    assert!(cause.status.is_some());
    assert!(matches!(
        cause.failures[0],
        GitCaptureError::OutputLimit { limit: 1048576, .. }
    ));
}

#[cfg(unix)]
#[test]
fn export_preserves_archived_dependencies_and_reports_operation_and_cleanup_failures() {
    use demlik_code_graph::api::base::{export_base_tree_blocking, remove_base_tree};
    use std::os::unix::fs::PermissionsExt;
    fn writable(path: &std::path::Path) {
        if fs::symlink_metadata(path).unwrap().is_dir() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
            for entry in fs::read_dir(path).unwrap() {
                writable(&entry.unwrap().path());
            }
        }
    }
    let repo = Repo::new();
    repo.put("packages/demo/package.json", "{}");
    repo.put(
        "packages/demo/node_modules/archived.txt",
        "archived dependency",
    );
    let sha = repo.commit();
    repo.put(
        "packages/demo/node_modules/current.txt",
        "current dependency",
    );
    let checkout = checkout_of(&repo.0.join("packages/demo").to_str().unwrap().into()).unwrap();
    let tree = export_base_tree_blocking(&checkout, &sha).unwrap();
    assert!(
        !fs::symlink_metadata(format!("{}/node_modules", tree.root.to_lossy()))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        std::path::Path::new(&format!(
            "{}/node_modules/archived.txt",
            tree.root.to_lossy()
        ))
        .exists()
    );
    assert!(
        !std::path::Path::new(&format!(
            "{}/node_modules/current.txt",
            tree.root.to_lossy()
        ))
        .exists()
    );
    remove_base_tree(&tree.temp).unwrap();
    repo.git(&["rm", "-r", "packages/demo/node_modules"]);
    fs::remove_dir_all(repo.0.join("packages/demo/node_modules")).unwrap();
    std::os::unix::fs::symlink("absent", repo.0.join("packages/demo/node_modules")).unwrap();
    let broken = repo.commit();
    fs::remove_file(repo.0.join("packages/demo/node_modules")).unwrap();
    repo.put("packages/demo/node_modules/current.txt", "installed");
    let error = export_base_tree_blocking(&checkout, &broken).unwrap_err();
    let ApiError::Symlink {
        path: installed,
        destination: path,
        source,
    } = error
    else {
        panic!("expected an existing broken-link refusal")
    };
    assert_eq!(source.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(
        installed,
        repo.0.join("packages/demo/node_modules").to_str().unwrap()
    );
    let temp = path
        .to_lossy()
        .split("/packages/demo/node_modules")
        .next()
        .unwrap()
        .to_string();
    assert!(!std::path::Path::new(&temp).exists());
    repo.git(&["config", "tar.umask", "0222"]);
    let error = export_base_tree_blocking(&checkout, &broken).unwrap_err();
    let ApiError::OperationAndCleanup { operation, cleanup } = error else {
        panic!("expected both operation and cleanup failures")
    };
    assert!(matches!(*operation, ApiError::Symlink { .. }));
    let ApiError::Io { path: temp, source } = *cleanup else {
        panic!("expected typed cleanup IO")
    };
    assert_eq!(source.kind(), std::io::ErrorKind::PermissionDenied);
    assert!(std::path::Path::new(&temp.to_lossy()).exists());
    writable(std::path::Path::new(&temp.to_lossy()));
    remove_base_tree(&temp).unwrap();
}
