import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
const cargo = process.env.CARGO ?? "cargo";
const consumer = "crates/tea/tests/paginated_walk_runtime.rs";
const output = execFileSync(
  cargo,
  [
    "test",
    "--locked",
    "-p",
    "demlik-tea",
    "--test",
    "paginated_walk_runtime",
    "--",
    "--nocapture",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000 },
);
assert.match(output, /test result: ok\. 1 passed; 0 failed/);
const rows = output
  .split("\n")
  .filter((line) => line.startsWith("PAGINATED_WALK_RUNTIME:"))
  .map((line) => JSON.parse(line.slice("PAGINATED_WALK_RUNTIME:".length)));
assert.equal(rows.length, 6);
assert.equal(
  new Set(rows.map((row) => `${row.profile}:${row.failures}`)).size,
  6,
);
for (const row of rows) {
  assert.ok(["Promise", "Effect"].includes(row.profile));
  assert.ok([0, 1, 3].includes(row.failures));
  assert.equal(row.sharedFailures, row.failures);
  assert.equal(row.reports, 0);
  assert.equal(row.complete, row.failures !== 3);
  assert.equal(row.stuck, row.failures === 3);
  const expected =
    row.failures === 3
      ? ["fetch:first", "fetch:first", "fetch:first"]
      : [
          ...(row.failures === 1 ? ["fetch:first"] : []),
          "fetch:first",
          "process:first",
          "fetch:second",
          "process:second",
        ];
  assert.deepEqual(row.trace, expected);
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [
  consumer,
  "crates/tea/src/paginate/paginated_walk.rs",
  "crates/tea/src/paginate/paginator.rs",
  "crates/tea/src/resilience/resilient_call/mod.rs",
  "crates/tea/src/resilience/deadline.rs",
  "crates/tea/src/runtime/engine.rs",
  "crates/tea/src/runtime/timer.rs",
  "crates/tea/src/command.rs",
  "crates/tea/src/data.rs",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      hash(await readFile(path.join(root, file))),
    ]),
  ),
);
const report = {
  scope:
    "Actual default native Runtime, both profiles; no timer/subscription override",
  cases: rows.length,
  passed: rows.length,
  rows,
  sourceHashes,
  qualifications: [
    "The consumer carries opaque non-Clone/non-serde cursor/page payloads and asserts shared failure identity and mutation visibility before emitting each receipt.",
    "Typed native futures and the existing Runtime are used; this does not claim arbitrary JavaScript microtask scheduling equivalence.",
  ],
};
await mkdir(path.join(root, "target/parity"), { recursive: true });
await writeFile(
  path.join(root, "target/parity/paginated-walk-runtime.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
