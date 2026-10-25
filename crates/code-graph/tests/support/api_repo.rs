#![allow(dead_code)]
use demlik_code_graph::{engine::tsgo::TsgoBinary, text::JsString};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub fn compiler() -> TsgoBinary {
    TsgoBinary::from_native_preview_manifest(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json"),
    )
    .unwrap()
}
pub struct Repo {
    pub top: PathBuf,
    pub package: PathBuf,
}
impl Repo {
    pub fn new() -> Self {
        let top = std::env::temp_dir().join(format!(
            "demlik-api-workflow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&top).unwrap();
        let top = fs::canonicalize(top).unwrap();
        let package = top.join("packages/demo");
        let repo = Self { top, package };
        repo.git(&["init", "-q"]);
        repo.git(&["config", "user.name", "Fixture"]);
        repo.git(&["config", "user.email", "fixture@example.test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.put("pnpm-workspace.yaml", "packages: [packages/*]\n");
        repo.put("packages/demo/package.json", "{\"name\":\"demo\"}\n");
        repo.put("packages/demo/tsconfig.json","{\"compilerOptions\":{\"strict\":true,\"target\":\"ES2022\",\"module\":\"ESNext\"},\"include\":[\"src\"]}\n");
        repo
    }
    pub fn root(&self) -> JsString {
        self.package.to_str().unwrap().into()
    }
    pub fn put(&self, file: &str, body: &str) {
        let file = self.top.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, body).unwrap();
    }
    pub fn git(&self, args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .arg("--no-optional-locks")
            .args(args)
            .current_dir(&self.top)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
    pub fn commit(&self) -> JsString {
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", "fixture"]);
        String::from_utf8(self.git(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .into()
    }
    pub fn state(&self) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
        (
            self.git(&["status", "--porcelain=v1", "-z"]),
            fs::read(self.top.join(".git/index")).unwrap(),
            self.git(&["show-ref", "--head"]),
            fs::read(self.package.join("src/index.ts")).unwrap(),
        )
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.top)
            && !std::thread::panicking()
        {
            panic!("fixture cleanup: {error}");
        }
    }
}
