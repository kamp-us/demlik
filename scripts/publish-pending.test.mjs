// Runs scripts/publish-pending.mjs as publish.yaml does, over a throwaway two-package repo, with an
// injected publish command in place of `npm publish` and an injected lookup command in place of
// `npm view` — so no registry is ever called (#372, #587), and no read waits between attempts.

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
    `${JSON.stringify({ name, version, files: ["dist"], scripts: { build: "node build.mjs", "verify:exports": "node -e 0" }, ...extra }, null, 2)}\n`,
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

function runScript(args, env = {}, cwd = repo) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--work-dir", path.join(root, "work"), ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: "",
        PUBLISH_LOG: path.join(root, "publish.log"),
        REGISTRY_FILE: path.join(root, "registry.json"),
        REGISTRY_LOG: path.join(root, "registry.log"),
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

/**
 * A registry stand-in, split in two the way the script splits it: `publish <tarball>` and
 * `lookup <name>@<version>`. Its records persist in `registry.json`, so they outlive each script
 * run the way npm's do: `publish` stores the tarball's SRI sha512 and refuses what it already
 * holds with npm's own wording (or with `refuses[spec]` when the file names one), and `lookup`
 * prints that integrity, but answers nothing for its first `$LOOKUP_LAG` reads of a version, as a
 * cached packument does. Both append to the one `registry.log`, so the order of calls is visible.
 */
function writeFakeRegistry() {
  const file = path.join(root, "fake-registry.mjs");
  write(
    file,
    'import { execFileSync } from "node:child_process";\n' +
      'import { createHash } from "node:crypto";\n' +
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";\n' +
      "const [, , command, arg] = process.argv;\n" +
      "const { REGISTRY_FILE, REGISTRY_LOG } = process.env;\n" +
      "const state = existsSync(REGISTRY_FILE)\n" +
      "  ? JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))\n" +
      "  : { records: {}, refuses: {}, reads: {} };\n" +
      "const save = () => writeFileSync(REGISTRY_FILE, JSON.stringify(state));\n" +
      "const log = (line) => appendFileSync(REGISTRY_LOG, line + '\\n');\n" +
      "if (command === 'publish') {\n" +
      "  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', arg, 'package/package.json'], { encoding: 'utf8' }));\n" +
      "  const spec = manifest.name + '@' + manifest.version;\n" +
      "  log('publish ' + spec);\n" +
      "  if (state.refuses[spec]) {\n" +
      "    console.error(state.refuses[spec]);\n" +
      "    process.exit(1);\n" +
      "  }\n" +
      "  if (state.records[spec]) {\n" +
      "    console.error('npm error You cannot publish over the previously published versions: ' + manifest.version + '.');\n" +
      "    process.exit(1);\n" +
      "  }\n" +
      "  state.records[spec] = 'sha512-' + createHash('sha512').update(readFileSync(arg)).digest('base64');\n" +
      "  save();\n" +
      "} else {\n" +
      "  log('lookup ' + arg);\n" +
      "  state.reads[arg] = (state.reads[arg] ?? 0) + 1;\n" +
      "  save();\n" +
      "  if (state.reads[arg] > Number(process.env.LOOKUP_LAG ?? 0) && state.records[arg]) {\n" +
      "    console.log(state.records[arg]);\n" +
      "  } else {\n" +
      "    console.error('npm error code E404');\n" +
      "    process.exit(1);\n" +
      "  }\n" +
      "}\n",
  );
  const node = `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
  return { publishCmd: `${node} publish`, lookupCmd: `${node} lookup` };
}

/** Run the script over `dirs` against the fake registry, taking `attempts` reads with no wait between. */
function publishVia(fake, dirs, { attempts = 3, env } = {}) {
  return runScript(
    [
      "--publish-cmd",
      fake.publishCmd,
      "--lookup-cmd",
      fake.lookupCmd,
      "--lookup-attempts",
      String(attempts),
      "--lookup-interval",
      "0",
      ...dirs,
    ],
    env,
  );
}

function registry() {
  return JSON.parse(readFileSync(path.join(root, "registry.json"), "utf8"));
}

function registryLog() {
  try {
    return readFileSync(path.join(root, "registry.log"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Two more packages sharing one version commit, which with a and b make the realistic N > 2 fixture. */
function addPackagesCAndD() {
  writePackage("packages/c", "@fx/c", "3.0.0", "c-released");
  writePackage("packages/d", "@fx/d", "4.0.0", "d-released");
  return commit("add c and d");
}

/** An integrity no tarball here packs to: npm "holding different bytes". */
const OTHER_BYTES = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

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

describe("publish-pending", { timeout: 120_000 }, () => {
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
  });

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
  });

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
  });

  it("fails a package that declares no verify:exports script instead of skipping the gate, and still attempts the rest", () => {
    // a's next version drops the script; its version commit is the one that carries no gate.
    writePackage("packages/a", "@fx/a", "1.1.0", "a-no-gate", {
      scripts: { build: "node build.mjs" },
    });
    commit("version a 1.1.0 without verify:exports");

    const { status, out } = runScript([
      "--publish-cmd",
      writeFakePublish(),
      "packages/a",
      "packages/b",
    ]);

    expect(status).toBe(1);
    const lines = summary(out);
    expect(lines[0]).toMatch(
      /^@fx\/a@1\.1\.0: failed at verify-exports .*declares no "verify:exports" script/,
    );
    expect(lines[1]).toMatch(/^@fx\/b@2\.1\.0: published/);
    expect(publishLog().map((l) => l.split(" ")[0])).toEqual([
      "fx-b-2.1.0.tgz",
    ]);
  });

  it("refuses to name a version commit from a shallow clone", () => {
    const shallow = path.join(root, "shallow");
    const r = spawnSync(
      "git",
      ["clone", "-q", "--depth", "1", `file://${repo}`, shallow],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);

    const { status, out } = runScript(
      ["--dry-run", "packages/a", "packages/b"],
      {},
      shallow,
    );

    expect(status).toBe(1);
    const lines = summary(out);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/failed at version-commit .*shallow/);
    }
  });

  it("stays green when npm already holds the tarball it just packed, and goes red naming both hashes when npm holds other bytes", () => {
    const versionCommitCD = addPackagesCAndD();
    const fake = writeFakeRegistry();
    const abc = ["packages/a", "packages/b", "packages/c"];
    const stepSummary = path.join(root, "step-summary.md");

    // Run 1: nothing is on npm yet.
    const first = publishVia(fake, abc);
    expect(first.status).toBe(0);
    expect(summary(first.out).map((l) => l.replace(/ \(built.*/, ""))).toEqual([
      "@fx/a@1.0.0: published",
      "@fx/b@2.1.0: published",
      "@fx/c@3.0.0: published",
    ]);
    const records = registry().records;

    // Run 2: the stale "not on npm" list hands over the same three again.
    const second = publishVia(fake, abc, {
      env: { GITHUB_STEP_SUMMARY: stepSummary },
    });
    expect(second.status).toBe(0);
    expect(registry().records).toEqual(records);
    const lines = summary(second.out);
    expect(lines).toEqual([
      `@fx/a@1.0.0: already published, npm holds the same tarball (${records["@fx/a@1.0.0"]}) (built from ${versionCommitA.slice(0, 12)})`,
      `@fx/b@2.1.0: already published, npm holds the same tarball (${records["@fx/b@2.1.0"]}) (built from ${versionCommitB.slice(0, 12)})`,
      `@fx/c@3.0.0: already published, npm holds the same tarball (${records["@fx/c@3.0.0"]}) (built from ${versionCommitCD.slice(0, 12)})`,
    ]);
    expect(second.out).not.toMatch(/: failed at |::error::/);
    expect(readFileSync(stepSummary, "utf8")).toBe(
      `### Publish\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`,
    );

    // Runs 3 and 4 do not drift, and a package npm lacks is still published beside the held ones.
    for (const again of [publishVia(fake, abc), publishVia(fake, abc)]) {
      expect(again.status).toBe(0);
      expect(summary(again.out)).toEqual(lines);
    }
    const withD = publishVia(fake, [...abc, "packages/d"]);
    expect(withD.status).toBe(0);
    expect(summary(withD.out).slice(0, 3)).toEqual(lines);
    expect(summary(withD.out)[3]).toMatch(/^@fx\/d@4\.0\.0: published/);

    // Run 5: npm now holds other bytes for c.
    const state = registry();
    state.records["@fx/c@3.0.0"] = OTHER_BYTES;
    writeFileSync(path.join(root, "registry.json"), JSON.stringify(state));
    rmSync(path.join(root, "registry.log"));
    const red = publishVia(fake, abc);
    expect(red.status).toBe(1);
    const redLines = summary(red.out);
    expect(redLines.slice(0, 2)).toEqual(lines.slice(0, 2));
    expect(redLines[2]).toMatch(/^@fx\/c@3\.0\.0: failed at publish /);
    expect(redLines[2]).toContain(OTHER_BYTES);
    expect(redLines[2]).toContain(records["@fx/c@3.0.0"]);
    expect(red.out.match(/^::error::/gm)).toHaveLength(1);
    expect(registryLog().filter((l) => l.startsWith("publish "))).toEqual([
      "publish @fx/a@1.0.0",
      "publish @fx/b@2.1.0",
      "publish @fx/c@3.0.0",
    ]);
  });

  it("waits out a registry read that lags the conflict, and never holds another package up while it does", () => {
    const fake = writeFakeRegistry();
    expect(publishVia(fake, ["packages/a"]).status).toBe(0);
    rmSync(path.join(root, "registry.log"));

    // a is already on npm but the read answers nothing for its first two lookups; b is new.
    const { status, out } = publishVia(fake, ["packages/a", "packages/b"], {
      attempts: 4,
      env: { LOOKUP_LAG: "2" },
    });

    expect(status).toBe(0);
    expect(summary(out).map((l) => l.replace(/ \(.*/, ""))).toEqual([
      "@fx/a@1.0.0: already published, npm holds the same tarball",
      "@fx/b@2.1.0: published",
    ]);
    expect(registryLog()).toEqual([
      "publish @fx/a@1.0.0",
      "publish @fx/b@2.1.0",
      "lookup @fx/a@1.0.0",
      "lookup @fx/a@1.0.0",
      "lookup @fx/a@1.0.0",
    ]);
  });

  it("fails a package whose conflict npm never backs with an integrity, after exactly the reads it was given", () => {
    const fake = writeFakeRegistry();
    expect(publishVia(fake, ["packages/a"]).status).toBe(0);
    rmSync(path.join(root, "registry.log"));

    const { status, out } = publishVia(fake, ["packages/a"], {
      attempts: 3,
      env: { LOOKUP_LAG: "99" },
    });

    expect(status).toBe(1);
    expect(summary(out)).toHaveLength(1);
    expect(summary(out)[0]).toMatch(
      /^@fx\/a@1\.0\.0: failed at publish .*npm reported the version as existing but returned no integrity/,
    );
    expect(registryLog().filter((l) => l.startsWith("lookup "))).toHaveLength(
      3,
    );
  });

  it("opens the registry lookup only for the registry's own conflict wording", () => {
    addPackagesCAndD();
    const fake = writeFakeRegistry();
    const wordings = [
      [
        "@fx/a@1.0.0",
        "npm error You cannot publish over the previously published versions: 1.0.0.",
      ],
      [
        "@fx/b@2.1.0",
        "npm error You cannot publish over the previously published version 2.1.0",
      ],
      ["@fx/c@3.0.0", "npm error Cannot publish over existing version"],
      [
        "@fx/d@4.0.0",
        "npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/@fx%2fd - You do not have permission to publish",
      ],
    ];
    writeFileSync(
      path.join(root, "registry.json"),
      JSON.stringify({
        records: Object.fromEntries(
          wordings.map(([spec]) => [spec, OTHER_BYTES]),
        ),
        refuses: Object.fromEntries(wordings),
        reads: {},
      }),
    );

    const { status, out } = publishVia(fake, [
      "packages/a",
      "packages/b",
      "packages/c",
      "packages/d",
    ]);

    expect(status).toBe(1);
    expect(registryLog().filter((l) => l.startsWith("lookup "))).toEqual([
      "lookup @fx/a@1.0.0",
      "lookup @fx/b@2.1.0",
      "lookup @fx/c@3.0.0",
    ]);
    expect(summary(out)[3]).toMatch(
      /^@fx\/d@4\.0\.0: failed at publish .*exited 1 — npm error code E403/,
    );
  });
});
