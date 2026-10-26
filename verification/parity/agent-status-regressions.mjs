import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentBaseParity } from "./agent-base-run.mjs";
import { agentContentParity } from "./agent-content-run.mjs";
import { agentGuardsParity } from "./agent-guards-run.mjs";
import { agentModelParity } from "./agent-model-run.mjs";
import { fanoutRestoreParity } from "./agent-state-fanout-restore.mts";
import { prerequisiteParity } from "./agent-state-prerequisite-run.mjs";
import { stateParity } from "./agent-state-run.mts";
import { compiledTraceParity } from "./compiled-traces.mjs";
import { verifyFlow } from "./flow.mts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Existing public consumers, explicit binaries, no hidden Cargo or Graph build. */
export async function statusRegressions(options = {}) {
  const target = process.env.CARGO_TARGET_DIR ?? path.join(root, "target");
  const reportPath = (name) =>
    path.join(root, `target/parity/agent-status-regression-${name}.json`);
  const binary = (name) => path.join(target, "debug/examples", name);
  const groups = {};
  async function check(name, expected, run) {
    const report = await run();
    const cases =
      typeof report.cases === "number" ? report.cases : report.compared;
    assert.equal(cases, expected, name);
    assert.equal(report.passed, expected, name);
    assert.deepEqual(report.failures, [], name);
    groups[name] = {
      cases: expected,
      passed: expected,
      report: reportPath(name),
    };
    console.log(JSON.stringify({ group: name, passed: expected }));
    return report;
  }
  const base = await check("base", 43, () =>
    agentBaseParity({
      binary: binary("agent_base_driver"),
      quiet: true,
      reportFile: reportPath("base"),
    }),
  );
  assert.equal(base.qualifiedObservations.length, 2);
  const content = await check("content", 79, () =>
    agentContentParity({
      binary: binary("agent_content_driver"),
      quiet: true,
      reportFile: reportPath("content"),
    }),
  );
  assert.equal(content.profiles.length, 4);
  await check("guards", 158, () =>
    agentGuardsParity({
      binary: binary("agent_guards_driver"),
      quiet: true,
      reportFile: reportPath("guards"),
    }),
  );
  const model = await check("model", 90, () =>
    agentModelParity({
      binary: binary("agent_model_driver"),
      quiet: true,
      reportFile: reportPath("model"),
    }),
  );
  assert.equal(model.runtimeCases, 36);
  assert.equal(model.qualifiedObservations.length, 2);
  const prerequisite = await check("prerequisite", 49, () =>
    prerequisiteParity({
      binary: binary("agent_state_prerequisite_driver"),
      quiet: true,
      reportFile: reportPath("prerequisite"),
    }),
  );
  assert.equal(prerequisite.qualifiedObservations.length, 1);
  await check("state", 205, () =>
    stateParity({
      binary: binary("agent_state_driver"),
      quiet: true,
      reportFile: reportPath("state"),
    }),
  );
  await check("fanout", 8, () =>
    fanoutRestoreParity({
      binary: binary("agent_fanout_restore_driver"),
      reportFile: reportPath("fanout"),
    }),
  );
  await check("flow", 48, () =>
    verifyFlow(
      reportPath("flow"),
      path.join(target, "agent-status-flow-driver"),
      false,
    ),
  );
  await check("llm", 91, () =>
    compiledTraceParity(process.env.CARGO ?? "cargo", "llm-call", {
      binary: path.join(target, "agent-status-llm-call-driver"),
      format: "llm",
      reportFile: reportPath("llm"),
    }),
  );
  await check("timestamps", 36, () =>
    compiledTraceParity(process.env.CARGO ?? "cargo", "timestamps", {
      binary: binary("timestamp_runtime_driver"),
      format: "timestamps",
      reportFile: reportPath("timestamps"),
    }),
  );
  const report = {
    groups,
    cases: Object.values(groups).reduce((sum, g) => sum + g.cases, 0),
    qualified: { content: 4, modelOpen: 2, prerequisiteOwnResult: 1 },
    notes: [
      "Model90 includes36 actual Promise/Effect runtime cases, not90+36.",
      "Qualified observations are retained in their owner reports and excluded from strict/nativeEvidence.",
      "Internal state helpers are exercised by the canonical AgentState consumer, not invented published aliases.",
    ],
    sourceSha256: Object.fromEntries(
      [
        "crates/tea/src/agent/types.rs",
        "crates/tea/src/agent/knob.rs",
        "crates/tea/src/agent/status.rs",
        "crates/tea/src/agent/state.rs",
        "crates/tea/src/agent/wire.rs",
        "crates/tea/src/flow/fan_out.rs",
      ].map((f) => [f, sha(fs.readFileSync(path.join(root, f)))]),
    ),
  };
  const out =
    options.reportFile ??
    path.join(root, "target/parity/agent-status-regressions.json");
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      cases: report.cases,
      qualified: report.qualified,
      report: out,
    }),
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await statusRegressions();
