import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases } from "./agent-tool-map-cases.mjs";
import {
  assertCheckPath,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const qualifiedIds = ["runtime.promise", "runtime.effect"];
const causeText =
  'tool: "map_fault" is reserved — it is an agent-owned Msg prefix';
const nativeDiagnostic =
  'ReduceError: Reduce(ToolMapping(Reserved { name: "map_fault" }))';
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function compareToolMap(source, native, item) {
  assert.equal(source.id, item.id);
  assert.equal(native.id, item.id);
  assert.equal(source.ok, true);
  assert.equal(native.ok, true);
  const left = source.output,
    right = native.output;
  if (!qualifiedIds.includes(item.id)) {
    assert.deepEqual(right, left, "whole authored output");
    return { qualified: false };
  }
  assert.deepEqual(Object.keys(left.diagnostics[0]).sort(), [
    "message",
    "name",
    "stack",
  ]);
  assert.deepEqual(Object.keys(right.diagnostics[0]).sort(), [
    "message",
    "name",
  ]);
  assert.equal(left.diagnostics.length, 1);
  assert.equal(right.diagnostics.length, 1);
  assert.equal(left.diagnostics[0].name, "Error");
  assert.equal(left.diagnostics[0].message, causeText);
  assert.equal(typeof left.diagnostics[0].stack, "string");
  assert.ok(left.diagnostics[0].stack.startsWith(`Error: ${causeText}\n`));
  assert.equal(right.diagnostics[0].name, "ReduceError");
  assert.equal(right.diagnostics[0].message, nativeDiagnostic);
  for (const output of [left, right]) {
    assert.equal(output.handlerWork, 0);
    assert.equal(output.saves, 1);
    assert.equal(output.transitionSaves, 0);
    assert.equal(output.stopSaves, 1);
    assert.deepEqual(output.frames[0].error, {
      rejected: true,
      reports: 1,
      reportedSame: true,
    });
    assert.equal(output.frames[0].stateSame, true);
  }
  const { diagnostics: sourceDiagnostics, ...sourceView } = left;
  const { diagnostics: nativeDiagnostics, ...nativeView } = right;
  assert.deepEqual(
    nativeView,
    sourceView,
    "whole output apart from exact declared reporter fields",
  );
  return {
    qualified: true,
    reasons: ["typed-runtime-reporter-envelope"],
    fields: [
      "output.diagnostics[0].name",
      "output.diagnostics[0].message",
      "output.diagnostics[0].stack (Source only)",
    ],
    sourceDiagnostics,
    nativeDiagnostics,
  };
}
export function agentToolMapParity({
  binary,
  output,
  sourceReport,
  onlyId,
  allowFailures = false,
}) {
  const selected = onlyId ? cases.filter((c) => c.id === onlyId) : cases;
  assert.ok(selected.length > 0);
  const request = `${selected.map((c) => JSON.stringify(c)).join("\n")}\n`;
  const sourceFiles = [
    "packages/tea/src/agent/index.ts",
    "packages/tea/src/agent/tool-resilience.ts",
    "packages/tea/src/internal/flow/fan-out/index.ts",
  ];
  const pins = () =>
    Object.fromEntries(
      sourceFiles.map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
    );
  const before = pins(),
    binaryHash = hash(fs.readFileSync(binary));
  let sourceRows, sourceProcess;
  if (sourceReport) {
    const saved = JSON.parse(fs.readFileSync(sourceReport, "utf8"));
    assert.equal(saved.Source, "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d");
    sourceRows = selected.map((c) => saved.rows.find((row) => row.id === c.id));
    sourceProcess = {
      reusedSavedSource: sourceReport,
      sha256: hash(fs.readFileSync(sourceReport)),
      newExecution: false,
    };
  } else {
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(
          new URL("./agent-tool-map-reference.mts", import.meta.url),
        ),
      ],
      { cwd: root, input: request, encoding: "utf8", timeout: 60_000 },
    );
    assert.ifError(run.error);
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    sourceRows = run.stdout.trim().split("\n").map(JSON.parse);
    sourceProcess = {
      status: run.status,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  }
  const run = spawnSync(binary, [], {
    cwd: root,
    input: request,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0);
  assert.equal(run.signal, null);
  assert.equal(run.stderr, "");
  const nativeRows = run.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(sourceRows.length, selected.length);
  assert.equal(nativeRows.length, selected.length);
  const observations = [],
    failures = [],
    nativeEvidence = {},
    qualifiedNativeEvidence = {};
  for (const [index, item] of selected.entries()) {
    const source = sourceRows[index],
      native = nativeRows[index];
    const row = { id: item.id, input: item, source, native, equal: false };
    try {
      const profile = compareToolMap(source, native, item);
      assert.ok(
        Array.isArray(native.observedCalls) && native.observedCalls.length > 0,
      );
      assert.ok(
        native.observedCalls.includes(
          item.kind === "fan"
            ? "demlik_tea::flow::fan_out::FanOut::try_scatter"
            : "demlik_tea::agent::AgentConfig::try_from_plain_turns",
        ),
      );
      Object.assign(row, { equal: true, ...profile });
      const evidence = { observedCalls: native.observedCalls };
      (profile.qualified ? qualifiedNativeEvidence : nativeEvidence)[item.id] =
        evidence;
    } catch (error) {
      row.failure = {
        name: error.name,
        message: error.message,
        actual: error.actual,
        expected: error.expected,
      };
      failures.push({ id: item.id, ...row.failure });
    }
    observations.push(row);
  }
  assert.deepEqual(pins(), before);
  assert.equal(hash(fs.readFileSync(binary)), binaryHash);
  const report = {
    cases: selected.length,
    passed: Object.keys(nativeEvidence).length,
    qualifiedPassed: Object.keys(qualifiedNativeEvidence).length,
    failures,
    observations,
    nativeEvidence,
    qualifiedNativeEvidence,
    binaryHash,
    sourceHashes: before,
    processes: {
      source: sourceProcess,
      native: {
        status: run.status,
        signal: run.signal,
        stdout: run.stdout,
        stderr: run.stderr,
      },
    },
    limits: [
      "Only runtime.promise/runtime.effect reporter name/Display/stack differ; exact raw diagnostics retained and original cause/rejection/cardinality/state/prefix/save-phase/handler checks are mandatory.",
      "No arbitrary JS exceptions/reflection, full routed Agent wire, raw stamp/scheduler or new runtime cancellation parity claim.",
      "Mapper prefix counters and existing policy cache are not rolled back. No transition Step/save/effect on rejection; explicit stop still flushes original state once.",
    ],
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  if (!allowFailures) assert.deepEqual(failures, []);
  return report;
}

const toolMapSourcePins = {
  "packages/tea/src/agent/index.ts":
    "28edeb15977cf7008576574ee8589715272784f1feef260f36b70242da922d65",
  "packages/tea/src/agent/tool-resilience.ts":
    "c75d3eea8092070dd5784d7047c6331fdfcee403ebb3821715f70def1b19e002",
  "packages/tea/src/internal/flow/fan-out/index.ts":
    "5cd5ee63fd71e0e9fdc682134426a88ea4760637ff5a71d64ded0e371dc8a4f8",
};
const frozenToolMapViews = {
  "fan.scatter-first": {
    source: "412af768767b4dfbbfe1d4d2d1583bfd81ba5ec877f15c8ac0e8eaff9dc3bcb5",
    calls: "2fc6a2490578f76f08ce5c4300f95c0a05efc471143099ccd3614b4123af37f7",
  },
  "fan.scatter-prefix": {
    source: "7644bab319c03ec3d56f6ca48469d6ab1b96830111c51a1c17cf40686fcc5f44",
    calls: "2fc6a2490578f76f08ce5c4300f95c0a05efc471143099ccd3614b4123af37f7",
  },
  "fan.backfill-prefix": {
    source: "e57395711b1ddc002fefc84bcba3e4b382c3788d558db63433c1785b3c8a25fd",
    calls: "9205dfb5596ae651af7137d9cb4e032fb99c6c6a5ed22c433be17269a988f437",
  },
  "agent.turn-discarded": {
    source: "5a9bbf85c6caa8332bf0962fee2ce31fc09f31cc9dad9431ab09e7c562b415c5",
    calls: "1c8eaa30aa85a2c173e68e4f8a4fa72cdc2930082a6fe515f828484797b3cc3e",
  },
  "agent.succeed-second-sweep": {
    source: "448984e588f64da149f51594464a3b3846da7d8d4b311d710bfea3010f8bcfd8",
    calls: "5d4c90cfeee83aac3817cd04e4ea18a89cb4746afbb7c16d9c36ef3e4760278d",
  },
  "agent.backfill-ok-discarded": {
    source: "c51f5e47db4df455668276d16f60bd2fff035e41051b8dd647874d73c1ce7191",
    calls: "7161db56cde9540d8d9d92ac87dfe9322c9f2848005558cccb51586bde7ad304",
  },
  "agent.backfill-err-second-sweep": {
    source: "a212537436bdd144094218183e74de51f2c9cb85bcc9acf05cdd02fe6d353bc1",
    calls: "c7fa7e8be8e99b6e4ad94be6415144f8acd1f4af96a3f32bf372175af8ce3368",
  },
  "agent.boot-running": {
    source: "4acfb1f41bcfad0b28c2d2d55baa54fdb21d881d457f1c89ae16ef5a86043d71",
    calls: "5121247eb01b3c7c88f9611fccdf6b4142ad38d6ed94a961cefa088bb8c0221a",
  },
  "agent.boot-waiting-skip": {
    source: "147bf3efd809b5b836f9321f020144996ae52e35a82a48fb4c049ef56dac74f6",
    calls: "57cbfdbae4728c950af7eaa866e39cbf983977a392f0da9b4583d1b7705fec59",
  },
  "agent.timer-retry": {
    source: "5e1f1e6932af18443ed1fb7d96b991ed43dbe834beeb28f8401a0760a8a3e847",
    calls: "aabe272a71d2f0c5e09586fc9e6642f8d14fac974c16fab8af8305b49aa98476",
  },
  "runtime.promise": {
    source: "36e0ec47955d991c4e1eb454d022324f3d9f8710bb989b0021a75de0250ba7ce",
    calls: "e482f240ff1916b8b425a63a20d2f1675faa3372d4472ee7d8af5b97a8d22c74",
  },
  "runtime.effect": {
    source: "36e0ec47955d991c4e1eb454d022324f3d9f8710bb989b0021a75de0250ba7ce",
    calls: "e482f240ff1916b8b425a63a20d2f1675faa3372d4472ee7d8af5b97a8d22c74",
  },
};

function toolMapDigest(value) {
  const ordered = (input) =>
    Array.isArray(input)
      ? input.map(ordered)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, ordered(input[key])]),
          )
        : input;
  return hash(JSON.stringify(ordered(value)));
}

export function agentToolMapCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/agent-tool-map.json"),
  );
  let binary = options.binary;
  let producer = null;
  if (!binary) {
    for (const key of [
      "CARGO_TARGET_DIR",
      "DEMLIK_MUTATION_TARGET_DIR",
      "CARGO_BUILD_TARGET_DIR",
      "CARGO_BUILD_BUILD_DIR",
    ])
      assert.equal(process.env[key], undefined, `${key} must be unset`);
    producer = buildTeaExample(cargo, "agent_tool_map_driver", reportFile);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_tea.path,
      path.join(root, "target"),
    );
    binary = producer.binary;
  }
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const raw = agentToolMapParity({ binary, output: `${reportFile}.raw.json` });
  const report = normalizeAgentToolMapReport(raw, producer);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function normalizeAgentToolMapReport(raw, producer = null) {
  assert.equal(raw.cases, 12);
  assert.equal(raw.passed, 10);
  assert.equal(raw.qualifiedPassed, 2);
  assert.deepEqual(raw.failures, []);
  assert.deepEqual(raw.sourceHashes, toolMapSourcePins);
  assert.match(raw.binaryHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    cases.map((row) => row.id),
    Object.keys(frozenToolMapViews),
  );
  assert.deepEqual(
    raw.observations.map((row) => row.id),
    cases.map((row) => row.id),
  );
  const processRows = (process) => {
    assert.equal(process.status, 0);
    assert.equal(process.signal, null);
    assert.equal(process.stderr, "");
    assert.equal(process.error, undefined);
    const rows = process.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 12);
    return rows;
  };
  const nativeRows = processRows(raw.processes.native);
  const sourceProcess = raw.processes.source;
  let sourceRows;
  if (sourceProcess.reusedSavedSource) {
    assert.equal(sourceProcess.newExecution, false);
    const bytes = fs.readFileSync(sourceProcess.reusedSavedSource);
    assert.equal(hash(bytes), sourceProcess.sha256);
    assert.equal(
      sourceProcess.sha256,
      "e3b8529ef80b3eca78b23bacd5ac386fb8dced36a42888617dda2f26ef6bf9dc",
    );
    const saved = JSON.parse(bytes);
    assert.equal(saved.Source, "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d");
    assert.equal(saved.rows.length, 12);
    sourceRows = saved.rows;
  } else sourceRows = processRows(sourceProcess);
  const strictIds = cases
    .filter((row) => !qualifiedIds.includes(row.id))
    .map((row) => row.id);
  assert.deepEqual(Object.keys(raw.nativeEvidence), strictIds);
  assert.deepEqual(Object.keys(raw.qualifiedNativeEvidence), qualifiedIds);
  const nativeEvidence = {},
    qualifiedNativeEvidence = {};
  for (const [index, fixture] of cases.entries()) {
    const row = raw.observations[index];
    assert.deepEqual(row.input, fixture);
    assert.equal(row.equal, true);
    assert.equal(row.failure, undefined);
    assert.deepEqual(row.source, sourceRows[index]);
    assert.deepEqual(row.native, nativeRows[index]);
    const profile = compareToolMap(row.source, row.native, fixture);
    assert.equal(row.qualified, profile.qualified);
    assert.deepEqual(row.reasons, profile.reasons);
    assert.deepEqual(row.fields, profile.fields);
    assert.deepEqual(row.sourceDiagnostics, profile.sourceDiagnostics);
    assert.deepEqual(row.nativeDiagnostics, profile.nativeDiagnostics);
    const sourceView = structuredClone(row.source.output);
    if (qualifiedIds.includes(row.id)) delete sourceView.diagnostics[0].stack;
    assert.equal(
      toolMapDigest(sourceView),
      frozenToolMapViews[row.id].source,
      `${row.id}: frozen Source output drift`,
    );
    const calls = row.native.observedCalls;
    assert.ok(Array.isArray(calls) && calls.length);
    assert.equal(
      toolMapDigest(calls),
      frozenToolMapViews[row.id].calls,
      `${row.id}: observed calls drift`,
    );
    assert.deepEqual(
      (profile.qualified ? raw.qualifiedNativeEvidence : raw.nativeEvidence)[
        row.id
      ],
      { observedCalls: calls },
    );
    (profile.qualified ? qualifiedNativeEvidence : nativeEvidence)[
      `agent-tool-map.${row.id}`
    ] = calls;
  }
  if (producer) {
    assert.equal(raw.binaryHash, producer.binarySha256);
    assert.equal(hash(fs.readFileSync(producer.binary)), producer.binarySha256);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    const library = producer.libraries.demlik_tea;
    assertCheckPath(library.path, path.join(root, "target"));
    assert.equal(hash(fs.readFileSync(library.path)), library.sha256);
  }
  return {
    ...raw,
    observations: 12,
    passed: 10,
    qualifiedPassed: 2,
    qualifiedEvidenceCases: 2,
    nativeEvidence,
    qualifiedNativeEvidence,
    raw,
    producer,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, output, sourceReport, onlyId] = process.argv.slice(2);
  assert.ok(binary && output);
  const report = agentToolMapParity({
    binary,
    output,
    sourceReport,
    onlyId,
    allowFailures: process.env.DEMLIK_TOOL_MAP_ALLOW_FAILURES === "1",
  });
  console.log(
    JSON.stringify({
      cases: report.cases,
      passed: report.passed,
      qualifiedPassed: report.qualifiedPassed,
      failures: report.failures.length,
    }),
  );
}
