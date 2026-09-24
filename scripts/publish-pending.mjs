// Publish every pending workspace package, each from the commit that set its version.
//
// This exists because the inline loop it replaces stopped at the first failure: publish.yaml ran
// `for dir in $pending; do … npm publish …; done` under `bash -e`, `packages/code-graph` sorts
// before `packages/tea`, and code-graph's 404 (no trusted publisher registered) meant tea 0.18.0
// was never even attempted (#372). So every pending package gets its own attempt here, each
// outcome is recorded, one summary line per package prints at the end, and the exit is non-zero
// only after every package has been tried.
//
// Each package is built from its VERSION COMMIT — the commit that changed that package.json's
// `version` to its current value — not from HEAD. A publish that was stuck for a while
// otherwise ships whatever merged since under the old version's notes: #354/#357/#367 rode into
// 0.18.0 that way while their changesets waited for 0.19.0. The script checks the commit out into
// a detached worktree, installs, builds, runs the package's required `verify:exports` script, packs
// and publishes from there, and asserts the worktree's HEAD is that commit before it packs. A package
// that declares no `verify:exports` fails at that stage; the gate is never skipped.
//
// Which packages are pending is NOT decided here: publish.yaml's version gate passes them in.
//
// Run:  node scripts/publish-pending.mjs [--dry-run] [--publish-cmd <cmd>] [--work-dir <dir>] <dir>...
//   --dry-run        everything up to and including the pack; the publish is printed, not run.
//   --publish-cmd    run `<cmd> <tarball>` through the shell instead of `npm publish`. For tests.
//   --work-dir       where worktrees and tarballs go (default: a fresh temp directory).

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Run a command, echoing its output, and return the exit status and the output it produced. */
function run(cmd, args, { cwd, shell = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    shell,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const status = r.error ? null : r.status;
  return {
    ok: status === 0,
    status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

/** One step's failure, carrying the stage it happened in and the line worth reading. */
class StepFailure extends Error {
  constructor(stage, detail) {
    super(`${stage}: ${detail}`);
    this.stage = stage;
    this.detail = detail;
  }
}

function must(stage, result, what) {
  if (result.ok) return result;
  if (result.error)
    throw new StepFailure(
      stage,
      `${what} could not start: ${result.error.message}`,
    );
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = lines.find((l) => /^npm error /.test(l)) ?? lines.at(-1);
  throw new StepFailure(
    stage,
    `${what} exited ${result.status}${errLine ? ` — ${errLine}` : ""}`,
  );
}

function git(repo, args) {
  return run("git", args, { cwd: repo });
}

/** `version` of `<dir>/package.json` at `rev`, or `undefined` where the file does not exist. */
function versionAt(repo, rev, dir) {
  const r = spawnSync("git", ["show", `${rev}:${dir}/package.json`], {
    cwd: repo,
    encoding: "utf8",
  });
  if (r.status !== 0) return undefined;
  return JSON.parse(r.stdout).version;
}

/**
 * The commit that set `<dir>/package.json`'s current `version`: walking that file's history back
 * from HEAD, the oldest commit of the unbroken run that still carries the current version.
 */
export function versionCommit(repo, dir) {
  // A shallow history can end inside the run of commits carrying the current version, and the
  // walk would then name a later commit as the version commit. Refuse rather than guess.
  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: repo,
    encoding: "utf8",
  });
  if (shallow.status !== 0 || shallow.stdout.trim() !== "false")
    throw new StepFailure(
      "version-commit",
      "the clone is shallow (or its depth is unreadable); fetch full history (fetch-depth: 0)",
    );
  const current = versionAt(repo, "HEAD", dir);
  if (current === undefined)
    throw new StepFailure(
      "version-commit",
      `${dir}/package.json is not in HEAD`,
    );
  const log = spawnSync(
    "git",
    ["log", "--format=%H", "HEAD", "--", `${dir}/package.json`],
    {
      cwd: repo,
      encoding: "utf8",
    },
  );
  if (log.status !== 0)
    throw new StepFailure("version-commit", `git log exited ${log.status}`);
  let found;
  for (const sha of log.stdout.split("\n").filter(Boolean)) {
    if (versionAt(repo, sha, dir) !== current) break;
    found = sha;
  }
  if (found === undefined)
    throw new StepFailure(
      "version-commit",
      `no commit sets ${dir} to ${current}`,
    );
  return found;
}

/**
 * Attempt every pending package; never stop at a failure. Returns one row per package, in the
 * order given: `{ dir, name, version, commit, outcome }`, where `outcome` is
 * `{ kind: "published" }`, `{ kind: "dry-run", tarball }` or `{ kind: "failed", stage, detail }`.
 */
export function publishPending({
  repo,
  pending,
  workDir,
  dryRun = false,
  publishCmd,
}) {
  const trees = new Map();
  const rows = [];
  try {
    for (const dir of pending) {
      const row = {
        dir,
        name: dir,
        version: "?",
        commit: undefined,
        outcome: undefined,
      };
      rows.push(row);
      console.log(`\n::group::publish-pending: ${dir}`);
      try {
        const pkg = JSON.parse(
          readFileSync(path.join(repo, dir, "package.json"), "utf8"),
        );
        row.name = pkg.name;
        row.version = pkg.version;
        row.commit = versionCommit(repo, dir);
        console.log(
          `publish-pending: ${row.name}@${row.version} — version commit ${row.commit}`,
        );

        let tree = trees.get(row.commit);
        if (tree === undefined) {
          tree = path.join(workDir, "src", row.commit.slice(0, 12));
          must(
            "checkout",
            git(repo, ["worktree", "add", "--detach", tree, row.commit]),
            "git worktree add",
          );
          trees.set(row.commit, tree);
          must(
            "install",
            run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: tree }),
            "pnpm install",
          );
        }
        const head = must(
          "checkout",
          git(tree, ["rev-parse", "HEAD"]),
          "git rev-parse",
        ).stdout.trim();
        if (head !== row.commit)
          throw new StepFailure(
            "checkout",
            `worktree is at ${head}, not ${row.commit}`,
          );
        const pkgDir = path.join(tree, dir);
        const built = JSON.parse(
          readFileSync(path.join(pkgDir, "package.json"), "utf8"),
        );
        if (built.name !== row.name || built.version !== row.version) {
          throw new StepFailure(
            "checkout",
            `${row.commit} carries ${built.name}@${built.version}`,
          );
        }

        must(
          "build",
          run("pnpm", ["--filter", `${row.name}...`, "run", "build"], {
            cwd: tree,
          }),
          "build",
        );
        // Every published package declares `verify:exports`; a missing one fails the package
        // rather than skipping the gate, so a moved or deleted script cannot ship unverified.
        if (typeof built.scripts?.["verify:exports"] !== "string") {
          throw new StepFailure(
            "verify-exports",
            `${row.name} declares no "verify:exports" script`,
          );
        }
        must(
          "verify-exports",
          run("pnpm", ["run", "verify:exports"], { cwd: pkgDir }),
          "verify-exports",
        );

        const out = path.join(workDir, "pack", path.basename(dir));
        mkdirSync(out, { recursive: true });
        must(
          "pack",
          run("pnpm", ["pack", "--pack-destination", out], { cwd: pkgDir }),
          "pnpm pack",
        );
        const tarballs = readdirSync(out).filter((f) => f.endsWith(".tgz"));
        if (tarballs.length !== 1)
          throw new StepFailure(
            "pack",
            `expected one tarball in ${out}, found ${tarballs.length}`,
          );
        const tarball = path.join(out, tarballs[0]);

        if (dryRun) {
          console.log(
            `publish-pending: dry run — would run: npm publish ${tarball} --access public`,
          );
          row.outcome = { kind: "dry-run", tarball };
        } else if (publishCmd !== undefined) {
          must(
            "publish",
            run(`${publishCmd} ${JSON.stringify(tarball)}`, [], {
              shell: true,
            }),
            "publish command",
          );
          row.outcome = { kind: "published" };
        } else {
          must(
            "publish",
            run("npm", ["publish", tarball, "--access", "public"]),
            "npm publish",
          );
          row.outcome = { kind: "published" };
        }
      } catch (e) {
        row.outcome =
          e instanceof StepFailure
            ? { kind: "failed", stage: e.stage, detail: e.detail }
            : {
                kind: "failed",
                stage: "internal",
                detail: String(e?.message ?? e),
              };
      }
      console.log("::endgroup::");
    }
  } finally {
    for (const tree of trees.values())
      git(repo, ["worktree", "remove", "--force", tree]);
  }
  return rows;
}

/** One summary line per package. */
export function summaryLine({ name, version, commit, outcome }) {
  const at = commit ? ` (built from ${commit.slice(0, 12)})` : "";
  switch (outcome.kind) {
    case "published":
      return `${name}@${version}: published${at}`;
    case "dry-run":
      return `${name}@${version}: dry-run, not published${at}`;
    case "failed":
      return `${name}@${version}: failed at ${outcome.stage}${at} — ${outcome.detail}`;
  }
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    publishCmd: undefined,
    workDir: undefined,
    pending: [],
  };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--"))
      throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--publish-cmd") opts.publishCmd = value(++i, a);
    else if (a === "--work-dir") opts.workDir = value(++i, a);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else opts.pending.push(a.replace(/\/+$/, ""));
  }
  if (opts.dryRun && opts.publishCmd !== undefined)
    throw new Error("--dry-run and --publish-cmd are exclusive");
  return opts;
}

function main() {
  const repo = process.cwd();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.pending.length === 0) {
    console.log("publish-pending: nothing pending.");
    return 0;
  }
  const workDir = path.resolve(
    opts.workDir ?? mkdtempSync(path.join(tmpdir(), "publish-pending-")),
  );
  mkdirSync(workDir, { recursive: true });
  const rows = publishPending({
    repo,
    pending: opts.pending,
    workDir,
    dryRun: opts.dryRun,
    publishCmd: opts.publishCmd,
  });

  const lines = rows.map(summaryLine);
  console.log(`\npublish-pending: ${rows.length} package(s) attempted`);
  for (const line of lines) console.log(`publish-pending summary: ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Publish\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`,
    );
  }
  const failed = rows.filter((r) => r.outcome.kind === "failed");
  if (failed.length > 0) {
    for (const r of failed) console.log(`::error::${summaryLine(r)}`);
    return 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
