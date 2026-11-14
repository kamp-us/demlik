// Which test jobs one build starts. The first job of build.yaml runs this; the test job's matrix is
// its `legs` output, and the verdict job (required.mjs) passes a skipped test job only when `test`
// says "false". No installed dependencies: it runs on the runner's own Node, after pnpm/action-setup
// and a full checkout, before `pnpm install`.
//
// A leg is one slice of the suite: a workspace package (every vitest project that has a test file
// under its folder, tea's React and fast-check peer projects included) or the root's own `scripts`
// project. A change starts the legs of the packages it touches and of every package that depends on
// them, and the root leg beside any of them (its guards read every package's sources and tests).
//
// Which package depends on which is read from each package.json by pnpm, never written here:
//   `pnpm ls -r --depth -1 --json`                       every workspace package and its folder
//   `pnpm ls -r --depth -1 --json --filter "...{<dir>}"` that package and its dependents
// ("To select a package and its dependent packages (direct and non-direct), prefix the package
// name with an ellipsis", and a `{<directory>}` selector takes the same operator: pnpm.io/filtering.)
// pnpm's own `--filter "...[<base>]"` is not used: it diffs the working tree against its ref with
// whatever git it finds, and its merge-base rule changed between pnpm versions.
//
// Fail safe, in this order. Whatever cannot be decided runs everything:
//   1. An event that is not a pull request or a merge queue group (a push to main, whose run is the
//      safety net behind the queue, and anything else): every leg.
//   2. Changed files that cannot be read, or none: every leg.
//   3. A manifest (`package.json`) that was added or deleted: a workspace member may have come or
//      gone, and code-graph's tests list the members.
//   4. A path that is in no package and that no rule below calls safe: every leg. That is the
//      lockfile, pnpm-workspace.yaml, the root package.json and configs, vitest.config.ts, anything
//      under .github/, and any path nobody wrote a rule for.
//   5. A workspace pnpm cannot list: one leg, `all`, the whole suite as before.
import { spawnSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ name: string, args: string }} Leg */
/** @typedef {{ status: string, path: string }} Change One changed file: git's status letter (A, M, D, T) and its path. */
/** @typedef {{ status: number | null, stdout: string }} Ran */
/** @typedef {(command: string, args: string[]) => Ran} Runner */

/** The root's own tests: vitest.config.ts names this project, and scripts/ holds its files. */
export const ROOT_LEG = /** @type {Leg} */ ({
  name: "scripts",
  args: "--project scripts",
});

/** The whole suite in one job, for when the workspace cannot be listed. */
export const WHOLE_LEG = /** @type {Leg} */ ({ name: "all", args: "" });

/**
 * A package's slice: vitest's positional filter is "the test files that contain this in their
 * paths", and the trailing slash keeps `packages/tea/` from matching `packages/tea-x/`.
 * @param {string} dir
 * @returns {Leg}
 */
export const legOf = (dir) => ({ name: dir, args: `${dir}/` });

/**
 * The files outside every package that a package's tests read, found by reading every test under
 * packages/ and scripts/ on 2026-11-13 (decision 0036). The first row that matches a path decides:
 * a change of a kind in `settled` cannot change what that test sees, and any other change starts
 * the reader's leg. A path in no row and in no package starts every leg.
 *
 * - `.changeset/*.md`: tea's public-subpaths.test.ts searches every changeset for the note of each
 *   subpath a release closed. An added changeset only adds notes; an edit or a deletion can remove
 *   one.
 * - Markdown: tea's doc-links.test.ts checks that each repo-root path its Markdown links to (the
 *   decisions, the patterns) exists. An added or edited file still exists; a deleted one may be a
 *   target. No test reads ROADMAP.md, CLAUDE.md or any root README.md, and the root guards in
 *   scripts/ read only test files, sources and pnpm-workspace.yaml. Under .github/ the workflow's
 *   own tests read the workflow, so nothing there is settled.
 *
 * `reader` is a workspace folder. If it is not one, the row cannot be trusted and every leg runs.
 * A test that starts reading a root file adds its row in the same change; main's push runs every
 * test, so a read nobody listed turns main red at the next merge rather than passing unseen.
 */
export const READS = [
  { file: /^\.changeset\/.+\.md$/, settled: "A", reader: "packages/tea" },
  { file: /^(?!\.github\/).+\.md$/, settled: "AM", reader: "packages/tea" },
];

/**
 * A package.json added or deleted: code-graph's tests list the workspace's package folders from
 * the manifests (discoverPackageRoots), so a package that came or went changes what they see. An
 * edited manifest changes no list.
 * @param {Change} change
 */
const membership = ({ status, path: file }) =>
  (file === "package.json" || file.endsWith("/package.json")) && status !== "M";

/** A path under scripts/ is a file of the root leg alone. @param {string} file */
const rootTests = (file) => file.startsWith("scripts/");

/**
 * An event whose jobs follow its changed paths, because it can read them: a pull request and a
 * merge queue group. A push to main runs everything.
 * @param {string} event
 */
const scoped = (event) => event === "pull_request" || event === "merge_group";

/** @param {string} sha */
export const validSha = (sha) =>
  /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha);

/**
 * @param {string} dir
 * @param {string} file
 */
const contains = (dir, file) => file === dir || file.startsWith(`${dir}/`);

/**
 * The folders no other folder here contains. tea's react-peers/ and fast-check-peers/ packages are
 * inside packages/tea, and exist to test it, so they belong to its leg.
 * @param {readonly string[]} dirs
 */
export const outermost = (dirs) =>
  [...new Set(dirs)]
    .filter(
      (dir) => !dirs.some((other) => other !== dir && contains(other, dir)),
    )
    .sort();

/**
 * @typedef {{ legs: Leg[], why: string }} Plan
 */

/**
 * What one build runs, from the files it changed. Pure: the workspace is read before this and the
 * dependents are asked through `dependents`, which returns null for an answer it could not get.
 * @param {{
 *   event: string,
 *   changes: readonly Change[] | null,
 *   packages: readonly string[] | null,
 *   dependents: (dirs: readonly string[]) => readonly string[] | null,
 * }} input
 * @returns {Plan}
 */
export const plan = ({ event, changes, packages, dependents }) => {
  if (packages === null || packages.length === 0) {
    return {
      legs: [WHOLE_LEG],
      why: "the workspace could not be listed, so the whole suite runs",
    };
  }

  /** @param {string} why @returns {Plan} */
  const everything = (why) => ({
    legs: [...packages.map(legOf), ROOT_LEG],
    why,
  });

  if (!scoped(event)) {
    return everything(`a ${event || "run of unknown kind"} runs every test`);
  }

  if (changes === null) {
    return everything(
      "the changed files could not be read, so every test runs",
    );
  }

  if (changes.length === 0) {
    return everything("no changed file was found, so every test runs");
  }

  const touched = new Set();
  let root = false;

  for (const change of changes) {
    const file = change.path;

    if (membership(change)) {
      return everything(
        `${file} was ${change.status === "A" ? "added" : "removed or retyped"}, so the workspace's members may have changed and every test runs`,
      );
    }

    const owner = packages.find((dir) => contains(dir, file));
    const row = READS.find((read) => read.file.test(file));

    if (owner !== undefined) {
      touched.add(owner);
    } else if (rootTests(file)) {
      root = true;
    } else if (row !== undefined) {
      if (row.settled.includes(change.status)) {
        continue;
      }

      if (!packages.includes(row.reader)) {
        return everything(
          `${file} is read by ${row.reader}, which is not a workspace package, so every test runs`,
        );
      }

      touched.add(row.reader);
    } else {
      return everything(
        `${file} is in no package and no rule calls it safe, so every test runs`,
      );
    }
  }

  const reached = touched.size === 0 ? [] : dependents([...touched]);

  if (reached === null) {
    return everything(
      "the dependents of the changed packages could not be read, so every test runs",
    );
  }

  const legs = reached.map(legOf);

  if (legs.length > 0 || root) {
    legs.push(ROOT_LEG);
  }

  if (legs.length === 0) {
    return { legs, why: "only files that no test can see changed" };
  }

  const names = [...touched].join(", ");
  const also = reached.filter((dir) => !touched.has(dir));
  const why =
    touched.size === 0
      ? "only the root's scripts changed"
      : `${names} ${touched.size === 1 ? "is" : "are"} touched${also.length > 0 ? `, and ${also.join(", ")} depend${also.length === 1 ? "s" : ""} on ${touched.size === 1 ? "it" : "them"}` : ""}`;
  return { legs, why };
};

/** @type {Runner} */
const spawn = (command, args) =>
  spawnSync(command, args, { encoding: "utf8", maxBuffer: 2 ** 28 });

/**
 * The working folder is the caller's; tests give each fixture its own.
 * @param {string} cwd
 * @returns {Runner}
 */
export const inFolder = (cwd) => (command, args) =>
  spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 2 ** 28 });

/**
 * No shell interpolation. A pull request's changes start at the merge base of its base and head; a
 * merge queue group's start at the group's own base, the commit it was built on. A rename is a
 * deletion and an addition. NUL keeps every legal Git name whole: the output is status, path,
 * status, path, each ended by one.
 * @param {string} base
 * @param {string} head
 * @param {string} event
 * @param {Runner} [run]
 * @returns {Change[] | null}
 */
export const readChanges = (base, head, event, run = spawn) => {
  if (!validSha(base) || !validSha(head)) {
    return null;
  }

  let from = base;

  if (event === "pull_request") {
    const merged = run("git", ["merge-base", base, head]);

    if (merged.status !== 0) {
      return null;
    }

    from = merged.stdout.trim();

    if (!validSha(from)) {
      return null;
    }
  }

  const diff = run("git", [
    "diff",
    "--no-renames",
    "--name-status",
    "-z",
    from,
    head,
    "--",
  ]);

  if (
    diff.status !== 0 ||
    (diff.stdout !== "" && !diff.stdout.endsWith("\0"))
  ) {
    return null;
  }

  if (diff.stdout === "") {
    return [];
  }

  const fields = diff.stdout.slice(0, -1).split("\0");

  if (fields.length % 2 !== 0) {
    return null;
  }

  /** @type {Change[]} */
  const changes = [];

  for (let at = 0; at < fields.length; at += 2) {
    const status = fields[at] ?? "";

    if (!/^[A-Z]$/.test(status)) {
      return null;
    }

    changes.push({ status, path: fields[at + 1] ?? "" });
  }

  return changes;
};

/**
 * pnpm's own listing, as workspace-relative folders. The root project is not one of them.
 * @param {Ran} listed
 * @param {string} root
 * @returns {string[] | null}
 */
const folders = (listed, root) => {
  if (listed.status !== 0) {
    return null;
  }

  let entries;

  try {
    entries = JSON.parse(listed.stdout);
  } catch {
    return null;
  }

  if (!Array.isArray(entries)) {
    return null;
  }

  /** @type {string[]} */
  const dirs = [];

  for (const entry of entries) {
    if (typeof entry?.path !== "string") {
      return null;
    }

    const rel = path
      .relative(root, realpathSync(entry.path))
      .split(path.sep)
      .join("/");

    if (rel.startsWith("..")) {
      return null;
    }

    if (rel !== "") {
      dirs.push(rel);
    }
  }

  return outermost(dirs);
};

/**
 * Every workspace package's folder, from pnpm.
 * @param {string} root
 * @param {Runner} [run]
 */
export const readPackages = (root, run = spawn) =>
  folders(
    run("pnpm", ["ls", "-r", "--depth", "-1", "--json"]),
    realpathSync(root),
  );

/**
 * The given packages and every package that depends on them, direct or not, devDependencies
 * included: pnpm's `...{<dir>}` selector. A package pnpm does not return for its own folder means
 * the selector did not read the workspace the way this did, and nothing is trusted then.
 * @param {string} root
 * @param {readonly string[]} dirs
 * @param {Runner} [run]
 * @returns {string[] | null}
 */
export const readDependents = (root, dirs, run = spawn) => {
  const selectors = dirs.flatMap((dir) => ["--filter", `...{${dir}}`]);
  const reached = folders(
    run("pnpm", ["ls", "-r", "--depth", "-1", "--json", ...selectors]),
    realpathSync(root),
  );

  if (reached === null || !dirs.every((dir) => reached.includes(dir))) {
    return null;
  }

  return reached;
};

/**
 * @param {Plan} chosen
 */
export const render = ({ legs }) =>
  `test=${legs.length > 0}\nlegs=${JSON.stringify(legs)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = process.env.EVENT ?? "";
  const root = process.cwd();
  const packages = readPackages(root);
  const changes = scoped(event)
    ? readChanges(process.env.BASE ?? "", process.env.HEAD ?? "", event)
    : null;
  const chosen = plan({
    event,
    changes,
    packages,
    dependents: (dirs) => readDependents(root, dirs),
  });
  const output = render(chosen);
  process.stdout.write(output);
  console.log(chosen.why);
  const file = process.env.GITHUB_OUTPUT;

  if (file) {
    appendFileSync(file, output);
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;

  if (summary) {
    const lines =
      chosen.legs.length === 0
        ? "No test job starts."
        : chosen.legs.map((leg) => `- \`${leg.name}\``).join("\n");
    appendFileSync(summary, `### Tests\n\n${chosen.why}.\n\n${lines}\n`);
  }

  if (scoped(event) && changes === null) {
    console.log(
      "::warning::changes: the changed files could not be read, so every test runs",
    );
  }
}
