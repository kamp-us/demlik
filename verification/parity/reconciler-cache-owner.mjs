import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2),
  index = args.indexOf("--from-log");
const fromLog = index < 0 ? undefined : path.resolve(args[index + 1]);
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
        "reconciler_cache_key",
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
const tests = [
  "absent_json_identity_is_coerced_by_the_cache_owner",
  "existing_generic_text_callers_keep_their_bound",
];
for (const test of tests)
  assert.match(output, new RegExp(`test ${test} \\.\\.\\. ok`));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      "crates/tea/src/resilience/cache.rs",
      "crates/tea/tests/reconciler_cache_key.rs",
    ].map(async (file) => [file, hash(await readFile(path.join(root, file)))]),
  ),
);
const report = {
  scope: "Narrow cache-owned optional text key conversion",
  tests: tests.length,
  passed: tests.length,
  testsExecuted: tests,
  sourceHashes,
  proof: fromLog
    ? {
        kind: "existing-test-log",
        log: path.relative(root, fromLog),
        sha256: hash(output),
      }
    : { kind: "executed-native-consumer" },
  assertions: [
    "None and the existing literal undefined key address the same stored true value; exact JSON key and half-open expiry are asserted independently.",
    "Existing generic Into<JsText> callers retain their bound; Some text, has and removal use the same owner.",
  ],
  unchangedAlgorithms: [
    "cache TTL",
    "lookup and prototype projection",
    "typed stored values",
  ],
};
await mkdir(path.join(root, "target/parity"), { recursive: true });
await writeFile(
  path.join(root, "target/parity/reconciler-cache-owner.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
