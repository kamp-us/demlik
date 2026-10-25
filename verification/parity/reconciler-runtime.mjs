import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
export async function reconcilerRuntime(options = {}) {
  const args = options.args ?? [];
  const fromIndex = args.indexOf("--from-log");
  const fromLog =
    options.fromLog ??
    (fromIndex < 0 ? undefined : path.resolve(args[fromIndex + 1]));
  const consumer = "crates/tea/tests/reconciler_runtime.rs";
  const output = fromLog
    ? await readFile(fromLog, "utf8")
    : execFileSync(
        process.env.CARGO ?? "cargo",
        [
          "test",
          "--locked",
          "-p",
          "demlik-tea",
          "--test",
          "reconciler_runtime",
          "--",
          "--nocapture",
        ],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 120_000,
          env: {
            ...process.env,
            CARGO_PROFILE_DEV_DEBUG: "0",
            CARGO_PROFILE_TEST_DEBUG: "0",
            CARGO_INCREMENTAL: "0",
            CARGO_BUILD_JOBS: "1",
          },
        },
      );
  assert.match(output, /test result: ok\. 1 passed; 0 failed/);
  const rows = output
    .split("\n")
    .filter((line) => line.startsWith("RECONCILER_RUNTIME:"))
    .map((line) => JSON.parse(line.slice("RECONCILER_RUNTIME:".length)));
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
    assert.equal(row.failed, row.failures === 3);
    const expected =
      row.failures === 3
        ? ["fetch:first", "fetch:first", "fetch:first"]
        : [
            ...(row.failures === 1 ? ["fetch:first"] : []),
            "fetch:first",
            "fetch:second",
            "apply:a",
            "apply:b",
          ];
    assert.deepEqual(row.trace, expected);
  }
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const files = [
    consumer,
    "crates/tea/src/flow/reconciler.rs",
    "crates/tea/src/flow/reconciler/wire.rs",
    "crates/tea/src/paginate/paginated_walk.rs",
    "crates/tea/src/resilience/cache.rs",
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
    proof: fromLog
      ? {
          kind: "existing-test-log",
          log: path.relative(root, fromLog),
          sha256: hash(output),
        }
      : { kind: "executed-native-consumer" },
    qualifications: [
      "The consumer carries opaque non-Clone/non-serde cursor/page/change/desired/actual values, verifies typed shared failure identity and mutation visibility, and awaits stop.",
      "Typed native futures and the existing Runtime are used; this does not claim arbitrary JavaScript microtask scheduling equivalence.",
    ],
  };
  const reportFile =
    options.reportFile ??
    path.join(root, "target/parity/reconciler-runtime.json");
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await reconcilerRuntime({ args: process.argv.slice(2) });
