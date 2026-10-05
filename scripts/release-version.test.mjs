// scripts/release-version.mjs over planted workspaces: the ignore set it computes, what it prints,
// and the refusals that run nothing (#583). The CLI runs with a recording stand-in for
// `changeset version`, so no package is versioned here.

import { spawnSync } from "node:child_process";
import {
  existsSync,
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
import {
  changesetPackages,
  planRelease,
  readChangesets,
  readWorkspace,
} from "./release-version.mjs";

const SCRIPT = fileURLToPath(new URL("./release-version.mjs", import.meta.url));

let repo;

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function pkg(dir, name, extra = {}) {
  write(
    path.join(repo, "packages", dir, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0", ...extra }, null, 2)}\n`,
  );
}

function changeset(file, bumps) {
  const lines = Object.entries(bumps).map(([n, b]) => `"${n}": ${b}`);
  write(
    path.join(repo, ".changeset", file),
    `---\n${lines.join("\n")}\n---\n\nA change.\n`,
  );
}

/**
 * Five packages with a two-level runtime chain: base ← mid ← top, plus a dev-only dependent of
 * base (devonly) and a standalone package (solo). mid depends on base at runtime, top on mid.
 */
function plantChain() {
  pkg("base", "@w/base");
  pkg("mid", "@w/mid", { dependencies: { "@w/base": "workspace:*" } });
  pkg("top", "@w/top", { peerDependencies: { "@w/mid": "workspace:*" } });
  pkg("devonly", "@w/devonly", {
    devDependencies: { "@w/base": "workspace:*" },
  });
  pkg("solo", "@w/solo");
}

function plan(target) {
  return planRelease({
    packages: readWorkspace(repo),
    changesets: readChangesets(repo),
    target,
  });
}

function runCli(target) {
  const log = path.join(repo, "changeset.log");
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--changeset-cmd", `node record.mjs`, target],
    { cwd: repo, encoding: "utf8" },
  );
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    calls: existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "release-version-"));
  write(path.join(repo, ".changeset", "README.md"), "# Changesets\n");
  // Records its argv and exits with $EXIT_WITH (default 0).
  write(
    path.join(repo, "record.mjs"),
    'import { appendFileSync } from "node:fs";\n' +
      'appendFileSync("changeset.log", process.argv.slice(2).join(" ") + "\\n");\n' +
      "process.exit(Number(process.env.EXIT_WITH ?? 0));\n",
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("changesetPackages", () => {
  it("reads quoted and unquoted names from the front matter only", () => {
    const text =
      '---\n"@a/x": minor\n\'@a/y\': patch\n@a/z: major\n---\n\n"@a/body": patch\n';
    expect(changesetPackages(text)).toEqual(["@a/x", "@a/y", "@a/z"]);
  });
});

describe("planRelease", () => {
  it("closes the ignore set under runtime dependents across two levels", () => {
    plantChain();
    changeset("a.md", { "@w/base": "minor" });
    changeset("b.md", { "@w/solo": "patch" });
    changeset("c.md", { "@w/solo": "minor" });

    expect(plan("@w/solo")).toEqual({
      kind: "run",
      ignored: [
        { name: "@w/base", reason: { kind: "own-changeset" } },
        { name: "@w/mid", reason: { kind: "dependent", of: "@w/base" } },
        { name: "@w/top", reason: { kind: "dependent", of: "@w/mid" } },
      ],
    });
  });

  it("leaves out packages with no pending changeset and dev-only dependents", () => {
    plantChain();
    changeset("a.md", { "@w/base": "minor" });
    changeset("b.md", { "@w/top": "patch" });

    // base is the target, so nothing forces mid out; top has its own changeset.
    expect(plan("@w/base")).toEqual({
      kind: "run",
      ignored: [{ name: "@w/top", reason: { kind: "own-changeset" } }],
    });
  });

  it("skips private dependents, as changesets does", () => {
    plantChain();
    pkg("app", "@w/app", {
      private: true,
      dependencies: { "@w/solo": "workspace:*" },
    });
    changeset("a.md", { "@w/solo": "minor" });
    changeset("b.md", { "@w/base": "minor" });

    expect(plan("@w/base").ignored).toEqual([
      { name: "@w/solo", reason: { kind: "own-changeset" } },
    ]);
  });

  it("refuses a target that a held package forces out", () => {
    plantChain();
    changeset("a.md", { "@w/base": "minor" });
    changeset("b.md", { "@w/top": "patch" });

    const result = plan("@w/top");
    expect(result.kind).toBe("refuse");
    expect(result.message).toContain("@w/top depends on @w/mid");
  });
});

describe("the CLI", () => {
  it("prints each ignored package and why, then runs changeset version with one --ignore each", () => {
    plantChain();
    changeset("a.md", { "@w/base": "minor" });
    changeset("b.md", { "@w/solo": "patch" });

    const r = runCli("@w/solo");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("@w/base — its own pending changeset");
    expect(r.stdout).toContain("@w/mid — depends on @w/base");
    expect(r.stdout).toContain("@w/top — depends on @w/mid");
    expect(r.calls).toBe(
      "version --ignore @w/base --ignore @w/mid --ignore @w/top\n",
    );
  });

  it("exits with changeset's own exit code", () => {
    plantChain();
    changeset("b.md", { "@w/solo": "patch" });

    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--changeset-cmd", "node record.mjs", "@w/solo"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, EXIT_WITH: "3" } },
    );
    expect(r.status).toBe(3);
  });

  it("refuses an unknown target, naming the valid names, and runs nothing", () => {
    plantChain();
    changeset("b.md", { "@w/solo": "patch" });

    const r = runCli("@w/nope");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      "Valid names: @w/base, @w/devonly, @w/mid, @w/solo, @w/top.",
    );
    expect(r.calls).toBe("");
  });

  it("refuses a target with nothing pending and runs nothing", () => {
    plantChain();
    changeset("a.md", { "@w/base": "minor" });

    const r = runCli("@w/solo");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("@w/solo has nothing pending");
    expect(r.calls).toBe("");
  });

  it("refuses a changeset that names the target and a held package, naming the file", () => {
    plantChain();
    changeset("a.md", { "@w/base": "minor" });
    changeset("mixed.md", { "@w/solo": "patch", "@w/base": "patch" });

    const r = runCli("@w/solo");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      `${path.join(".changeset", "mixed.md")} names @w/solo and @w/base`,
    );
    expect(r.calls).toBe("");
  });
});
