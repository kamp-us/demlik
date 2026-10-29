import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { durableAlarmCases } from "./durable-alarm-cases.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
function run(command, args, input, prefix) {
  const r = spawnSync(command, args, { cwd: here, input, encoding: "utf8" });
  const processResult = {
    command: [command, ...args],
    status: r.status,
    signal: r.signal,
    error: r.error ? { name: r.error.name, message: r.error.message } : null,
  };
  writeFileSync(`${prefix}.stdout`, r.stdout ?? "");
  writeFileSync(`${prefix}.stderr`, r.stderr ?? "");
  writeFileSync(
    `${prefix}.process.json`,
    `${JSON.stringify(processResult, null, 2)}\n`,
  );
  assert.equal(processResult.error, null);
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, r.stderr);
  return {
    view: JSON.parse(r.stdout),
    process: processResult,
    stdout: `${prefix}.stdout`,
    stderr: `${prefix}.stderr`,
  };
}
export async function durableAlarmParity(cargo = "cargo", options = {}) {
  const scope = JSON.parse(readFileSync(path.join(here, "scope.json"), "utf8"));
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/durable-alarm.json");
  mkdirSync(path.dirname(reportFile), { recursive: true });
  const guard = spawnSync(
    "git",
    [
      "diff",
      "--exit-code",
      scope.reference,
      "--",
      "packages/tea/src",
      "packages/tea/package.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  writeFileSync(`${reportFile}.frozen-source.diff`, guard.stdout ?? "");
  writeFileSync(`${reportFile}.frozen-source.stderr`, guard.stderr ?? "");
  assert.equal(guard.status, 0, "TypeScript product must match frozen Source");
  const input = JSON.stringify(durableAlarmCases);
  writeFileSync(`${reportFile}.input.json`, `${input}\n`);
  const sourceRun = run(
    process.execPath,
    ["--import", require.resolve("tsx"), "durable-alarm-reference.mts"],
    input,
    `${reportFile}.source`,
  );
  const source = sourceRun.view;
  if (options.sourceBefore)
    assert.deepEqual(
      source,
      JSON.parse(readFileSync(options.sourceBefore, "utf8")),
      "frozen before-edit Source unchanged",
    );
  const producer = buildTeaExample(cargo, "durable_alarm_driver", reportFile);
  const before = hash(producer.binary);
  assert.equal(before, producer.binarySha256);
  const nativeRun = run(producer.binary, [], input, `${reportFile}.native`);
  const after = hash(producer.binary);
  assert.equal(after, before, "executed binary bytes unchanged");
  const native = nativeRun.view.map(({ publicCalls, ...view }) => view);
  assert.deepEqual(native, source, "complete observable Source/native views");
  const cold = native.find((x) => x.name === "recovered-three"),
    warm = native.find((x) => x.name === "warm-three");
  assert.deepEqual(cold.alarms, [101, 101, 205, 309]);
  assert.deepEqual(cold.model, { pending: [], done: [101, 205, 309] });
  assert.deepEqual(cold.model, warm.model);
  assert.deepEqual(cold.alarms, warm.alarms);
  const nativeEvidence = Object.fromEntries(
    nativeRun.view.map((row) => {
      assert.ok(row.publicCalls.length > 0);
      return [row.name, row.publicCalls];
    }),
  );
  const report = {
    component: "durable-alarm",
    reference: scope.reference,
    node: process.version,
    v8: process.versions.v8,
    cases: source.length,
    passed: source.length,
    qualifiedPassed: 0,
    rows: source,
    failures: [],
    nativeEvidence,
    producer,
    processes: { source: sourceRun, native: nativeRun },
    binary: { path: producer.binary, sha256Before: before, sha256After: after },
    sourceHashes: Object.fromEntries(
      [
        "packages/tea/src/do/durable-timer.ts",
        "packages/tea/src/do/index.ts",
        "verification/parity/durable-alarm-reference.mts",
        "verification/parity/durable-alarm-cases.mjs",
      ].map((file) => [file, hash(path.join(root, file))]),
    ),
    qualifications: [
      "Generic local AlarmStorage, no Cloudflare SDK or lifecycle execution",
      "Native scoped borrowed model with opaque Rc marker; boundary codecs only",
      "Finite deadlines tested, including negative fractional; raw NaN/infinities unmeasured",
      "Timer is not an exactly-once delivery or effect deduplication layer",
      "Native futures progress when polled, unlike eager JS Promise creation. Cases measure awaited sequential operations and held fire, not unpolled or dropped futures.",
    ],
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const reportFile = process.argv[2];
  const report = await durableAlarmParity("cargo", {
    reportFile,
    sourceBefore: process.env.DEMLIK_ALARM_SOURCE_BEFORE,
  });
  console.log(
    JSON.stringify({ cases: report.cases, passed: report.passed, reportFile }),
  );
}
