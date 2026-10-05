// Version ONE workspace package: run `changeset version` with every other pending package ignored.
//
// Plain `changeset version` takes every pending changeset, so a release of one package drags every
// other package with a changeset along (#583). Changesets can hold packages back with `--ignore`,
// but it refuses an ignore set that leaves out a runtime dependent of an ignored package. This
// script works that set out from the workspace, so nobody types an `--ignore` flag by hand.
//
// The ignore set is every public package under packages/ that has a pending changeset and is not
// the target, closed under runtime (non-dev) dependents — the rule changesets 2.31's `version`
// enforces. A package with no pending changeset stays out of the set, because ignoring it would
// force its dependents out too for no reason. Private dependents are skipped, as changesets skips
// them.
//
// The script refuses, and runs nothing, when the target is not a workspace package, has no pending
// changeset, is itself a dependent of an ignored package, or shares a changeset file with an
// ignored package (changesets refuses that mixed file too).
//
// Run:  pnpm release:version <package>
//       node scripts/release-version.mjs [--changeset-cmd <cmd>] <package>
//   --changeset-cmd  run `<cmd> <args>` through the shell instead of `pnpm exec changeset`. For tests.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Every `packages/<dir>/package.json` in `repo`: `{ name, private, runtimeDeps }`. */
export function readWorkspace(repo) {
  const root = path.join(repo, "packages");
  const packages = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    const runtimeDeps = new Set();
    for (const field of RUNTIME_DEP_FIELDS)
      for (const dep of Object.keys(pkg[field] ?? {})) runtimeDeps.add(dep);
    packages.push({
      name: pkg.name,
      private: pkg.private === true,
      runtimeDeps: [...runtimeDeps],
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/** The package names a changeset's front matter declares a bump for. */
export function changesetPackages(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return [];
  const names = [];
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^\s*(["']?)([^"':\s][^"':]*)\1\s*:\s*\S+/.exec(line);
    if (entry) names.push(entry[2].trim());
  }
  return names;
}

/** Every pending changeset in `<repo>/.changeset`: `{ file, packages }`. */
export function readChangesets(repo) {
  const dir = path.join(repo, ".changeset");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((file) => ({
      file: path.join(".changeset", file),
      packages: changesetPackages(readFileSync(path.join(dir, file), "utf8")),
    }));
}

/**
 * Decide what releasing `target` alone means. Returns either
 * `{ kind: "run", ignored: [{ name, reason }] }`, where `reason` is `{ kind: "own-changeset" }`
 * or `{ kind: "dependent", of: <ignored package> }`, or `{ kind: "refuse", message }`.
 */
export function planRelease({ packages, changesets, target }) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  if (!byName.has(target)) {
    const names = packages.map((p) => p.name).join(", ");
    return {
      kind: "refuse",
      message: `"${target}" is not a workspace package. Valid names: ${names}.`,
    };
  }

  const pending = new Set(changesets.flatMap((c) => c.packages));
  if (!pending.has(target))
    return {
      kind: "refuse",
      message: `${target} has nothing pending: no changeset in .changeset/ names it.`,
    };

  const dependents = new Map(packages.map((p) => [p.name, []]));
  for (const p of packages)
    for (const dep of p.runtimeDeps)
      if (dependents.has(dep)) dependents.get(dep).push(p.name);

  // Seed with every public package that has its own pending changeset, then close the set under
  // runtime dependents, breadth first, so each dependent names the nearest ignored package.
  const reasons = new Map();
  const queue = [];
  for (const p of packages) {
    if (p.name === target || p.private || !pending.has(p.name)) continue;
    reasons.set(p.name, { kind: "own-changeset" });
    queue.push(p.name);
  }
  while (queue.length > 0) {
    const held = queue.shift();
    for (const dependent of dependents.get(held)) {
      if (byName.get(dependent).private || reasons.has(dependent)) continue;
      reasons.set(dependent, { kind: "dependent", of: held });
      queue.push(dependent);
    }
  }

  const heldBeside = (c) =>
    c.packages.filter((n) => n !== target && reasons.has(n));
  const mixed = changesets.filter(
    (c) => c.packages.includes(target) && heldBeside(c).length > 0,
  );
  if (mixed.length > 0) {
    const lines = mixed.map(
      (c) => `  ${c.file} names ${target} and ${heldBeside(c).join(", ")}`,
    );
    return {
      kind: "refuse",
      message: `a changeset names ${target} together with a package that is held back, and changesets refuses that mixed file. Split it first:\n${lines.join("\n")}`,
    };
  }

  const forced = reasons.get(target);
  if (forced !== undefined)
    return {
      kind: "refuse",
      message: `${target} depends on ${forced.of}, which has to be held back, and changesets will not version a package while a runtime dependency of it is ignored. Release ${forced.of} first, or together with ${target}.`,
    };

  const ignored = [...reasons]
    .map(([name, reason]) => ({ name, reason }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { kind: "run", ignored };
}

/** One printed line per ignored package. */
export function ignoreLine({ name, reason }) {
  return reason.kind === "own-changeset"
    ? `  ${name} — its own pending changeset`
    : `  ${name} — depends on ${reason.of}`;
}

function parseArgs(argv) {
  let changesetCmd;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--changeset-cmd") {
      changesetCmd = argv[++i];
      if (changesetCmd === undefined || changesetCmd.startsWith("--"))
        throw new Error("--changeset-cmd needs a value");
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1)
    throw new Error("usage: pnpm release:version <package>");
  return { changesetCmd, target: rest[0] };
}

function main() {
  const repo = process.cwd();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`release:version: ${e.message}`);
    return 2;
  }
  const plan = planRelease({
    packages: readWorkspace(repo),
    changesets: readChangesets(repo),
    target: opts.target,
  });
  if (plan.kind === "refuse") {
    console.error(`release:version: ${plan.message}`);
    return 1;
  }

  if (plan.ignored.length === 0)
    console.log(`release:version: ${opts.target} — nothing to ignore.`);
  else {
    console.log(`release:version: ${opts.target} — ignoring:`);
    for (const row of plan.ignored) console.log(ignoreLine(row));
  }

  const args = [
    "version",
    ...plan.ignored.flatMap(({ name }) => ["--ignore", name]),
  ];
  const r =
    opts.changesetCmd === undefined
      ? spawnSync("pnpm", ["exec", "changeset", ...args], {
          cwd: repo,
          stdio: "inherit",
        })
      : spawnSync(`${opts.changesetCmd} ${args.join(" ")}`, [], {
          cwd: repo,
          stdio: "inherit",
          shell: true,
        });
  if (r.error) {
    console.error(
      `release:version: changeset could not start: ${r.error.message}`,
    );
    return 1;
  }
  return r.status ?? 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
