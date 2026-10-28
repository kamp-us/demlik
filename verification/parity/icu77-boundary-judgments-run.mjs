import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases, filesFor } from "./icu77-boundary-cases.mjs";

const { z } = createRequire(import.meta.url)("zod"),
  root = fileURLToPath(new URL("../..", import.meta.url));
const sourcePins = {
  "boundaries/analyze":
    "dae0c57a3b4f7816a744cdbe4c820899dccf043a95184d0bdcbf3055fbc70ad7",
  "boundaries/impure-uses":
    "b26549228c7f12e7709d3c12110570854a5c3e1b232c443befeeb05df4831dee",
  "boundaries/libraries/libraries":
    "c200d3cc8cdcc6ce60f70fc7bd0a6f9248e7c31bc31579b0c8392b4e67a8659c",
  "boundaries/libraries/violations":
    "ae4085f3febb135c820690f44b5500c5eda7ccab536e70bb8ec966fde4a930cf",
  "boundaries/deployables/cycles":
    "5dde47e0ded6603f0d90a659d3127860e124c1a722e22de023fe519b4d3f4aa8",
  "boundaries/deployables/bindings":
    "3c7bac45d22a72865c93ada80343f4600e1a6a7e7d68d0719c420e3c09236821",
  "boundaries/deployables/deployables":
    "ee3dcdb9d1f5f30ff204cc0dfaf004f058c445ed8295d56a1afe713a16868924",
  "boundaries/deployables/judge":
    "49e512ff9eb7da702e63748b9f3445e2782056ea7f2763f94a611d39e3c4522f",
  "boundaries/rules":
    "bc9b3ce41197c77658966b327dba0db0b97446a7a9419c60e626eb9831c199f1",
  "boundaries/shape/shape":
    "919ce88633ff8da9e008e992dd8aea1dceaa25e743ac879c6c0a94a0cf3a2326",
  "extract/wrangler-config":
    "2050b3506fc9e8877a94ca4fa8cf6391e9e83f0c40f06d12193ec1e22e7925be",
  "extract/project":
    "08aa30497ce1dde9d1d8587fc5f17bfd77c47de7206222d12285db5bad5cf69a",
  "boundaries/gate":
    "c133edb0a301b76961f3ec385b046f4dab7b1eea3d62387ecb5258b176cf764f",
  "boundaries/ledger":
    "ffa441859cfc2bd8140c53ee8804de72b068d4903b4e4c67116433cc8de2f9fa",
  "boundaries/reconcile":
    "410d30437e36fa17f9c63ffc2e3ebef22690303256a8c62e56d195c8613edc49",
  "test-helpers/source-unit":
    "8bacd95af6f3a580d60e266cdc3e7e8f75e53c08f8c8d249eb701620eff154ec",
};
const sourceWholeviews = {
  "empty-aggregate":
    "efe12a3e4c9ea0f9bc8aa9ee96a3492968ddf765a26999d3412f45a9287c6580",
  "impure-static-raw-paths":
    "6c0d8fcfd239cf02f1942cc76632ffa7dad282a51d7edd5447435aa274d58ee1",
  "impure-shadow-and-type":
    "a4982ab973cf32f00a9d965ceadf78915aa28b2bb136d137bc670f956dd30d1a",
  "impure-destructure-joined-order":
    "0550057541f7cf9490cf9d4777dd07937fd1d3dd53803f74bc3a5b885e2a622b",
  "undeclared-nearest-roots":
    "97909405ecb056f2a6003d7dd2519c470e1db4e10645d1327c4569aa379a6763",
  "aggregate-three-priorities":
    "f96fb1dcf0d8fe973a7f275a17a1fc240172531947d1f1e4e9f85c171ad7469e",
  "feature-and-test-entry-order":
    "bb05db96e2b97ec48c0a3b95ae890d1caf914d10ef06ba7245a561dd0030022d",
  "shared-write-original-owner":
    "2720334d5f7c361c429f2846a820b167fe067ba162a9e1c36512ec901cf07c38",
  "application-judged-edge-identity":
    "daddda1a51c4415b3eaaad184687dd5eec41a85c23f483e3891a7628aa15307e",
  "bindings-sorted-dedup-raw":
    "aa44645f4bbf6f03f9f53aa33b315f53df702c50880d31abf6eb8576ae158f63",
  "binding-owner-inherited-refusal":
    "da8db1b5535614c34564038227b7010cdb2dfdb6360e25a506bc8d08c4d5a6de",
  "binding-main-and-owned":
    "5f2e2e26ace11c54c7b2c6f624765c204fb40db0667ac29be0dc5abb372bc748",
  "deployables-disabled":
    "ff66c0dbfc14b4063e23bed6973239d858360a9b7f4379d814d2a0d73d64ec6e",
  "deployables-unparsed-refusal":
    "4b39891254fb800b2e5458883d286d68fb8174a39939aae297ee2ebce2f7639c",
  "worker-service-self-unknown":
    "f1ec128ba3e740f187fda0aba1b2c7145734e35e43470f8614400a078e247f9c",
  "worker-ring-chord-component":
    "586f8eb67664b9fb8ac1b70a706a09f6dab05d3caf6cd20a460df8c2946384b7",
  "worker-multiple-unicode-components":
    "7856b9c9687ff6e71cfeb41f3f4dab64e4a3563203c6b1096dabc658f3a5ad47",
  "gate-mode-admission-no-write":
    "9cb2ce4754541e55201025133835a999ac9703fb5507f52ad31a973edcc1b893",
  "two-scope-real-workflow":
    "dffa4483733f3ee7638a86700c1693f316173f754a51013b82adfc88958bc7ad",
  "deployables-workspace-after-graph":
    "e86f840ff23eb4d1889120322857ed07bb70a7e103c12265b8cf124dadf40efd",
};

const archivedRuntime =
  "/private/tmp/demlik-check-icu77-group-j-01a16c9d/runtime";
const protocolIds = [
  "protocol.invalid-json",
  "protocol.missing-id",
  "protocol.unknown-field",
  "protocol.numeric-root",
  "protocol.numeric-binding",
];
const actions = [
  "report",
  "record",
  "repeat-ci",
  "repeat-record-no-write",
  "add-drift",
  "record-api-scope",
  "remove-and-prune",
  "other-scope",
  "final-report",
];
const response = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.string(),
    ok: z.literal(true),
    output: z.unknown(),
    observedCalls: z.array(z.string()),
  }),
  z.strictObject({
    id: z.string().nullable(),
    ok: z.literal(false),
    error: z.strictObject({
      name: z.string().min(1),
      message: z.string().min(1),
    }),
    observedCalls: z.array(z.string()),
  }),
]);
const processFrame = z.strictObject({
  status: z.literal(0),
  signal: z.null(),
  stdout: z.string(),
  stderr: z.literal(""),
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const prefix = "demlik_code_graph::",
  catalog = `${prefix}extract::wrangler_config::load_binding_catalog`,
  parsed = `${prefix}boundaries::rules::BoundaryRules::parse`,
  gate = `${prefix}boundaries::gate::run_boundary_gate`;
function expectedCalls(item) {
  switch (item.mode) {
    case "workflow":
      return actions.map(() => gate);
    case "gate":
      return [gate];
    case "impure":
      return [`${prefix}boundaries::impure_uses::detect_impure_uses`];
    case "bindings":
      return [`${prefix}boundaries::deployables::bindings::binding_violations`];
    case "worker":
      return [
        catalog,
        ...["worker_graph", "worker_cycles"].map(
          (n) => `${prefix}boundaries::deployables::cycles::${n}`,
        ),
      ];
    case "read":
      return [
        catalog,
        parsed,
        `${prefix}boundaries::deployables::read_deployables`,
      ];
    case "libraries":
      return [
        catalog,
        parsed,
        `${prefix}boundaries::libraries::read_libraries`,
        ...item.roots.flatMap(() => [
          `${prefix}boundaries::libraries::undeclared_under`,
          `${prefix}boundaries::libraries::violations::undeclared_libraries`,
        ]),
      ];
    case "analyze":
      return [
        catalog,
        parsed,
        `${prefix}boundaries::libraries::read_libraries`,
        `${prefix}boundaries::deployables::read_deployables`,
        `${prefix}boundaries::shape::read_shape`,
        `${prefix}boundaries::analyze::analyze_boundaries`,
      ];
    default:
      throw new Error("unknown frozen mode");
  }
}
function snapshot(value, label) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `file snapshot: ${label}`,
  );
  for (const [file, row] of Object.entries(value)) {
    assert.ok(
      !path.isAbsolute(file) && !file.split("/").includes(".."),
      `relative fixture file: ${label}`,
    );
    assert.deepEqual(Object.keys(row).sort(), ["base64", "mode"]);
    assert.equal(typeof row.base64, "string");
    assert.equal(
      Buffer.from(row.base64, "base64").toString("base64"),
      row.base64,
      `file bytes: ${label}/${file}`,
    );
    assert.ok(
      Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777,
      `file mode: ${label}/${file}`,
    );
  }
}
function gateRaw(actual, label) {
  assert.equal(actual.ok, true);
  assert.deepEqual(
    Object.keys(actual.output).sort(),
    ["emitted", "exitCode", "ledgerWritten", "reports"],
    `gate view: ${label}`,
  );
  assert.equal(typeof actual.output.ledgerWritten, "boolean");
  const { ledgerWritten: _observedFilesystemWrite, ...output } = actual.output;
  return { ...actual, output };
}
function validateProcess(proc, actual, label, gateView = false) {
  assert.equal(
    processFrame.safeParse(proc).success,
    true,
    `process envelope: ${label}`,
  );
  assert.equal(
    response.safeParse(actual).success,
    true,
    `response envelope: ${label}`,
  );
  assert.deepEqual(
    JSON.parse(proc.stdout),
    gateView ? gateRaw(actual, label) : actual,
    `raw process frame: ${label}`,
  );
  return {
    status: proc.status,
    signal: proc.signal,
    stdoutUtf8Sha256: hash(proc.stdout),
    stderrUtf8Sha256: hash(proc.stderr),
  };
}
export function sharedBoundaryJudgments(report, rawFile, expectedBinarySHA) {
  assert.equal(report.attempted, 20);
  assert.equal(report.passed, 20);
  assert.equal(report.unqualifiedPairs, 20);
  assert.equal(report.qualifiedPairs, 0);
  assert.equal(report.rejectedInvalidInputs, 5);
  assert.equal(report.rejectedInvalidInputRows ?? 5, 5);
  assert.equal(report.responseGuards, 3);
  assert.deepEqual(report.failures, []);
  assert.match(expectedBinarySHA, /^[0-9a-f]{64}$/);
  assert.equal(report.rustBinarySha256, expectedBinarySHA, "binary identity");
  assert.equal(
    report.reference.Source,
    "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
  );
  assert.equal(report.reference.node, "v22.21.1");
  assert.equal(report.reference.v8, "12.4.254.21-node.33");
  assert.equal(report.reference.icu, "77.1");
  assert.deepEqual(report.reference.sourceHashes, sourcePins, "16 Source pins");
  for (const [f, sha] of Object.entries(sourcePins))
    assert.equal(
      hash(
        fs.readFileSync(path.join(root, "packages/code-graph/src", `${f}.ts`)),
      ),
      sha,
      `current Source: ${f}`,
    );
  const ids = cases.map((x) => x.id);
  assert.equal(new Set(ids).size, 20);
  assert.deepEqual(
    report.cases.map((r) => r.id),
    [...ids, ...protocolIds],
    "exact IDs",
  );
  assert.deepEqual(Object.keys(report.nativeEvidence), ids);
  assert.deepEqual(Object.keys(report.qualifiedNativeEvidence), []);
  const processEvidence = {};
  for (const row of report.cases) {
    assert.equal(row.passed, true);
    assert.notEqual(row.nativeOnly, true);
    if (protocolIds.includes(row.id)) {
      assert.equal(row.protocol, true);
      processEvidence[row.id] = [
        validateProcess(row.process, row.actual, row.id),
      ];
      assert.equal(row.actual.ok, false, `protocol refusal: ${row.id}`);
      assert.equal(row.actual.id, null);
      assert.equal(row.actual.error.name, "ProtocolError");
      assert.deepEqual(row.actual.observedCalls, []);
      continue;
    }
    assert.notEqual(row.protocol, true);
    assert.deepEqual(row.qualifications, [], `qualification: ${row.id}`);
    const item = cases.find((x) => x.id === row.id);
    assert.deepEqual(row.input, item, `exact input: ${row.id}`);
    const { files: _files, ...values } = item;
    assert.deepEqual(
      row.request,
      { ...values, root: row.root },
      `exact request: ${row.id}`,
    );
    assert.equal(typeof row.root, "string");
    assert.ok(path.isAbsolute(row.root));
    assert.equal(path.basename(row.root), row.id);
    if (row.root !== path.join(archivedRuntime, row.id))
      assert.ok(
        path.basename(path.dirname(row.root)).startsWith("demlik-j-pairs-"),
        "fresh worker runtime",
      );
    snapshot(row.before, `${row.id}.before`);
    snapshot(row.sourceAfter, `${row.id}.sourceAfter`);
    snapshot(row.after, `${row.id}.after`);
    assert.deepEqual(
      row.after,
      row.sourceAfter,
      `actual after bytes/modes: ${row.id}`,
    );
    const files = filesFor(item);
    assert.deepEqual(Object.keys(row.before).sort(), Object.keys(files).sort());
    for (const [f, bytes] of Object.entries(files))
      assert.equal(
        row.before[f].base64,
        Buffer.from(bytes).toString("base64"),
        `initial fixture bytes: ${row.id}/${f}`,
      );
    assert.equal(
      response.safeParse(row.actual).success,
      true,
      `response envelope: ${row.id}`,
    );
    assert.equal(row.actual.id, row.id);
    const calls = expectedCalls(item);
    assert.deepEqual(
      row.actual.observedCalls,
      calls,
      `actual calls: ${row.id}`,
    );
    assert.deepEqual(row.nativeTrace, { observedCalls: calls });
    assert.deepEqual(report.nativeEvidence[row.id], row.nativeTrace);
    if (item.mode === "workflow") {
      assert.equal(row.actual.ok, true);
      assert.deepEqual(Object.keys(row.actual.output), ["steps"]);
      const steps = row.actual.output.steps;
      assert.deepEqual(
        steps.map((s) => s.name),
        actions,
        "all nine workflow actions",
      );
      assert.equal(row.processes.length, 9);
      assert.equal(row.responses.length, 9);
      assert.equal(row.process, undefined);
      processEvidence[row.id] = [];
      for (let i = 0; i < 9; i++) {
        const step = steps[i],
          frame = row.responses[i];
        assert.deepEqual(Object.keys(step).sort(), [
          "after",
          "before",
          "name",
          "result",
        ]);
        snapshot(step.before, `${row.id}.${step.name}.before`);
        snapshot(step.after, `${row.id}.${step.name}.after`);
        assert.equal(frame.id, `${row.id}.${step.name}`);
        assert.deepEqual(
          frame.observedCalls,
          [gate],
          `workflow actual calls: ${step.name}`,
        );
        assert.deepEqual(
          frame.output,
          step.result,
          `workflow response projection: ${step.name}`,
        );
        processEvidence[row.id].push(
          validateProcess(
            row.processes[i],
            frame,
            `${row.id}.${step.name}`,
            true,
          ),
        );
      }
      assert.deepEqual(steps[0].before, row.before);
      assert.deepEqual(steps[8].after, row.after);
    } else {
      assert.equal(row.processes, undefined);
      assert.equal(row.responses, undefined);
      processEvidence[row.id] = [
        validateProcess(row.process, row.actual, row.id, item.mode === "gate"),
      ];
      assert.deepEqual(row.before, row.after, `no file write: ${row.id}`);
    }
    if (row.actual.ok) {
      assert.deepEqual(Object.keys(row.expected), ["output"]);
      assert.deepEqual(
        row.actual.output,
        row.expected.output,
        `whole Source view: ${row.id}`,
      );
    } else {
      assert.deepEqual(Object.keys(row.expected), ["error"]);
      assert.deepEqual(
        row.actual.error,
        row.expected.error,
        `whole Source refusal: ${row.id}`,
      );
    }
    // Frozen views contain no runtime-root strings. Preserve error text and file bytes verbatim.
    assert.equal(
      hash(
        JSON.stringify(
          canonical({
            input: row.input,
            before: row.before,
            expected: row.expected,
            sourceAfter: row.sourceAfter,
          }),
        ),
      ),
      sourceWholeviews[row.id],
      `frozen Source wholeview: ${row.id}`,
    );
  }
  return {
    ...report,
    rejectedInvalidInputRows: 5,
    processEvidence,
    scope:
      "J12 finite boundary verdict, impurity, undeclared-library and worker-topology views through existing checked ICU77 owners.20strict; five protocol refusals/three guards earn0extra. The nine-action real two-scope workflow is one case. Supplied aggregate/binding facts are separate from actual syntax/catalog/gate reads. Current inventory tracks remaining legacy sites; Census/NaN, raw/reflection/host and all53CLI gaps remain OPEN.",
    observationProfiles: {
      suppliedFacts: cases
        .filter((x) => x.mode === "analyze" || x.mode === "bindings")
        .map((x) => x.id),
      actualSyntax: cases.filter((x) => x.mode === "impure").map((x) => x.id),
      realFilesystemWorkflow: ["two-scope-real-workflow"],
      workflowActions: 9,
      workflowCases: 1,
      gateLedgerWritten:
        "Actual filesystem timestamp/inode projection retained in the raw worker, distinct from the Rust process output frame.",
      runtimeRootNormalization: [],
      extractionCreditAddedByAdapter: 0,
    },
    nativeOnlyRecording: {
      rawReport: rawFile,
      ids: [],
      nativeExecutions: 0,
      comparisonCredit: 0,
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, reportFile] = process.argv.slice(2);
  assert.ok(binary && reportFile && process.argv.length === 4);
  const binaryHash = () => hash(fs.readFileSync(binary)),
    before = binaryHash(),
    rawFile = `${reportFile}.raw.json`;
  let operationError, identityError;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(
          new URL("./icu77-boundary-judgments.mjs", import.meta.url),
        ),
        binary,
        rawFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
    );
    const result = sharedBoundaryJudgments(
      JSON.parse(fs.readFileSync(rawFile, "utf8")),
      rawFile,
      before,
    );
    fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`);
  } catch (e) {
    operationError = e;
  } finally {
    try {
      assert.equal(
        binaryHash(),
        before,
        "binary identity after worker/admission",
      );
    } catch (e) {
      identityError = e;
    }
  }
  if (operationError && identityError)
    throw new AggregateError(
      [operationError, identityError],
      "boundary worker/admission and identity checks failed",
    );
  if (identityError) throw identityError;
  if (operationError) throw operationError;
}
