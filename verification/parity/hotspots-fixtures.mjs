import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./hotspots-cases.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function snapshot(root) {
  const result = {};
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === ".git") continue;
      const file = path.join(directory, entry.name),
        relative = path.relative(root, file);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const data = fs.readFileSync(file);
        result[relative] = {
          sha256: hash(data),
          bytes: data.length,
          mode: fs.statSync(file).mode & 0o777,
        };
      } else if (entry.isSymbolicLink())
        result[relative] = { symlink: fs.readlinkSync(file) };
    }
  }
  visit(root);
  return result;
}
export function prepare(parent) {
  fs.mkdirSync(parent, { recursive: true });
  const repo = path.join(parent, "repository"),
    nohead = path.join(parent, "no-head"),
    nonrepo = path.join(parent, "nonrepo"),
    controlled = path.join(parent, "controlled");
  for (const dir of [
    repo,
    nohead,
    nonrepo,
    path.join(controlled, "sub"),
    path.join(parent, "bin"),
  ])
    fs.mkdirSync(dir, { recursive: true });
  const setup = [];
  function git(cwd, args, date) {
    const env = {
      ...process.env,
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    };
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    setup.push({
      cwd,
      args,
      exit: result.status,
      error: result.error?.message ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
      dates: date ?? null,
      identityOverride: false,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  git(repo, ["init", "-q", "--initial-branch=hotspots-fixture"]);
  git(nohead, ["init", "-q", "--initial-branch=hotspots-fixture"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.mkdirSync(path.join(repo, "notes"));
  for (const [file, text] of Object.entries({
    "src/hot.ts": "export function hot(x:number){if(x>0)return 1;return 0;}\n",
    "src/cold.ts": "export function cold(){return 2;}\n",
    "src/zero.ts": "export function zero(){return 3;}\n",
    "notes/é.txt": "unicode note\n",
    "notes/  spaced.txt  ": "space note\n",
    "notes/line\nbreak.txt": "newline note\n",
  }))
    fs.writeFileSync(path.join(repo, file), text);
  git(repo, ["add", "."]);
  git(
    repo,
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "-m",
      "initial",
    ],
    "2020-01-01T00:00:00Z",
  );
  for (const [day, text] of [
    [2, "export function hot(x:number){if(x>1)return 4;return 0;}\n"],
    [3, "export function hot(x:number){if(x>2)return 5;return 0;}\n"],
  ]) {
    fs.writeFileSync(path.join(repo, "src/hot.ts"), text);
    git(repo, ["add", "src/hot.ts"]);
    git(
      repo,
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-q",
        "-m",
        `hot${day}`,
      ],
      `2020-01-0${day}T00:00:00Z`,
    );
  }
  fs.writeFileSync(
    path.join(repo, "src/untracked.ts"),
    "export function newlyCreated(){return 9;}\n",
  );
  const symlink = path.join(parent, "repository-link");
  fs.symlinkSync(repo, symlink);
  const fake = path.join(parent, "bin/git");
  fs.symlinkSync(path.join(here, "hotspots-git-fixture.py"), fake);
  const roots = {
    repo,
    subdir: path.join(repo, "src"),
    symlink,
    missing: path.join(parent, "missing"),
    nonrepo,
    nohead,
    controlled: path.join(controlled, "sub"),
  };
  const inputs = cases.map((row) =>
    row.mode !== "load"
      ? row
      : {
          ...row,
          root: roots[row.rootRole],
          queries:
            row.rootRole === "subdir"
              ? ["hot.ts", "cold.ts", "zero.ts", "untracked.ts"]
              : row.rootRole === "controlled"
                ? [
                    "sub/alpha.ts",
                    "alpha.ts",
                    "zero.ts",
                    "  spaced.ts  ",
                    "spaced.ts",
                    '"quoted\\n.ts"',
                    '"\\303\\251.ts"',
                    "untracked.ts",
                  ]
                : [
                    "src/hot.ts",
                    "src/cold.ts",
                    "src/zero.ts",
                    "src/untracked.ts",
                    "notes/é.txt",
                    "notes/line\nbreak.txt",
                    "notes/  spaced.txt  ",
                  ],
        },
  );
  return {
    parent,
    repo,
    controlled,
    inputs,
    setup,
    identityOverrides: false,
    before: snapshot(repo),
  };
}
export function processEnvironment(fixture, input, receipt, side) {
  const env = { ...process.env };
  if (input.controlled) {
    const plan = path.join(fixture.parent, `${input.id}.${side}.plan.json`);
    fs.writeFileSync(
      plan,
      JSON.stringify({
        ...input.controlled,
        repoRoot: fixture.controlled,
        prefix: "sub/",
      }),
    );
    env.PATH = path.join(fixture.parent, "bin") + path.delimiter + env.PATH;
    env.DEMLIK_HOTSPOTS_GIT_PLAN = plan;
    env.DEMLIK_HOTSPOTS_GIT_RECEIPT = receipt;
  }
  return env;
}
export function receiptView(receipt) {
  const records = fs.existsSync(receipt)
    ? fs
        .readFileSync(receipt, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const starts = records.filter((r) => r.event === "start");
  const childState = starts.map((r) => {
    let alive = false;
    try {
      process.kill(r.pid, 0);
      alive = true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    return { pid: r.pid, alive };
  });
  assert.ok(
    childState.every((r) => !r.alive),
    "all controlled Git children exited and were reaped",
  );
  return {
    records,
    attempts: starts.map(({ phase, args, cwd }) => ({ phase, args, cwd })),
    children: childState,
    allExited: true,
  };
}
