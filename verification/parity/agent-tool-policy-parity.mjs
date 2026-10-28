import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  toolPolicyCases,
  toolPolicyColdCases,
  toolPolicyRuntimeCases,
} from "./agent-tool-policy-cases.mjs";
import { agentToolPolicyParity } from "./agent-tool-policy-run.mjs";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const qualifiedId = "agent-tool-policy.pure.original-null-reason-field";
const fixtures = [
  ...toolPolicyCases,
  ...toolPolicyRuntimeCases,
  ...toolPolicyColdCases,
];
const coldIds = new Set(toolPolicyColdCases.map((row) => row.id));
const pureIds = new Set(toolPolicyCases.map((row) => row.id));
const digest = /^[a-f0-9]{64}$/;

function buildDriver(cargo, example, reportFile) {
  const producer = buildTeaExample(cargo, example, reportFile);
  assertCheckPath(producer.actualArtifact, path.join(root, "target"));
  assertCheckPath(
    producer.libraries.demlik_tea.path,
    path.join(root, "target"),
  );
  return producer;
}

export function agentToolPolicyCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/agent-tool-policy.json"),
  );
  let binary = options.binary;
  let runtimeBinary = options.runtimeBinary;
  const producer = { pure: null, runtime: null };
  if (!binary || !runtimeBinary) {
    for (const key of [
      "CARGO_TARGET_DIR",
      "DEMLIK_MUTATION_TARGET_DIR",
      "CARGO_BUILD_TARGET_DIR",
      "CARGO_BUILD_BUILD_DIR",
    ])
      assert.equal(process.env[key], undefined, `${key} must be unset`);
  }
  if (!binary) {
    producer.pure = buildDriver(
      cargo,
      "agent_tool_policy_driver",
      `${reportFile}.pure`,
    );
    binary = producer.pure.binary;
  }
  if (!runtimeBinary) {
    producer.runtime = buildDriver(
      cargo,
      "agent_tool_policy_runtime_driver",
      `${reportFile}.runtime`,
    );
    runtimeBinary = producer.runtime.binary;
  }
  const raw = agentToolPolicyParity({
    binary,
    runtimeBinary,
    output: `${reportFile}.raw.json`,
  });
  const report = normalizeAgentToolPolicyReport(raw, producer);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function observedPaths(example) {
  const source = fs.readFileSync(
    path.join(root, `crates/tea/examples/${example}.rs`),
    "utf8",
  );
  const paths = [
    ...source.matchAll(
      /observe!\(\s*[^,]+,\s*(demlik_tea::[A-Za-z0-9_:]+)\s*[,)]/g,
    ),
  ].map((match) => match[1]);
  assert.ok(paths.length, `${example}: no observed public callsites`);
  return new Set(paths);
}

export function normalizeAgentToolPolicyReport(raw, producer = null) {
  assert.equal(toolPolicyCases.length, 40);
  assert.equal(toolPolicyRuntimeCases.length, 12);
  assert.equal(toolPolicyColdCases.length, 2);
  assert.equal(raw.cases, 54);
  assert.equal(raw.passed, 54);
  assert.equal(raw.failed, 0);
  assert.equal(raw.strictPassed, 53);
  assert.equal(raw.qualifiedPassed, 1);
  assert.ok(Array.isArray(raw.knownOpen) && raw.knownOpen.length);
  const scope = JSON.parse(
    fs.readFileSync(path.join(root, "verification/parity/scope.json"), "utf8"),
  );
  assert.deepEqual(raw.engine, scope.referenceEngine);
  assert.deepEqual(
    raw.observations.map((row) => row.id),
    fixtures.map((row) => row.id),
  );
  assert.deepEqual(
    Object.keys(raw.nativeEvidence),
    fixtures.filter((row) => row.id !== qualifiedId).map((row) => row.id),
  );
  assert.deepEqual(Object.keys(raw.qualifiedNativeEvidence), [qualifiedId]);
  assert.equal(Object.keys(raw.binaryHashes).length, 2);
  for (const [binary, hash] of Object.entries(raw.binaryHashes)) {
    assert.ok(path.isAbsolute(binary));
    assert.match(hash, digest);
  }
  assert.equal(raw.processes.length, 112);
  const processes = new Map();
  for (const process of raw.processes) {
    assert.ok(process.kind === "source" || process.kind === "native");
    assert.equal(process.status, 0);
    assert.equal(process.signal, null);
    assert.equal(process.error, null);
    assert.ok(path.isAbsolute(process.stdout));
    assert.ok(path.isAbsolute(process.stderr));
    assert.equal(
      fs.readFileSync(process.stderr, "utf8"),
      "",
      `${process.id}: unexpected stderr`,
    );
    const key = JSON.stringify([process.caseId, process.phase, process.kind]);
    assert.ok(!processes.has(key), `duplicate process ${key}`);
    processes.set(key, process);
  }
  const calls = {
    pure: observedPaths("agent_tool_policy_driver"),
    runtime: observedPaths("agent_tool_policy_runtime_driver"),
  };
  const binaries = { pure: new Set(), runtime: new Set() };
  for (const fixture of fixtures) {
    const row = raw.observations.find((item) => item.id === fixture.id);
    const qualified = fixture.id === qualifiedId;
    assert.equal(row.same, true, `${row.id}: comparison failed`);
    assert.deepEqual(row.qualifications, qualified ? ["raw-null-reason"] : []);
    assert.deepEqual(
      row.native.view,
      row.source.view,
      `${row.id}: whole view differs`,
    );
    const role = pureIds.has(row.id) ? "pure" : "runtime";
    assert.ok(
      Array.isArray(row.native.nativeTrace) && row.native.nativeTrace.length,
    );
    for (const call of row.native.nativeTrace) {
      assert.ok(
        calls[role].has(call),
        `${row.id}: unobserved public call ${call}`,
      );
    }
    assert.deepEqual(
      (qualified ? raw.qualifiedNativeEvidence : raw.nativeEvidence)[row.id],
      row.native.nativeTrace,
    );
    const phases = coldIds.has(row.id) ? ["writer", "reader"] : [null];
    const coldCalls = [];
    for (const phase of phases) {
      for (const kind of ["source", "native"]) {
        const key = JSON.stringify([row.id, phase, kind]);
        const process = processes.get(key);
        assert.ok(process, `missing process ${key}`);
        processes.delete(key);
        assert.equal(process.id, phase ? `${row.id}.${phase}` : row.id);
        const { path: folder, ...input } = process.input;
        assert.deepEqual(
          input,
          phase ? { ...fixture.input, mode: phase } : fixture.input,
        );
        if (role === "runtime")
          assert.ok(typeof folder === "string" && path.isAbsolute(folder));
        else assert.equal(folder, undefined);
        if (kind === "native") {
          assert.deepEqual(process.args, []);
          assert.equal(process.binarySha256, raw.binaryHashes[process.command]);
          assert.match(process.binarySha256, digest);
          binaries[role].add(process.command);
        } else {
          assert.equal(process.command, "pnpm");
          assert.equal(process.binarySha256, null);
          assert.equal(process.args.length, 5);
          assert.deepEqual(process.args.slice(0, 3), [
            "exec",
            "node",
            "--import",
          ]);
          assert.equal(
            path.basename(process.args[4]),
            `agent-tool-policy-${role === "pure" ? "reference" : "runtime-reference"}.mts`,
          );
        }
        const responses = fs
          .readFileSync(process.stdout, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        assert.equal(responses.length, 1, `${process.id}: response count`);
        const response = responses[0];
        assert.equal(response.id, process.id);
        if (phase) {
          assert.deepEqual(response.view, row[kind].view[phase]);
          if (kind === "native") coldCalls.push(...response.nativeTrace);
        } else assert.deepEqual(response, row[kind]);
      }
    }
    if (coldIds.has(row.id))
      assert.deepEqual(coldCalls, row.native.nativeTrace);
  }
  assert.equal(processes.size, 0);
  assert.equal(
    raw.processes.filter((process) => process.kind === "source").length,
    56,
  );
  assert.equal(
    raw.processes.filter((process) => process.kind === "native").length,
    56,
  );
  for (const role of ["pure", "runtime"]) {
    assert.equal(binaries[role].size, 1);
    if (producer?.[role]) {
      const selected = producer[role];
      assert.equal([...binaries[role]][0], selected.binary);
      assert.equal(raw.binaryHashes[selected.binary], selected.binarySha256);
      assert.match(selected.libraries.demlik_tea.sha256, digest);
    }
  }
  assert.deepEqual(
    Object.keys(raw.binaryHashes).sort(),
    [...binaries.pure, ...binaries.runtime].sort(),
  );
  return {
    ...raw,
    observations: 54,
    passed: 53,
    qualifiedPassed: 1,
    failures: [],
    raw,
    producer,
  };
}
