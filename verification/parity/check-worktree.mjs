import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function cargoCheckEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CARGO_TARGET_DIR;
  delete env.DEMLIK_MUTATION_TARGET_DIR;
  return env;
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
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), `demlik-check-${name}-`),
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
  let registered = false;
  function remove() {
    try {
      if (registered) {
        execFileSync("git", ["worktree", "remove", "--force", root], {
          cwd: sourceRoot,
          stdio: "pipe",
        });
        registered = false;
      }
      assert.ok(!fs.existsSync(root), "finished check worktree must be gone");
      fs.rmdirSync(parent);
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
    registered = true;
    save();
    return { root, target, remove };
  } catch (error) {
    remove();
    throw error;
  }
}
