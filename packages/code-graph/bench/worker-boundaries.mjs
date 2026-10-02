#!/usr/bin/env node
// What the deployable rules of `--boundaries` (B17-B19) cost on a repo of workers (#524). It writes
// the generated workspace the scale test gates (`src/test-helpers/worker-workspace.ts`: 14 workers
// in hexagonal feature scopes, 2,000+ source files, 115 planted crossings) and times
// `code-graph <root> --boundaries --ci` over it with no kind listed, with each kind listed alone,
// and with all three. Every timed run is the real CLI in its own process, against a ledger that
// already names every crossing, which is what a green CI run is. The workspace is a git repo, so
// the repo's files are listed the way a real one's are. Run by hand, never in CI:
//
//   cd packages/code-graph && node --import tsx bench/worker-boundaries.mjs [--runs <n>]
//
// The gate is the cheap pass: it reads import edges and syntax trees with oxc and the wrangler
// configs with a JSON parser, and never starts tsgo. `deployables/gate.test.ts` pins that the repo
// is listed once and no type checker is opened; this script pins the clock.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(BENCH_DIR, "..");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");
const BUDGET_MS = 3000;

const { values } = parseArgs({ options: { runs: { type: "string", default: "5" } } });
const runs = Number(values.runs);

const { workerWorkspace } = await import(
  pathToFileURL(path.join(PACKAGE_DIR, "src", "test-helpers", "worker-workspace.ts")).href
);
const workspace = workerWorkspace();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-worker-bench-"));
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
  const rulesFile = path.join(root, `${name}.json`);
  fs.writeFileSync(rulesFile, JSON.stringify(rules));
  fs.rmSync(LEDGER, { force: true });
  const seeded = cli(rulesFile, "--accept-crossings", "--reason", "bench");
  if (seeded.status !== 0) throw new Error(`seeding ${name} failed: ${seeded.stderr}`);
  // A rules file with no crossing writes no ledger, and an absent ledger gates as an empty one.
  const seededLedger = path.join(root, `${name}.ledger.json`);
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

const KINDS = [
  "binding-outside-driven-adapter",
  "worker-call-cycle",
  "relative-import-crosses-workspace",
];
const variants = [
  seed("no kind listed", workspace.rulesWithoutDeployables),
  ...KINDS.map((kind) => seed(kind, workspace.rulesWith(kind))),
  seed("all three listed", workspace.rules),
];
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
  `${workspace.sourceFiles} source files, 14 workers, ${workspace.planted.length} planted ` +
    `crossings; ${runs} timed runs each, rotating, after one warm-up; ` +
    `load average ${os
      .loadavg()
      .map((n) => n.toFixed(1))
      .join(" ")} on ${os.cpus().length} cores`,
);
for (const variant of variants) {
  variant.median = median(variant.timings);
  console.log(
    `${`${variant.name}:`.padEnd(34)} wall ${String(round(variant.median)).padStart(5)} ms ` +
      `(min ${round(Math.min(...variant.timings))}), cpu ${round(median(variant.cpus))} ms  ` +
      `[${variant.timings.map(round).join(", ")}]`,
  );
}
const alone = variants.slice(1, 1 + KINDS.length);
const slowest = Math.max(...alone.map((variant) => variant.median));
console.log(`slowest kind alone: ${round(slowest)} ms (budget ${BUDGET_MS} ms)`);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = slowest < BUDGET_MS ? 0 : 1;
