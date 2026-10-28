import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function cargoCheckEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CARGO_TARGET_DIR;
  delete env.DEMLIK_MUTATION_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET_DIR;
  delete env.CARGO_BUILD_BUILD_DIR;
  return env;
}

export function assertCheckPath(file, owner) {
  const canonical = fs.realpathSync(file);
  const relative = path.relative(fs.realpathSync(owner), canonical);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `check artifact must belong to ${owner}: ${file}`,
  );
  return canonical;
}

export function compiledCheckLibrary(rows, name, root, target) {
  const libraries = rows.filter(
    (row) =>
      row.reason === "compiler-artifact" &&
      row.target.name === name &&
      row.target.kind.includes("lib") &&
      row.filenames.some((file) => file.endsWith(".rlib")),
  );
  assert.equal(libraries.length, 1, `one check-owned ${name} library`);
  const artifact = libraries[0];
  assert.equal(artifact.fresh, false, `${name} must be rebuilt for this fault`);
  const sourcePath = assertCheckPath(artifact.target.src_path, root);
  const manifestPath = assertCheckPath(artifact.manifest_path, root);
  const files = artifact.filenames.filter((file) => file.endsWith(".rlib"));
  assert.equal(files.length, 1);
  return {
    artifact,
    sourcePath,
    manifestPath,
    path: assertCheckPath(files[0], target),
  };
}

export function checkEvidenceDirectory(sourceRoot, name) {
  assert.match(name, /^[a-z0-9-]+$/);
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  return path.join(
    path.dirname(path.resolve(sourceRoot, common)),
    ".fabrika",
    "rust-parity-evidence",
    name,
  );
}

export function createCheckWorktree(sourceRoot, name, evidenceDirectory) {
  assert.match(name, /^[a-z0-9-]+$/);
  const evidence = path.resolve(evidenceDirectory);
  fs.mkdirSync(evidence, { recursive: true });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `demlik-check-${name}-`)),
  );
  const root = path.join(parent, "repo");
  const relative = path.relative(root, evidence);
  assert.ok(
    relative.startsWith("..") || path.isAbsolute(relative),
    "evidence must outlive the check worktree",
  );
  const target = path.join(root, "target");
  const receipt = {
    sourceCommit,
    worktree: root,
    target,
    defaultTarget: true,
    createdAt: new Date().toISOString(),
    removed: false,
  };
  const file = path.join(evidence, `${name}-worktree.json`);
  const save = () =>
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  const registeredHere = () =>
    execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: sourceRoot,
      encoding: "utf8",
    })
      .split("\0")
      .includes(`worktree ${root}`);
  function remove() {
    try {
      // A failed add can leave a registry entry even though it did not return.
      if (registeredHere()) {
        execFileSync("git", ["worktree", "remove", "--force", root], {
          cwd: sourceRoot,
          stdio: "pipe",
        });
      }
      assert.ok(!registeredHere(), "finished check registration must be gone");
      if (fs.existsSync(root))
        fs.rmSync(root, { recursive: true, force: true });
      assert.ok(!fs.existsSync(root), "finished check worktree must be gone");
      if (fs.existsSync(parent)) fs.rmdirSync(parent);
      receipt.removed = true;
      receipt.finishedAt = new Date().toISOString();
    } catch (error) {
      receipt.cleanupFailure = String(error);
      throw error;
    } finally {
      save();
    }
  }
  try {
    execFileSync("git", ["worktree", "add", "--detach", root, sourceCommit], {
      cwd: sourceRoot,
      stdio: "pipe",
    });
    save();
    return { root, target, remove };
  } catch (error) {
    receipt.setupFailure = String(error);
    try {
      remove();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "check worktree setup and cleanup failed",
      );
    }
    throw error;
  }
}
