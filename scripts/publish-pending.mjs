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
// Which packages are pending is NOT decided here: publish.yaml's version gate passes them in, and
// that gate reads npm's packument, which can trail the registry's own write by minutes. A run that
// follows another by a few minutes can be handed a version the first one just published, and npm
// refuses it with "You cannot publish over the previously published versions". Where the registry
// reports that, the refusal is a question, not a verdict. Once every package has had its publish
// attempt, each refused one is settled by reading npm's `dist.integrity` for that exact version and
// comparing it with the SRI sha512 of the tarball this run packed. When npm already holds the same
// tarball the package is `already-published`, a green outcome; npm holding other bytes, or giving no
// integrity within the read budget, is `failed`.
//
// Run:  node scripts/publish-pending.mjs [--dry-run] [--publish-cmd <cmd>] [--work-dir <dir>]
//         [--lookup-cmd <cmd>] [--lookup-attempts <n>] [--lookup-interval <seconds>] <dir>...
//   --dry-run          everything up to and including the pack; the publish is printed, not run.
//   --publish-cmd      run `<cmd> <tarball>` through the shell instead of `npm publish`. For tests.
//   --work-dir         where worktrees and tarballs go (default: a fresh temp directory).
//   --lookup-cmd       run `<cmd> <name>@<version>` through the shell instead of
//                      `npm view <name>@<version> dist.integrity`; it prints the integrity, or
//                      nothing. For tests.
//   --lookup-attempts  reads of the registry per refused package (default 22).
//   --lookup-interval  seconds between those reads (default 15). The default budget waits
//                      (22 - 1) x 15 = 315 s, past the 300 s `max-age` npm serves a packument with.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** Run a command, echoing its output unless `echo` is off, and return its exit status and output. */
function run(cmd, args, { cwd, shell = false, echo = true } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    shell,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (echo && r.stdout) process.stdout.write(r.stdout);
  if (echo && r.stderr) process.stderr.write(r.stderr);
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

/** What the registry says when it already holds the version: npmjs.org's wording, then npm's own. */
const PUBLISH_CONFLICT =
  /cannot publish over (?:the previously published versions?|existing version)/i;

/** The shape of `dist.integrity`: an SRI sha512. */
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/** How a refused package is settled: the lookup command (default `npm view`), reads, seconds apart. */
const DEFAULT_LOOKUP = {
  cmd: undefined,
  attempts: 22,
  intervalSeconds: 15,
};

/** A failed publish the registry itself reports as a duplicate of a version it holds. */
function isPublishConflict(result) {
  return (
    !result.ok &&
    !result.error &&
    PUBLISH_CONFLICT.test(`${result.stderr}\n${result.stdout}`)
  );
}

/** The SRI sha512 of a tarball, as npm reports it: the file's bytes, never unpacked or normalised. */
function integrityOf(tarball) {
  return `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
}

function sleep(seconds) {
  if (seconds > 0)
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      seconds * 1000,
    );
}

/** npm's `dist.integrity` for `spec`, or `undefined` while it answers nothing usable. */
function registryIntegrity(spec, cmd) {
  const r =
    cmd === undefined
      ? run("npm", ["view", spec, "dist.integrity"], { echo: false })
      : run(`${cmd} ${JSON.stringify(spec)}`, [], { shell: true, echo: false });
  const answer = r.stdout.trim();
  return r.ok && SRI_SHA512.test(answer) ? answer : undefined;
}

/**
 * The outcome of a package the registry refused as already published: `already-published` when npm
 * holds exactly the tarball this run packed, `failed` when it holds other bytes or answers no
 * integrity within `lookup.attempts` reads. The read that follows a conflict is the one that can
 * lag the conflict itself, since npm serves a packument for up to five minutes, so it is retried
 * here and nowhere else.
 */
function settleConflict({ spec, packed, lookup }) {
  for (let read = 1; read <= lookup.attempts; read++) {
    const held = registryIntegrity(spec, lookup.cmd);
    if (held === packed) return { kind: "already-published", integrity: held };
    if (held !== undefined)
      return {
        kind: "failed",
        stage: "publish",
        detail: `npm holds a different tarball for ${spec}: npm has ${held}, this run packed ${packed}`,
      };
    console.log(
      `publish-pending: ${spec} — npm answered no integrity yet (read ${read} of ${lookup.attempts})`,
    );
    if (read < lookup.attempts) sleep(lookup.intervalSeconds);
  }
  return {
    kind: "failed",
    stage: "publish",
    detail: `npm reported the version as existing but returned no integrity (${lookup.attempts} reads, ${lookup.intervalSeconds}s apart)`,
  };
}

/**
 * Attempt every pending package; never stop at a failure. Returns one row per package, in the
 * order given: `{ dir, name, version, commit, outcome }`, where `outcome` is
 * `{ kind: "published" }`, `{ kind: "already-published", integrity }` (npm refused the publish
 * because it already holds that version, and the integrity it reports is the tarball just packed),
 * `{ kind: "dry-run", tarball }` or `{ kind: "failed", stage, detail }`. Only `failed` is a
 * failure: it is every other refusal, npm holding different bytes (both hashes named), and npm
 * giving no integrity within the read budget. A package npm refused as a duplicate is settled once
 * every package has had its attempt, so one waiting on npm never holds up another.
 */
export function publishPending({
  repo,
  pending,
  workDir,
  dryRun = false,
  publishCmd,
  lookup = DEFAULT_LOOKUP,
}) {
  const trees = new Map();
  const rows = [];
  const refused = [];
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
        } else {
          const publish =
            publishCmd !== undefined
              ? run(`${publishCmd} ${JSON.stringify(tarball)}`, [], {
                  shell: true,
                })
              : run("npm", ["publish", tarball, "--access", "public"]);
          if (isPublishConflict(publish)) {
            console.log(
              `publish-pending: ${row.name}@${row.version} — npm already holds this version; settling it once every package has been attempted.`,
            );
            refused.push({ row, packed: integrityOf(tarball) });
          } else {
            must(
              "publish",
              publish,
              publishCmd !== undefined ? "publish command" : "npm publish",
            );
            row.outcome = { kind: "published" };
          }
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
  for (const { row, packed } of refused)
    row.outcome = settleConflict({
      spec: `${row.name}@${row.version}`,
      packed,
      lookup,
    });
  return rows;
}

/** One summary line per package. */
export function summaryLine({ name, version, commit, outcome }) {
  const at = commit ? ` (built from ${commit.slice(0, 12)})` : "";
  switch (outcome.kind) {
    case "published":
      return `${name}@${version}: published${at}`;
    case "already-published":
      return `${name}@${version}: already published, npm holds the same tarball (${outcome.integrity})${at}`;
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
    lookup: { ...DEFAULT_LOOKUP },
    pending: [],
  };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--"))
      throw new Error(`${flag} needs a value`);
    return v;
  };
  const number = (i, flag, ok, what) => {
    const n = Number(value(i, flag));
    if (!ok(n)) throw new Error(`${flag} needs ${what}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--publish-cmd") opts.publishCmd = value(++i, a);
    else if (a === "--work-dir") opts.workDir = value(++i, a);
    else if (a === "--lookup-cmd") opts.lookup.cmd = value(++i, a);
    else if (a === "--lookup-attempts")
      opts.lookup.attempts = number(
        ++i,
        a,
        (n) => Number.isInteger(n) && n >= 1,
        "a whole number of at least 1",
      );
    else if (a === "--lookup-interval")
      opts.lookup.intervalSeconds = number(
        ++i,
        a,
        (n) => Number.isFinite(n) && n >= 0,
        "a number of seconds, 0 or more",
      );
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else opts.pending.push(a.replace(/\/+$/, ""));
  }
  if (opts.dryRun && opts.publishCmd !== undefined)
    throw new Error("--dry-run and --publish-cmd are exclusive");
  if (opts.dryRun && opts.lookup.cmd !== undefined)
    throw new Error("--dry-run and --lookup-cmd are exclusive");
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
    lookup: opts.lookup,
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
