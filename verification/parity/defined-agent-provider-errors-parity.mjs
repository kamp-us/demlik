import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";
import { buildTeaExample, buildTeaTest } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const reference = "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d";
const fixture = "verification/parity/defined-agent-provider-errors-source.mts";
const scope = read(path.join(root, "verification/parity/scope.json"));
const ids = [
  "provider-rich",
  "provider-error",
  "schema-guard",
  "content-error",
];
const trace = [
  "demlik_tea::agent::DefineAgentConfig::new",
  "demlik_tea::agent::define_agent",
  "demlik_tea::agent::DefinedAgent::run",
];
const rich = {
  code: "provider_busy",
  status: 429,
  nested: {
    requestId: "request-17",
    retry: { afterMs: 125, attempts: [1, 2] },
  },
};

// This existing content-error profile has exactly two LlmErr locations in a state.
function contentStateProfile(state) {
  for (const error of [
    state.failure?.error,
    state.resilience.calls.act?.error,
  ]) {
    if (error === undefined) continue;
    assert.deepEqual(error, {
      key: "act",
      purpose: "act",
      reason: "[object Object]",
      error: rich,
    });
    error.reason = "tool content callback failed";
    error.error = {};
  }
  return state;
}
function contentEventProfile(events) {
  for (const event of events) {
    if (event.type !== "RunDone") continue;
    assert.deepEqual(event.status.failure.error, {
      key: "act",
      purpose: "act",
      reason: "[object Object]",
      error: rich,
    });
    event.status.failure.error.reason = "tool content callback failed";
    event.status.failure.error.error = {};
  }
  return events;
}
export function definedAgentProviderErrorsParity(cargo, options = {}) {
  assert.equal(
    options.binary,
    undefined,
    "binary override is not supported; execute only Cargo-selected bytes",
  );
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, key);
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  assert.equal(scope.reference, reference);
  execFileSync(
    "git",
    [
      "diff",
      "--exit-code",
      reference,
      "--",
      "packages/tea/src",
      "packages/tea/package.json",
    ],
    { cwd: root },
  );
  assert.equal(
    execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "packages/tea/src"],
      { cwd: root, encoding: "utf8" },
    ),
    "",
  );
  const target = path.join(root, "target/parity");
  fs.mkdirSync(target, { recursive: true });
  const proof = options.proofDirectory
    ? path.resolve(options.proofDirectory)
    : fs.mkdtempSync(path.join(target, "defined-agent-provider-errors-"));
  fs.mkdirSync(proof, { recursive: true });
  const steps = [];
  function execute(name, executable, args) {
    const result = spawnSync(executable, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
    const directory = path.join(proof, name);
    fs.mkdirSync(directory, { recursive: true });
    for (const key of ["stdout", "stderr"])
      fs.writeFileSync(path.join(directory, key), result[key] ?? "");
    const receipt = {
      command: [executable, ...args],
      exit: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
    };
    fs.writeFileSync(
      path.join(directory, "process.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    steps.push({ name, ...receipt });
    assert.equal(receipt.error, null, name);
    assert.equal(receipt.signal, null, name);
    assert.equal(receipt.exit, 0, `${name}: ${result.stderr}`);
    assert.equal(result.stderr, "", `${name}: stderr`);
    return result.stdout;
  }
  const sourceText = execute("source", process.execPath, [
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(root, fixture),
  ]);
  let sourceBefore;
  if (options.sourceBefore) {
    const directory = path.resolve(options.sourceBefore);
    sourceBefore = { ...read(path.join(directory, "process.json")), directory };
    assert.equal(sourceBefore.exit, 0);
    assert.equal(sourceBefore.signal, null);
    assert.equal(sourceBefore.error, null);
    assert.equal(sourceBefore.sourceSha256, hash(path.join(root, fixture)));
    assert.equal(
      fs.readFileSync(path.join(directory, "stdout"), "utf8"),
      sourceText,
      "complete Source views captured before semantic edits remain unchanged",
    );
    assert.notEqual(
      sourceBefore.rustBeforeSha256,
      hash(path.join(root, "crates/tea/src/agent/defined.rs")),
    );
  }
  const producer = buildTeaExample(
    cargo,
    "defined_agent_provider_errors",
    path.join(proof, "producer"),
  );
  const before = hash(producer.binary);
  assert.equal(before, producer.binarySha256);
  const nativeText = execute("native", producer.binary, []);
  const sources = sourceText.trim().split("\n").map(JSON.parse),
    natives = nativeText.trim().split("\n").map(JSON.parse);
  assert.equal(sources.length, ids.length);
  assert.equal(natives.length, ids.length);
  const rows = [],
    qualifiedNativeEvidence = {};
  for (const [index, name] of ids.entries()) {
    const source = sources[index],
      native = natives[index];
    assert.equal(source.id, name);
    assert.equal(native.id, name);
    const s = source.phase,
      n = native.phase,
      label = `tea.defined-agent-provider-errors.${name}`;
    assert.deepEqual(n.nativeTrace, trace);
    assert.equal(
      n.classification,
      name === "schema-guard"
        ? "Guard"
        : name === "content-error"
          ? "Content"
          : "Provider",
    );
    assert.equal(s.failureClass, "DriveFailedError");
    assert.equal(n.failureClass, "DriveError::Failed");
    for (const field of [
      "prompts",
      "calls",
      "contentCalls",
      "toolCalls",
      "outcome",
      "ownership",
    ])
      assert.deepEqual(n[field], s[field], `${label}: ${field}`);
    assert.equal(n.outcome, "failed");
    assert.equal(n.final.failure.reason, "llm");
    const content = name === "content-error";
    const expectedSaves = content
      ? structuredClone(s.saves).map(contentStateProfile)
      : s.saves;
    const expectedFinal = content
      ? contentStateProfile(structuredClone(s.final))
      : s.final;
    const expectedEvents = content
      ? contentEventProfile(structuredClone(s.events))
      : s.events;
    assert.deepEqual(n.saves, expectedSaves, `${label}: all saved states`);
    assert.deepEqual(
      n.final,
      expectedFinal,
      `${label}: complete canonical final`,
    );
    assert.deepEqual(
      n.events,
      expectedEvents,
      `${label}: complete semantic events`,
    );
    assert.equal(n.saveWires.length, s.saveWires.length);
    for (const [i, wire] of n.saveWires.entries())
      assert.equal(
        wire,
        content
          ? JSON.stringify(contentStateProfile(JSON.parse(s.saveWires[i])))
          : s.saveWires[i],
        `${label}: complete Store string ${i}`,
      );
    assert.equal(
      n.finalWire,
      content
        ? JSON.stringify(contentStateProfile(JSON.parse(s.finalWire)))
        : s.finalWire,
      `${label}: final string`,
    );
    const qualifications = [
      {
        profile: "NATIVE-ERROR-OWNER",
        source:
          "JavaScript thrown value and DriveFailedError with original .state",
        native:
          "typed Provider/Guard/Content and DriveError::Failed with original Rc state",
        reason:
          "Both original error and nested owner probes must pass. No cross-language prototype, stack or raw Error identity equality is claimed.",
      },
    ];
    if (content)
      qualifications.push({
        profile: "EXISTING-NATIVE-CONTENT-ERROR",
        fields: [
          "failure.error",
          "resilience.calls.act.error",
          "RunDone.status.failure.error",
        ],
        source: { reason: "[object Object]", error: rich },
        native: { reason: "tool content callback failed", error: {} },
        reason:
          "The existing content callback profile is unchanged. Its rich original Rc remains native typed data; its existing wire and reason differ. Comparison applies only this explicitly checked profile at the named locations.",
      });
    rows.push({
      id: label,
      passed: true,
      status: "qualified",
      classification: n.classification,
      saves: n.saves.length,
      rawSaveStringsEqual: n.saveWires.filter(
        (wire, i) => wire === s.saveWires[i],
      ).length,
      rawFinalStringEqual: n.finalWire === s.finalWire,
      qualifications,
    });
    qualifiedNativeEvidence[label] = n.nativeTrace;
  }
  const opaqueProducer = buildTeaTest(
    cargo,
    "defined_agent_provider_errors",
    path.join(proof, "opaque-producer"),
  );
  const opaqueBefore = hash(opaqueProducer.binary);
  execute("opaque-native", opaqueProducer.binary, [
    "--exact",
    "no_tool_provider_failure_keeps_opaque_owners_through_drive_and_semantic_event",
    "--nocapture",
  ]);
  assert.equal(hash(opaqueProducer.binary), opaqueBefore);
  assert.equal(hash(producer.binary), before);
  const report = {
    status: "passed",
    reference,
    engine: scope.referenceEngine,
    cases: ids.length,
    passed: 0,
    qualifiedPassed: ids.length,
    failures: [],
    nativeEvidence: {},
    qualifiedNativeEvidence,
    rows,
    producer,
    opaqueProducer,
    executionBinary: producer.binary,
    rustBinarySha256: before,
    binaryAfterSha256: hash(producer.binary),
    sourceBefore,
    sourceProductTree: execFileSync(
      "git",
      ["rev-parse", `${reference}:packages/tea/src`],
      { cwd: root, encoding: "utf8" },
    ).trim(),
    authoredSourceSha256: hash(path.join(root, fixture)),
    adapterSha256: hash(fileURLToPath(import.meta.url)),
    nativeOwnerSha256: hash(path.join(root, "crates/tea/src/agent/defined.rs")),
    nativeConsumerSha256: hash(
      path.join(root, "crates/tea/examples/defined_agent_provider_errors.rs"),
    ),
    steps,
    rawRecords: { proof },
    limitations: [
      "Controlled local model only; no paid provider or network call.",
      "In-process canonical state; no decoded cold-restart or native JavaScript Error/prototype/stack reconstruction claim.",
      "Content callback wire/reason behavior is independently verified with the explicit existing native qualification; provider errors retain their complete serializable data.",
    ],
    globalParityCreditAdded: 0,
  };
  fs.writeFileSync(
    path.join(proof, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (options.reportFile)
    fs.writeFileSync(
      path.resolve(options.reportFile),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    JSON.stringify(
      definedAgentProviderErrorsParity(process.env.CARGO ?? "cargo"),
    ),
  );
