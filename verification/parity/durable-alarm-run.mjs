import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { durableAlarmCases } from "./durable-alarm-cases.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
function run(command, args, input) {
  const r = spawnSync(command, args, { cwd: here, input, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
export async function durableAlarmParity(cargo = "cargo", options = {}) {
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/durable-alarm.json");
  mkdirSync(path.dirname(reportFile), { recursive: true });
  const input = JSON.stringify(durableAlarmCases);
  const source = run(
    process.execPath,
    ["--import", require.resolve("tsx"), "durable-alarm-reference.mts"],
    input,
  );
  if (options.sourceBefore)
    assert.deepEqual(
      source,
      JSON.parse(readFileSync(options.sourceBefore, "utf8")),
      "frozen before-edit Source unchanged",
    );
  const producer = buildTeaExample(cargo, "durable_alarm_driver", reportFile);
  const native = run(producer.binary, [], input);
  assert.deepEqual(native, source, "complete observable Source/native views");
  const cold = native.find((x) => x.name === "recovered-three"),
    warm = native.find((x) => x.name === "warm-three");
  assert.deepEqual(cold.alarms, [101, 101, 205, 309]);
  assert.deepEqual(cold.model, { pending: [], done: [101, 205, 309] });
  assert.deepEqual(cold.model, warm.model);
  assert.deepEqual(cold.alarms, warm.alarms);
  const report = {
    component: "durable-alarm",
    compared: source.length,
    cases: source,
    producer,
    qualifications: [
      "Generic local AlarmStorage, no Cloudflare SDK or lifecycle execution",
      "Native scoped borrowed model with opaque Rc marker; boundary codecs only",
      "Finite deadlines tested, including negative fractional; raw NaN/infinities unmeasured",
      "Timer is not an exactly-once delivery or effect deduplication layer",
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
  console.log(JSON.stringify({ compared: report.compared, reportFile }));
}
