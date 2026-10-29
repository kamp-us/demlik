import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durableAlarmCases } from "./durable-alarm-cases.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const file = path.join(root, "crates/tea/src/durable_object/timer.rs");
const original = readFileSync(file, "utf8");
const compute =
  "(self.next_deadline)()\n            .await\n            .map_err(DurableTimerError::Deadline)?";
const output = path.resolve(
  process.argv[2] ?? path.join(root, "target/parity/durable-alarm-controls"),
);
mkdirSync(output, { recursive: true });
const cases = JSON.stringify(durableAlarmCases);
const controls = [
  [
    "rearm-before-fire",
    (s) =>
      s.replace(
        "(self.on_fire)().await.map_err(DurableTimerError::Fire)?;\n        self.rearm().await",
        "self.rearm().await?;\n        (self.on_fire)().await.map_err(DurableTimerError::Fire)",
      ),
    (r) =>
      assert.deepEqual(
        r.find((x) => x.name === "held-fire").results[1].held.alarms,
        [101, 101],
      ),
  ],
  [
    "cached-deadline",
    (s) =>
      s
        .replace(
          "on_fire: F,",
          "on_fire: F,\n    cached: std::cell::Cell<Option<Option<f64>>>,",
        )
        .replace(
          "        on_fire,",
          "        on_fire,\n        cached: std::cell::Cell::new(None),",
        )
        .replace(
          compute,
          `match self.cached.get() { Some(at) => at, None => {let at = ${compute}; self.cached.set(Some(at)); at } }`,
        ),
    (r) =>
      assert.deepEqual(
        r.find((x) => x.name === "warm-three").alarms,
        [101, 101, 101, 101, 101, 101],
      ),
  ],
  [
    "unconditional-arm",
    (s) =>
      s.replace(
        `if let Some(at) = ${compute}`,
        `if let Some(at) = Some((${compute}).unwrap_or(0.0))`,
      ),
    (r) => assert.equal(r.find((x) => x.name === "idle").alarms[0], 0),
  ],
  [
    "swallowed-alarm-error",
    (s) =>
      s
        .replace(
          "self.alarm\n                .set_alarm(at)",
          "let _ = self.alarm\n                .set_alarm(at)",
        )
        .replace(
          ".map_err(DurableTimerError::Alarm)?;",
          ".map_err(DurableTimerError::Alarm::<A::Error, DE, FE>);",
        ),
    (r) =>
      assert.equal(
        r.find((x) => x.name === "failure-alarm").results[0].ok,
        true,
      ),
  ],
];
const results = [];
try {
  for (const [name, mutate, check] of controls) {
    const changed = mutate(original);
    assert.notEqual(changed, original);
    writeFileSync(file, changed);
    const producer = buildTeaExample(
      "cargo",
      "durable_alarm_driver",
      path.join(output, `${name}.json`),
    );
    const run = spawnSync(producer.binary, [], {
      input: cases,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const observed = JSON.parse(run.stdout);
    check(observed);
    writeFileSync(
      path.join(output, `${name}.view.json`),
      `${JSON.stringify(observed, null, 2)}\n`,
    );
    results.push({ name, detected: true, producer });
  }
} finally {
  writeFileSync(file, original);
}
writeFileSync(
  path.join(output, "controls.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);
console.log(
  JSON.stringify(results.map(({ name, detected }) => ({ name, detected }))),
);
