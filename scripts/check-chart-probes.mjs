// Assert every `src/chart/__probes__/*.ts` still fails to compile, FOR THE
// REASON IT SAYS IT FAILS FOR.
//
// The chart's guarantees are almost all compile-time, so the suite that proves
// them is a directory of files that must NOT type-check. Nothing else in the
// repo can check them: `tsconfig.json` excludes the directory (37 deliberate
// errors would otherwise break `pnpm typecheck`), and vitest never sees them.
// A probe that silently stops erroring — because a derivation loosened, or the
// chart it is written against drifted — is exactly the regression the probes
// exist to catch, and without this script it lands green.
//
// "It errored" is too weak an assertion: a probe whose fixture moved errors
// with TS2307 (module not found) and would pass a mere is-it-red check while
// proving nothing. So each probe carries a marker line
//
//   // @expect-error: TS2322 TS2339
//
// naming the exact multiset of diagnostic codes it must produce. Codes, not
// line numbers: a line is invalidated by any edit above it, and the code is
// what says "this failed for a DIFFERENT reason".
//
// Cost: ONE tsc invocation over the whole directory (`src/chart/__probes__/
// tsconfig.json`, which extends the repo's own so the probes are checked under
// the settings that actually ship), not one per file. ~0.7s for 37 probes vs
// ~25s serially.
//
// Run: node scripts/check-chart-probes.mjs

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROBE_DIR = path.join(REPO_ROOT, "src", "chart", "__probes__");
const PROJECT = path.join(PROBE_DIR, "tsconfig.json");
const MARKER = /^\/\/ @expect-error:(.*)$/m;

/** file name → the codes its marker line demands, sorted, with multiplicity. */
function readExpectations() {
  const out = new Map();
  for (const f of readdirSync(PROBE_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(path.join(PROBE_DIR, f), "utf8");
    const m = MARKER.exec(src);
    if (m === null) {
      out.set(f, null); // missing marker — reported as a failure below
      continue;
    }
    out.set(f, m[1].trim().split(/\s+/).filter(Boolean).sort());
  }
  return out;
}

/** file name → the codes tsc actually reported, sorted, with multiplicity. */
function readActual() {
  const tsc = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      PROJECT,
      "--pretty",
      "false",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const text = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`;
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = /^(.*?)\((\d+),(\d+)\): error (TS\d+)/.exec(line);
    if (m === null) continue;
    const file = path.basename(m[1]);
    if (!out.has(file)) out.set(file, []);
    out.get(file).push(m[4]);
  }
  for (const codes of out.values()) codes.sort();
  return { byFile: out, text };
}

const expected = readExpectations();
const { byFile: actual, text } = readActual();

const failures = [];
for (const [file, want] of expected) {
  const got = actual.get(file);
  if (want === null) {
    failures.push(`${file}: no \`// @expect-error:\` marker line`);
    continue;
  }
  if (got === undefined) {
    failures.push(
      `${file}: COMPILES CLEAN — expected ${want.join(" ")}. The guarantee this probe pins down has regressed.`,
    );
    continue;
  }
  if (got.join(" ") !== want.join(" ")) {
    failures.push(
      `${file}: expected ${want.join(" ")}, got ${got.join(" ")} — it still fails, but for a different reason.`,
    );
  }
}
for (const file of actual.keys()) {
  if (!expected.has(file)) {
    failures.push(`${file}: tsc reported errors for a file that is not a probe`);
  }
}

if (failures.length > 0) {
  console.error(`check-chart-probes: ${failures.length} probe(s) wrong:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error("\n--- tsc output ---\n" + text);
  process.exit(1);
}
console.log(
  `check-chart-probes: all ${expected.size} probes fail to compile, each for its declared reason`,
);
