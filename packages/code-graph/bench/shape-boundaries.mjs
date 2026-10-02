#!/usr/bin/env node
// What the shape rules of `--boundaries` (B15, B16, the test role, strict doors and the read
// allowance) cost on a repo of hexagonal features over libraries (#525). It writes the generated
// workspace the scale test gates (`src/test-helpers/shape-workspace.ts`: three hexagonal scopes of
// eight features, 40 libraries, 2,000+ source files, 300+ of them tests, 109 planted crossings) and
// times `code-graph <root> --boundaries --ci` over it with none of the six keys declared, with each
// group of keys alone, and with all of them. Every timed run is the real CLI in its own process,
// against a ledger that already names every crossing, which is what a green CI run is. The
// workspace is a git repo, so the repo's files are listed the way a real one's are. Run by hand,
// never in CI:
//
//   cd packages/code-graph && node --import tsx bench/shape-boundaries.mjs [--runs <n>]
//
// The gate is the cheap pass: it reads import edges and syntax trees with oxc and the wrangler
// configs with a JSON parser, and never starts tsgo. `shape/cost.test.ts` pins that the repo is
// listed once and no type checker is opened; this script pins the clock. The budget is the extra
// time every key together may add: under 2 s over the same run with none of them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(BENCH_DIR, "..");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");
const BUDGET_MS = 2000;

const { values } = parseArgs({ options: { runs: { type: "string", default: "5" } } });
const runs = Number(values.runs);

const { shapeWorkspace } = await import(
  pathToFileURL(path.join(PACKAGE_DIR, "src", "test-helpers", "shape-workspace.ts")).href
);
const workspace = shapeWorkspace();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-shape-bench-"));
for (const [rel, body] of Object.entries(workspace.files)) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
spawnSync("git", ["init", "-q"], { cwd: root });

// Wall clock is what the budget is written in, and it moves with whatever else the machine is
// running, so each run also reports the CPU time the process used (user + system, from POSIX
// `time -p`), which a busy machine barely moves.
function cli(rulesFile, ...flags) {
  const started = performance.now();
  const result = spawnSync(
    "/usr/bin/time",
    [
      "-p",
      process.execPath,
      ...["--import", "tsx", CLI, root, "--boundaries", "--boundary-rules", rulesFile, ...flags],
    ],
    { cwd: PACKAGE_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const seconds = (key) => Number(new RegExp(`^${key} ([0-9.]+)`, "m").exec(result.stderr)?.[1]);
  const cpu = (seconds("user") + seconds("sys")) * 1000;
  return { ms: performance.now() - started, cpu, status: result.status, stderr: result.stderr };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Each variant gets its own rules file and its own seeded ledger, so every timed run is a green
// `--ci`. The variants run in rotation, run by run, so load that comes and goes lands on all of them.
const LEDGER = path.join(root, "boundary-ledger.json");

function seed(name, rules) {
  const rulesFile = path.join(root, `${name.replaceAll(" ", "-")}.json`);
  fs.writeFileSync(rulesFile, JSON.stringify(rules));
  fs.rmSync(LEDGER, { force: true });
  const seeded = cli(rulesFile, "--accept-crossings", "--reason", "bench");
  if (seeded.status !== 0) throw new Error(`seeding ${name} failed: ${seeded.stderr}`);
  // A rules file with no crossing writes no ledger, and an absent ledger gates as an empty one.
  const seededLedger = path.join(root, `${name.replaceAll(" ", "-")}.ledger.json`);
  if (fs.existsSync(LEDGER)) fs.copyFileSync(LEDGER, seededLedger);
  return { name, rulesFile, seededLedger, timings: [], cpus: [] };
}

function timeOnce(variant) {
  fs.rmSync(LEDGER, { force: true });
  if (fs.existsSync(variant.seededLedger)) fs.copyFileSync(variant.seededLedger, LEDGER);
  const run = cli(variant.rulesFile, "--ci");
  if (run.status !== 0) {
    throw new Error(`${variant.name} --ci exited ${run.status}: ${run.stderr}`);
  }
  return run;
}

const none = seed("none of the six keys", workspace.rulesWithoutShape);
const alone = workspace.groups.map((group) => seed(group, workspace.rulesWith(group)));
const all = seed("all six keys", workspace.rules);
const variants = [none, ...alone, all];
for (const variant of variants) timeOnce(variant);
for (let i = 0; i < runs; i++) {
  const order = [...variants.slice(i % variants.length), ...variants.slice(0, i % variants.length)];
  for (const variant of order) {
    const run = timeOnce(variant);
    variant.timings.push(run.ms);
    variant.cpus.push(run.cpu);
  }
}

const round = (ms) => Math.round(ms);
console.log(
  `${workspace.sourceFiles} source files (${workspace.testFiles} tests), 3 scopes of 8 features, ` +
    `40 libraries, ${workspace.planted.length} planted crossings; ${runs} timed runs each, ` +
    `rotating, after one warm-up; load average ${os
      .loadavg()
      .map((n) => n.toFixed(1))
      .join(" ")} on ${os.cpus().length} cores`,
);
for (const variant of variants) {
  variant.median = median(variant.timings);
  console.log(
    `${`${variant.name}:`.padEnd(28)} wall ${String(round(variant.median)).padStart(5)} ms ` +
      `(min ${round(Math.min(...variant.timings))}), cpu ${round(median(variant.cpus))} ms  ` +
      `[${variant.timings.map(round).join(", ")}]`,
  );
}
const extra = all.median - none.median;
console.log(
  `all six keys over none: +${round(extra)} ms wall, +${round(median(all.cpus) - median(none.cpus))} ms cpu (budget ${BUDGET_MS} ms)`,
);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = extra < BUDGET_MS ? 0 : 1;
