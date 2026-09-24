// Runs scripts/publish-pending.mjs as publish.yaml does, over a throwaway two-package repo, with an
// injected publish command in place of `npm publish` — so no registry is ever called (#372).

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./publish-pending.mjs", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

let root;
let repo;

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function commit(message) {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

/** A package whose `build` copies `src.txt` into `dist/index.js`, so the tarball shows its source. */
function writePackage(dir, name, version, source, extra = {}) {
  write(
    path.join(repo, dir, "package.json"),
    `${JSON.stringify({ name, version, files: ["dist"], scripts: { build: "node build.mjs" }, ...extra }, null, 2)}\n`,
  );
  write(
    path.join(repo, dir, "build.mjs"),
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";\n' +
      'mkdirSync("dist", { recursive: true });\n' +
      'writeFileSync("dist/index.js", readFileSync("src.txt", "utf8"));\n',
  );
  write(path.join(repo, dir, "src.txt"), source);
}

/**
 * A publish stand-in: logs `<tarball basename> <dist/index.js content>` to `publish.log`, and
 * fails the way npm does when the tarball name contains `$FAIL_MATCH`.
 */
function writeFakePublish() {
  const file = path.join(root, "fake-publish.mjs");
  write(
    file,
    'import { execFileSync } from "node:child_process";\n' +
      'import { appendFileSync } from "node:fs";\n' +
      'import path from "node:path";\n' +
      "const tgz = process.argv[2];\n" +
      'const shipped = execFileSync("tar", ["-xzOf", tgz, "package/dist/index.js"], { encoding: "utf8" });\n' +
      'appendFileSync(process.env.PUBLISH_LOG, path.basename(tgz) + " " + shipped.trim() + "\\n");\n' +
      "if (process.env.FAIL_MATCH && path.basename(tgz).includes(process.env.FAIL_MATCH)) {\n" +
      '  console.error("npm error 404 Not Found - PUT https://registry.npmjs.org/fake");\n' +
      "  process.exit(1);\n" +
      "}\n",
  );
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
}

function runScript(args, env = {}) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--work-dir", path.join(root, "work"), ...args],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: "",
        PUBLISH_LOG: path.join(root, "publish.log"),
        ...env,
      },
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function publishLog() {
  try {
    return readFileSync(path.join(root, "publish.log"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function summary(out) {
  return out
    .split("\n")
    .filter((l) => /^publish-pending summary: /.test(l))
    .map((l) => l.replace(/^publish-pending summary: /, ""));
}

let versionCommitA;
let versionCommitB;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "publish-pending-test-"));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  write(
    path.join(repo, "package.json"),
    '{ "name": "fixture-root", "private": true }\n',
  );
  write(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writePackage("packages/a", "@fx/a", "1.0.0", "a-released");
  writePackage("packages/b", "@fx/b", "2.0.0", "b-first");
  commit("initial");
  // b's version bump is its own commit, so the two packages have different version commits.
  writePackage("packages/b", "@fx/b", "2.1.0", "b-released");
  versionCommitB = commit("version b 2.1.0");
  versionCommitA = git(
    "log",
    "--format=%H",
    "-1",
    "--",
    "packages/a/package.json",
  );
  // Code that merged after both version commits, and a package.json edit that leaves the version
  // alone — neither may ship under the released versions.
  write(path.join(repo, "packages/a/src.txt"), "a-merged-later");
  write(path.join(repo, "packages/b/src.txt"), "b-merged-later");
  writePackage("packages/b", "@fx/b", "2.1.0", "b-merged-later", {
    description: "edited after the bump",
  });
  commit("merged after the version commits");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("publish-pending", () => {
  it("attempts every package when the first publish fails, names each in the summary, and exits non-zero", () => {
    const { status, out } = runScript(
      ["--publish-cmd", writeFakePublish(), "packages/a", "packages/b"],
      {
        FAIL_MATCH: "fx-a-",
      },
    );

    expect(status).toBe(1);
    expect(publishLog().map((l) => l.split(" ")[0])).toEqual([
      "fx-a-1.0.0.tgz",
      "fx-b-2.1.0.tgz",
    ]);
    const lines = summary(out);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^@fx\/a@1\.0\.0: failed at publish .*exited 1 — npm error 404 Not Found/,
    );
    expect(lines[1]).toMatch(/^@fx\/b@2\.1\.0: published/);
  }, 120_000);

  it("builds each tarball from the commit that set its version, not from HEAD", () => {
    const { status, out } = runScript([
      "--publish-cmd",
      writeFakePublish(),
      "packages/a",
      "packages/b",
    ]);

    expect(status).toBe(0);
    expect(publishLog()).toEqual([
      "fx-a-1.0.0.tgz a-released",
      "fx-b-2.1.0.tgz b-released",
    ]);
    expect(summary(out)).toEqual([
      `@fx/a@1.0.0: published (built from ${versionCommitA.slice(0, 12)})`,
      `@fx/b@2.1.0: published (built from ${versionCommitB.slice(0, 12)})`,
    ]);
    // The worktrees it built in are gone again.
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  }, 120_000);

  it("--dry-run packs every package and never runs npm", () => {
    const bin = path.join(root, "bin");
    write(
      path.join(bin, "npm"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(root, "npm-called"))}\nexit 1\n`,
    );
    chmodSync(path.join(bin, "npm"), 0o755);

    const { status, out } = runScript(
      ["--dry-run", "packages/a", "packages/b"],
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      },
    );

    expect(status).toBe(0);
    expect(summary(out)).toEqual([
      `@fx/a@1.0.0: dry-run, not published (built from ${versionCommitA.slice(0, 12)})`,
      `@fx/b@2.1.0: dry-run, not published (built from ${versionCommitB.slice(0, 12)})`,
    ]);
    expect(() => readFileSync(path.join(root, "npm-called"))).toThrow();
  }, 120_000);
});
