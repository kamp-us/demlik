import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentModelCases } from "./agent-model-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  hash = (value) => createHash("sha256").update(value).digest("hex");
const fn = {
  factory: "demlik_tea::agent::model::model_factory",
  plain: "demlik_tea::agent::model::plain_model",
  loader: "demlik_tea::agent::model::BrainPorts::with_loader",
  handler: "demlik_tea::agent::model::brain_handler",
  invoke: "demlik_tea::agent::model::BrainHandler::handle",
};
function calls(test, source) {
  if (test.operation === "vocabulary")
    return ["demlik_tea::agent::model::PLAIN_MODEL_MISROUTE_REASON"];
  const model = test.input.style === "factory" ? fn.factory : fn.plain;
  const middle = [
    ...(test.input.noLoader ? [] : [fn.loader]),
    fn.handler,
    fn.invoke,
  ];
  if (test.operation === "scenario")
    return [
      model,
      ...middle.slice(0, -1),
      ...Array(test.input.repeats ?? 1).fill(fn.invoke),
    ];
  return [
    model,
    "LlmCall::attempt_keyed",
    ...middle,
    "runtime::launch",
    ...(source.phase === "succeeded"
      ? ["LlmCall::succeed"]
      : ["LlmCall::err_of", "LlmCall::fail"]),
    "runtime::Runtime::ready",
    "runtime::Runtime::done",
    "runtime::Runtime::stop",
  ];
}
function literals(test, out) {
  if (test.operation === "vocabulary") return;
  const ports = test.operation === "scenario" ? out : out.ports;
  if (
    test.id === "agent-model.plain-loaded-transform-raw" ||
    test.id === "agent-model.wrapped-loaded-transform-raw"
  ) {
    assert.equal(out.outcomes[0].output.value, 2);
    assert.equal(out.parses, 2);
  }
  if (test.id === "agent-model.plain-second-schema")
    assert.equal(out.outcomes[0].output.value, 3);
  if (test.id === "agent-model.factory-loaded-transform-raw")
    assert.equal(out.outcomes[0].output.value, 1);
  if (test.id === "agent-model.factory-failure-factory") {
    assert.deepEqual(ports.trace, ["factory"]);
    assert.equal(ports.schemaReads, 0);
  }
  if (test.id === "agent-model.factory-failure-loader") {
    assert.deepEqual(ports.trace, ["factory", "loader"]);
    assert.equal(ports.schemaReads, 0);
  }
  if (
    !test.input.noLoader &&
    test.input.failure !== "factory" &&
    test.operation !== "vocabulary"
  ) {
    assert.ok(ports.retainedCalls.length > 0);
    assert.ok(
      ports.retainedCalls.every(
        (call) => call.inputSame && call.payloadSame && call.value === 1,
      ),
    );
  }
  if (test.id.includes("fresh-empty-repeated")) {
    assert.equal(ports.defaultFresh, true);
    assert.deepEqual(ports.messagesSame, [false, false, false]);
  }
  if (test.operation !== "scenario") {
    assert.equal(out.done, true);
    assert.equal(out.contextSame, true);
    assert.equal(out.settled.at, 100.25);
    assert.deepEqual(out.errors, []);
    if (out.settled.sameCause !== undefined)
      assert.equal(out.settled.sameCause, true);
  }
}
export async function agentModelParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const binary =
    options.binary ??
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/examples/agent_model_driver",
    );
  if (!options.binary)
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "-p",
        "demlik-tea",
        "--example",
        "agent_model_driver",
      ],
      {
        cwd: root,
        stdio: "pipe",
        env: {
          ...process.env,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      },
    );
  const all = agentModelCases();
  assert.equal(new Set(all.map((x) => x.id)).size, all.length);
  if (options.caseIds) {
    assert.ok(options.caseIds.length);
    for (const id of options.caseIds)
      assert.ok(
        all.some((x) => x.id === id),
        id,
      );
  }
  const cases = options.caseIds
      ? all.filter((x) => options.caseIds.includes(x.id))
      : all,
    text = `${cases.map((x) => JSON.stringify(x)).join("\n")}\n`;
  const run = (program, args, input = text) => {
    const out = spawnSync(program, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, "");
    return out.stdout
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
  };
  const source = run(process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(root, "verification/parity/agent-model-reference.mts"),
    ]),
    native = run(binary, []);
  assert.equal(source.length, cases.length);
  assert.equal(native.length, cases.length);
  const failures = [],
    nativeEvidence = {};
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index],
      left = source[index],
      right = native[index];
    try {
      assert.equal(left.id, test.id);
      assert.equal(right.id, test.id);
      assert.equal(left.ok, true);
      assert.equal(right.ok, true);
      assert.deepEqual(right.output, left.output);
      assert.deepEqual(right.observedCalls, calls(test, left.output));
      literals(test, right.output);
      nativeEvidence[test.id] = [...new Set(right.observedCalls)];
    } catch (error) {
      failures.push({
        id: test.id,
        message: error.message,
        source: left,
        native: right,
      });
    }
  }
  const invalid = [
    { id: 1, operation: "scenario", input: { style: "plain" } },
    { id: "bad-style", operation: "scenario", input: { style: "missing" } },
    { id: "missing", operation: "scenario", input: {} },
    {
      id: "extra",
      operation: "scenario",
      input: { style: "plain", extra: true },
    },
    {
      id: "repeat",
      operation: "scenario",
      input: { style: "plain", repeats: 0 },
    },
    {
      id: "runtime-repeat",
      operation: "runtime-promise",
      input: { style: "plain", repeats: 2 },
    },
    { id: "operation", operation: "missing", input: { style: "plain" } },
  ];
  const bad = `${invalid.map((x) => JSON.stringify(x)).join("\n")}\n`,
    badSource = run(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/agent-model-reference.mts"),
      ],
      bad,
    ),
    badNative = run(binary, [], bad);
  assert.equal(badSource.length, invalid.length);
  assert.equal(badNative.length, invalid.length);
  assert.ok(badSource.every((x) => !x.ok));
  assert.ok(badNative.every((x) => !x.ok && x.observedCalls.length === 0));
  const qualified = ["missing", "undefined"].map((variant) => ({
    id: `agent-model.input-${variant}`,
    operation: "input-boundary",
    input: { variant },
  }));
  const qualifiedText = `${qualified.map((x) => JSON.stringify(x)).join("\n")}\n`;
  const qualifiedSource = run(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/agent-model-reference.mts"),
      ],
      qualifiedText,
    ),
    qualifiedNative = run(binary, [], qualifiedText);
  assert.equal(qualifiedSource.length, 2);
  assert.equal(qualifiedNative.length, 2);
  const qualifiedObservations = qualified.map((test, index) => {
    const left = qualifiedSource[index],
      right = qualifiedNative[index];
    assert.equal(left.id, test.id);
    assert.equal(right.id, test.id);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    assert.equal(left.output.outcome, "Err");
    assert.equal(left.output.tag, "port_rejected");
    assert.equal(left.output.cause.error.name, "TypeError");
    assert.deepEqual(left.output.trace, []);
    assert.deepEqual(right.output, {
      refusal: { kind: "MissingInput", command: "resilient_run" },
      trace: [],
    });
    assert.ok(!Object.hasOwn(nativeEvidence, test.id));
    return {
      id: test.id,
      status: "OPEN",
      strictParity: false,
      source: left.output,
      native: right.output,
      observedCalls: right.observedCalls,
    };
  });
  const report = {
    reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    node: process.version,
    v8: process.versions.v8,
    cases: cases.length,
    passed: cases.length - failures.length,
    runtimeCases: cases.filter((x) => x.operation.startsWith("runtime-"))
      .length,
    protocolRefusals: invalid.length,
    failures,
    nativeEvidence,
    qualifiedObservations,
    caseIds: cases.map((x) => x.id),
    inputSha256: hash(text),
    baselineBinarySha256: hash(fs.readFileSync(binary)),
    sourceHashes: Object.fromEntries(
      [
        "packages/tea/src/agent/model.ts",
        "packages/tea/src/internal/llm-call/index.ts",
      ].map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]),
    ),
    openGaps: [
      "OPEN: supported native RunInput::Missing/Undefined returns LlmCallError::MissingInput; frozen brainHandler returns LlmRejected port_rejected with caught TypeError. Qualified observations are excluded from strict/nativeEvidence.",
    ],
    nativeProfile:
      "Explicit native plain/factory kinds and caller-driven local futures with declared Result failures. JS function tags, arity/prototypes/thenables/getters/mutable methods and native panic-vs-Result are separately measured Source-only profiles. No arbitrary Promise scheduling, provider/SDK/streaming host or full-agent claim.",
  };
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/agent-model.json");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          ...report,
          nativeEvidence: { cases: Object.keys(nativeEvidence).length },
          failures: failures.slice(0, 4),
          reportFile,
        },
        null,
        2,
      ),
    );
  if (!options.allowFailures) assert.deepEqual(failures, []);
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await agentModelParity();
