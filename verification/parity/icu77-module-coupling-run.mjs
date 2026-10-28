import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases, filesFor } from "./icu77-coupling-cases.mjs";

const { z } = createRequire(import.meta.url)("zod");
const root = fileURLToPath(new URL("../..", import.meta.url));
const sourcePins = {
  "smells/coupling":
    "524050ec76ab072125c53940746b4c7ab76364c60bf71994c00f7d24b274f027",
  "extract/scc":
    "1c2ad682a79a8c53857d25627acedf204801c1cced27e073ce990477d06f7e44",
  "extract/project":
    "08aa30497ce1dde9d1d8587fc5f17bfd77c47de7206222d12285db5bad5cf69a",
  "extract/assemble":
    "b30d35677ccd714af2bb00c9b94374a0d7d621f2be5957f0e08a54cad829b644",
  "query/clusters":
    "bf2c7ca47d481441525f9d86db72751fdcf673b1bdfab8d5130a3f3a5d3afdca",
  "query/louvain":
    "d9e4b77b5552643b60ee6b0e34ceae2fe6ab45c151765a13589cb4981cd56e94",
  "render/smells":
    "c3a4bb7aee00f9e62b55b9394d2f1abb3976b2d2ea8effdbc5c45d9808dc02a1",
  "render/analysis":
    "0dd853e703dd0b0dcd8ce8880b84e5cc01e6122a898767904de5a2ab04eb78d2",
  schema: "8fb99e84b915c640cf739caa3e27f051891bb94ca93feb5c481ff66397d92329",
  "kinds/rules":
    "ead81e3deaf76bc3bd1f1072a919ccfc62d196dc1342b0b3b20d02fcfece938e",
};
const sourceWholeviews = {
  "coupling-empty":
    "7b95fc59b2087c9bcfe2b2fe6c46d141da255300d072281d13b311cc9e997741",
  "coupling-input-map-order":
    "884374d42cb7e589f577f902f0948870b3f29a3309a1372526b46a3f9ef9f5bb",
  "value-edge-exclusions":
    "651ac8269c9ccd9ff21fece4b3f394a9caec8026f97c99226ec628eef8ffcae3",
  "value-edge-kinds":
    "6d4fb3f949d4e639f0b9756055b0857e1cf796c0cb3eae999c5ad90c284c2606",
  "value-edge-unicode-order":
    "4f8b6e9c84afdfb4f33037f43553f5e4013a3cf4fe76f18d80280b87c285b751",
  "value-edge-stable-normalization":
    "653ad847f8aba0205d06f008355e27dc5b976817a74dca58ed4b6477f6278081",
  "two-node-cycle":
    "9704923a9b5dc6d369c00824682eb66f62f370e2590536fcb60e01aeed345246",
  "multiple-cycles-bridge-isolate":
    "ed542f261715a024baa57064b8adf1e03c07e1eda20dd240df2f9ea953907222",
  "nested-package-boundaries":
    "49a52bbb465c55df93fa058058e6626067d99bb17b12afc421b69b1aa74bda54",
  "literal-tab-edge-collision":
    "b3cc34774730898bc4fb024533cf7509d78d81f4ecdf73f7b4fc8a97c5577582",
  "rank-score-before-file":
    "7da81bd73483d196d6e98a4e926d8f10d6f3d84bc47a204ee753440992a734f5",
  "rank-equal-score-file-order":
    "ab51143ecf5c8d41eb48463aad5baaa174c727da129abd34116780533919e217",
  "cross-boundary-group-order":
    "6a152e66572a1e2860e28ac5c55e77afbbf7068c8366fc743a1e81d169aa3cfe",
  "duplicate-module-first-map-slot":
    "c7c563ecebdc4f51b045e50e9ff8f15551503a2b35ce1e631acdf19ef7c539d0",
  "render-early-guards":
    "2efec317e105500c7925f4face735e58fce6d5b4c3a796d9dfccfd227bbaba85",
  "render-threshold-coupling":
    "cb35bd3371122128804476065d90e1bdf56a89682718727132efaa07bd6458f7",
  "syntax-only-no-config":
    "9420aeb08363aa9a50d7c92f5a00e3682ea68e5e95634d254f5327e0b07e56d8",
  "two-package-official-go":
    "7ce1a224b0e4b35837918c75fec568a8b0732ce9ceaa812ad72422e40b31cc8c",
};
// The archived producer ran Source in this cwd; fresh CLI runs are pinned to root.
const archivedCwd = "/private/tmp/demlik-check-icu77-group-i-01a16c9d/repo";
const archivedRuntime =
  "/private/tmp/demlik-check-icu77-group-i-01a16c9d/runtime";
const protocolIds = [
  "protocol.invalid-json",
  "protocol.missing-id",
  "protocol.unknown-field",
  "protocol.numeric-root",
  "protocol.numeric-module-file",
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
    error: z.string().min(1),
    observedCalls: z.array(z.string()),
  }),
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function wholeview(item, expected, fixtureRoot) {
  if (item.mode !== "cheap" && item.mode !== "workflow") return expected;
  const archived = fixtureRoot === path.join(archivedRuntime, item.id);
  const workerCwd = archived ? archivedCwd : root;
  if (!archived)
    assert.ok(
      path.basename(path.dirname(fixtureRoot)).startsWith("demlik-i-pairs-"),
      "fresh worker runtime",
    );
  assert.equal(
    expected.output.graph.root,
    path.relative(workerCwd, fixtureRoot) || ".",
    `logical graph root: ${item.id}`,
  );
  const graph = { ...expected.output.graph, root: "<runtime-root>" };
  if (item.mode === "workflow") {
    assert.equal(
      graph.provenance.tsConfig,
      path.join(fixtureRoot, "tsconfig.json"),
      `selected config: ${item.id}`,
    );
    graph.provenance = {
      ...graph.provenance,
      tsConfig: "<runtime-root>/tsconfig.json",
    };
  }
  return { output: { ...expected.output, graph } };
}
const pureCalls = [
  "analyze_coupling",
  "value_edges",
  "find_cycles",
  "cross_boundary_edges",
  "rank_modules",
  "coupling_by_file",
].map((name) => `demlik_code_graph::smells::coupling::${name}`);
const smells = "demlik_code_graph::render::smells::render_smells";
const cycles = "demlik_code_graph::render::analysis::render_cycles";
function expectedCalls(item) {
  if (item.mode === "guards") return [smells, smells, cycles, cycles];
  return [
    ...(item.mode === "workflow"
      ? ["demlik_code_graph::extract::assemble::assemble_graph_with_reports"]
      : []),
    ...pureCalls,
    ...(item.mode ? [smells, smells, smells, cycles, cycles, cycles] : []),
  ];
}
export function sharedModuleCoupling(report, rawFile, expectedBinarySHA) {
  assert.equal(report.attempted, 18);
  assert.equal(report.passed, 18);
  assert.equal(report.unqualifiedPairs, 18);
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
  assert.deepEqual(report.reference.sourceHashes, sourcePins, "10 Source pins");
  for (const [file, digest] of Object.entries(sourcePins))
    assert.equal(
      hash(
        fs.readFileSync(
          path.join(root, "packages/code-graph/src", `${file}.ts`),
        ),
      ),
      digest,
      `current Source bytes: ${file}`,
    );
  const ids = cases.map((item) => item.id);
  assert.deepEqual(
    report.cases.map((row) => row.id),
    [...ids, ...protocolIds],
    "exact IDs",
  );
  assert.deepEqual(Object.keys(report.nativeEvidence), ids);
  assert.deepEqual(Object.keys(report.qualifiedNativeEvidence), []);
  for (const row of report.cases) {
    assert.equal(row.passed, true);
    assert.notEqual(row.nativeOnly, true);
    assert.equal(row.process.status, 0);
    assert.equal(row.process.signal, null);
    assert.equal(row.process.stderr, "");
    assert.equal(
      response.safeParse(row.actual).success,
      true,
      `response envelope: ${row.id}`,
    );
    assert.deepEqual(
      JSON.parse(row.process.stdout),
      row.actual,
      "raw process frame",
    );
    if (protocolIds.includes(row.id)) {
      assert.equal(row.protocol, true);
      assert.equal(row.actual.ok, false, `protocol refusal: ${row.id}`);
      assert.equal(row.actual.id, null);
      assert.deepEqual(row.actual.observedCalls, []);
      continue;
    }
    assert.notEqual(row.protocol, true);
    const item = cases.find((item) => item.id === row.id);
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
    assert.deepEqual(row.before, row.after, `bytes and modes: ${row.id}`);
    const fixtureFiles = filesFor(item);
    assert.deepEqual(
      Object.keys(row.before).sort(),
      Object.keys(fixtureFiles).sort(),
    );
    for (const [file, bytes] of Object.entries(fixtureFiles)) {
      const recorded = row.before[file];
      assert.deepEqual(Object.keys(recorded).sort(), ["base64", "mode"]);
      assert.equal(
        recorded.base64,
        Buffer.from(bytes).toString("base64"),
        `fixture bytes: ${row.id}/${file}`,
      );
      assert.ok(
        Number.isInteger(recorded.mode) &&
          recorded.mode >= 0 &&
          recorded.mode <= 0o777,
      );
    }
    assert.deepEqual(row.qualifications, [], `qualification: ${row.id}`);
    assert.equal(row.actual.id, row.id);
    const calls = expectedCalls(item);
    assert.deepEqual(
      row.actual.observedCalls,
      calls,
      `actual calls: ${row.id}`,
    );
    assert.deepEqual(row.nativeTrace, { observedCalls: calls });
    assert.deepEqual(report.nativeEvidence[row.id], row.nativeTrace);
    assert.equal(row.actual.ok, true);
    assert.deepEqual(Object.keys(row.expected), ["output"]);
    assert.deepEqual(
      row.actual.output,
      row.expected.output,
      `whole Source view: ${row.id}`,
    );
    assert.equal(
      hash(JSON.stringify(canonical(wholeview(item, row.expected, row.root)))),
      sourceWholeviews[row.id],
      `frozen Source wholeview: ${row.id}`,
    );
  }
  return {
    ...report,
    rejectedInvalidInputRows: 5,
    scope:
      "I10 finite module coupling/SCC/group/count/rank views and existing render consumers using caller-borrowed checked ICU77.18 strict rows; five protocol refusals and three response guards earn no extra credit. Supplied module facts and render provenance are distinct from the actual Go extraction workflow. Remaining legacy sites are tracked by current inventory; broader raw/reflection/numeric/host profiles and all53 CLI gaps remain OPEN.",
    observationProfiles: {
      suppliedRenderProvenance: ["render-threshold-coupling"],
      actualGoExtraction: ["two-package-official-go"],
      syntaxOnly: ["syntax-only-no-config"],
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
        fileURLToPath(new URL("./icu77-module-coupling.mjs", import.meta.url)),
        binary,
        rawFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
    );
    const normalized = sharedModuleCoupling(
      JSON.parse(fs.readFileSync(rawFile, "utf8")),
      rawFile,
      before,
    );
    fs.writeFileSync(reportFile, `${JSON.stringify(normalized, null, 2)}\n`);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      assert.equal(
        binaryHash(),
        before,
        "binary identity after worker/admission",
      );
    } catch (error) {
      identityError = error;
    }
  }
  if (operationError && identityError)
    throw new AggregateError(
      [operationError, identityError],
      "module coupling worker/admission and identity checks failed",
    );
  if (identityError) throw identityError;
  if (operationError) throw operationError;
}
