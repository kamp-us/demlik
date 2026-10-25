import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  here = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
export async function recorderRuntime(options = {}) {
  const scope = JSON.parse(
    await readFile(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const args = options.args ?? [],
    index = args.indexOf("--from-log"),
    fromLog =
      options.fromLog ??
      (index < 0 ? undefined : path.resolve(args[index + 1]));
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
          "recorder_runtime",
          "--",
          "--nocapture",
        ],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
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
  const native = output
    .split("\n")
    .filter((line) => line.startsWith("TRACE_RECORDER_RUNTIME:"))
    .map((line) => JSON.parse(line.slice("TRACE_RECORDER_RUNTIME:".length)));
  assert.equal(native.length, 8);
  const sourceOutput = execFileSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, "recorder-runtime-reference.mts"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  const reference = sourceOutput
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(reference.length, 8);
  const nativeEvidence = {},
    rows = [];
  for (let i = 0; i < native.length; i++) {
    const { observedCalls, ...actual } = native[i];
    assert.ok(observedCalls.length);
    assert.deepEqual(actual, reference[i]);
    assert.equal(actual.anchor, 14);
    assert.equal(actual.dumpFinal, 20);
    assert.equal(actual.recorded, actual.sampled ? 2 : 4);
    assert.equal(actual.actual, actual.sampled ? 15 : 20);
    assert.equal(actual.matches, !actual.sampled);
    assert.equal(
      actual.wireFinal,
      actual.sampled && actual.captureSteps ? 17 : 20,
    );
    assert.equal(actual.initCalls, 1);
    assert.equal(actual.handlerCalls, 1);
    assert.equal(actual.reports, 0);
    assert.equal(actual.selectorCallsUnchanged, true);
    const id = `recorder-runtime.${actual.profile.toLowerCase()}.capture-${actual.captureSteps}.sampled-${actual.sampled}`;
    nativeEvidence[id] = observedCalls;
    rows.push({ id, ...actual });
  }
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const files = [
    "crates/tea/tests/recorder_runtime.rs",
    "crates/tea/src/persistence/recorder.rs",
    "crates/tea/src/persistence/recorder/wire.rs",
    "crates/tea/src/persistence/trace_replay.rs",
    "crates/tea/src/core.rs",
    "crates/tea/src/runtime/engine.rs",
    "verification/parity/recorder-runtime-reference.mts",
  ];
  const report = {
    scope:
      "Actual Source Promise/Effect and native profiles: record→JSONL→parse→cold update-only replay",
    reference: scope.reference,
    node: process.version,
    v8: process.versions.v8,
    cases: 8,
    passed: 8,
    rows,
    nativeEvidence,
    sourceHashes: Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          hash(await readFile(path.join(root, file))),
        ]),
      ),
    ),
    proof: fromLog
      ? {
          kind: "existing-native-test-log",
          log: path.relative(root, fromLog),
          sha256: hash(output),
        }
      : { kind: "executed-native-consumer" },
    qualifications: [
      "Opaque native State and Msg implement neither Clone nor serde and use explicit JSON boundary codecs. Pure borrowed values have separate compiled witnesses.",
      "The Effect source handle supplies the same synchronous observe/onBoot hooks; a type-only fixture adapter bridges its distinct waiting-verb types to the recorder signature.",
      "Sampling intentionally diverges: dump finalState tracks every transition, while captureSteps JSONL carries only retained post-states. No scheduler or replayed init/effects are introduced.",
    ],
  };
  const reportFile =
    options.reportFile ??
    path.join(root, "target/parity/recorder-runtime.json");
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          ...report,
          nativeEvidence: { cases: Object.keys(nativeEvidence).length },
          reportFile,
        },
        null,
        2,
      ),
    );
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await recorderRuntime({ args: process.argv.slice(2) });
