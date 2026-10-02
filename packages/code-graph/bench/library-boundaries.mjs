#!/usr/bin/env node
// What the library rules of `--boundaries` (B11-B14) cost on a repo of libraries (#523). It writes the
// generated workspace the scale test gates (`src/test-helpers/library-workspace.ts`: 40 libraries over
// five types, three hexagonal feature scopes, 2,000+ source files, 110 planted crossings) and times
// `code-graph <root> --boundaries --ci` over it twice: with the library keys declared, and with none
// of them, so the second number is what the same repo costs today. Every timed run is the real CLI in
// its own process, against a ledger that already names every crossing, which is what a green CI run
// is. Run by hand, never in CI:
//
//   node --import tsx packages/code-graph/bench/library-boundaries.mjs [--runs <n>]
//
// The gate is the cheap pass: it reads import edges and syntax trees with oxc and never starts tsgo.
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

const { libraryWorkspace } = await import(
  pathToFileURL(path.join(PACKAGE_DIR, "src", "test-helpers", "library-workspace.ts")).href
);
const workspace = libraryWorkspace();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-library-bench-"));
for (const [rel, body] of Object.entries(workspace.files)) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function cli(rulesFile, ...flags) {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, root, "--boundaries", "--boundary-rules", rulesFile, ...flags],
    { cwd: PACKAGE_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return { ms: performance.now() - started, status: result.status, stderr: result.stderr };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Each variant gets its own rules file and its own seeded ledger, so every timed run is a green
// `--ci`. The two variants run alternately, run by run, so load that comes and goes lands on both.
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
  return { name, rulesFile, seededLedger, timings: [] };
}

function timeOnce(variant) {
  fs.rmSync(LEDGER, { force: true });
  if (fs.existsSync(variant.seededLedger)) fs.copyFileSync(variant.seededLedger, LEDGER);
  const run = cli(variant.rulesFile, "--ci");
  if (run.status !== 0) {
    throw new Error(`${variant.name} --ci exited ${run.status}: ${run.stderr}`);
  }
  return run.ms;
}

const without = seed("without", workspace.rulesWithoutLibraries);
const withKeys = seed("with", workspace.rules);
for (const variant of [without, withKeys]) timeOnce(variant);
for (let i = 0; i < runs; i++) {
  const order = i % 2 === 0 ? [without, withKeys] : [withKeys, without];
  for (const variant of order) variant.timings.push(timeOnce(variant));
}
without.median = median(without.timings);
withKeys.median = median(withKeys.timings);
const added = withKeys.median - without.median;
const round = (ms) => Math.round(ms);

console.log(
  `${workspace.sourceFiles} source files, 40 libraries, 3 hexagonal feature scopes, ` +
    `${workspace.planted.length} planted crossings; ${runs} timed runs each, alternating, after one warm-up`,
);
console.log(
  `without the library keys: ${round(without.median)} ms  [${without.timings.map(round).join(", ")}]`,
);
console.log(
  `with the library keys:    ${round(withKeys.median)} ms  [${withKeys.timings.map(round).join(", ")}]`,
);
console.log(`added by the library keys: ${round(added)} ms (budget ${BUDGET_MS} ms)`);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = added < BUDGET_MS ? 0 : 1;
