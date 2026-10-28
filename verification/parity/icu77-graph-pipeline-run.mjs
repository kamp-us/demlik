import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases, filesFor } from "./icu77-graph-cases.mjs";

const { z } = createRequire(import.meta.url)("zod");
const root = fileURLToPath(new URL("../..", import.meta.url));
const sourcePins = {
  "extract/project":
    "08aa30497ce1dde9d1d8587fc5f17bfd77c47de7206222d12285db5bad5cf69a",
  "extract/assemble":
    "b30d35677ccd714af2bb00c9b94374a0d7d621f2be5957f0e08a54cad829b644",
  "extract/directories":
    "1448b76eb752a4f6ac11b9e63235ffb24e1e39dfd9100ed5138b9142d6ab94cb",
  "extract/analysis":
    "2a77d9f1fd54a25378a7ba68b965f8538501ddac5bc8ce456a546688ac387bb5",
  "extract/cross-runtime":
    "4dfeb7466e0772508d76a2aa7acb2567c76556cfee82f3ee701b6cce7795b073",
  "extract/functions":
    "710633c0aa12e5aa3b78441934787158c3574d53cddcb5d0dcf32bc64b0d5f46",
  "extract/wrangler-config":
    "2050b3506fc9e8877a94ca4fa8cf6391e9e83f0c40f06d12193ec1e22e7925be",
  "data/extract":
    "497067394bfca8980419a4b77fed9a9853b75c04bb3bdf0ac1c41f53ee5eaefd",
  "data/alias-scope":
    "ca91943dc4e96ba7db9439de3ebed7a689155f4c6af7236ae7cef179ef711211",
  "data/access":
    "be7137e21ba3d0aec36a0c4cd90ea65e78e0664e8252e2c85e0d7a99fd4ed356",
  schema: "8fb99e84b915c640cf739caa3e27f051891bb94ca93feb5c481ff66397d92329",
  "kinds/rules":
    "ead81e3deaf76bc3bd1f1072a919ccfc62d196dc1342b0b3b20d02fcfece938e",
  "checker/context":
    "3f401004554c1ae84cf8d60b404876e6ee63f7a9a41a238ec66c0d03c12b8e86",
  "extract/edges":
    "857e177da82d6bb994cfbc45154f2cdcba4fb6ba5dacc4caff2b90e86a82db2d",
};
const sourceWholeviews = {
  "graph-empty":
    "3f5ceb1370f7e28da138c4fae4fca91d9b0e351cdcda6ad15629dd1fee72b0aa",
  "graph-module-locale":
    "e62a8eaf25eacc255d83f542bc487366726ca6c5132ace7c450448b3528ac0d4",
  "graph-function-id-unicode":
    "3c8e05c88d9cf2bb7715ba76bfde655faaf5a8fdeb06de54d237a83b95543159",
  "directory-original-membership":
    "cdb359eba268348fb3fed638375fa753dde58d34f078ee5105270b3b3f609322",
  "directory-root-dot":
    "ee74b484c48723935e7777ab46b961df16c16eb4a84202329fbdc2122c847f03",
  "inputs-nonlexical-map":
    "247ae858524fbd924b9968b81df4dfef3b4099c3c870159eacccb262d06a80ce",
  "inputs-duplicates-and-unexported":
    "e5554023a830c394abe3447e76476f5ed7fa745e4cbfc9c8a73d968b7d0fcb97",
  "inputs-stable-normalization-ties":
    "d80d897db136d505d4bb970105b44736ee4d105b0095499163294fb6903139b2",
  "data-holder-locale":
    "e70fc94dabe5fd4806efc955ce95f8a5509328a98d7f658c258fdd1024a179d9",
  "data-line-column-before-binding":
    "21bc81cf149149f78af1bfb7ca956c120c47e254b0bbd80a583258045f5821e0",
  "data-top-level-and-held":
    "b8fb544ac4cd57353a94b13348cd7be9ec1e9fc33ead70b5918bd5e410e40078",
  "data-alias-shadow-duplicates":
    "65bf2d6203e9f4901f1ac712edf24a9ee679fb955e4d4ecec83fd88cea002d12",
  "data-raw-binding-method":
    "3cf725436be7152b57ff0e9ac85f3698755c62bc076cf771c768b0265b571fc4",
  "data-catalog-refusal":
    "4e4f2d1e0693c81722e721d099a60f665f81a702fcfc825c6dab64ec1c2182c7",
  "cross-census-service-before-binding":
    "ee16ac504b6419d64cd37483a729c27607861e47782bb329019e8b3ad14ea524",
  "cross-same-line-binding-order":
    "a18374d0752b3046ece857ee97690ad2a58672757b0292ff89235da1a4b8f57c",
  "cross-ambiguous-unloaded-and-workflow":
    "cb1626bcda69d2b741821fd301d4432722a41514fb7e019b3c1fde25b47fb580",
  "two-package-full-graph":
    "fbb7e18ad75088d6d941e51116405d0f60ca24e594153cf417350be63e26fd3e",
};
const frozenSourceReport = {
  path: "/private/tmp/demlik-icu77-group-h-proof-01a16c9d/source-first.json",
  sha256: "ccd91c166e72eeb6d08d274330b187085e550c0df60c4ccb92060fda945f0f88",
};
const frozenSourceCwd = "/private/tmp/demlik-check-icu77-group-h-01a16c9d/repo";
const protocolIds = [
  "protocol.invalid-json",
  "protocol.missing-id",
  "protocol.unknown-field",
  "protocol.numeric-root",
  "protocol.numeric-order-member",
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
    error: z.strictObject({ name: z.string(), message: z.string().min(1) }),
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
function wholeview(item, expected, fixtureRoot, workerCwd) {
  if (item.mode !== "graph" && item.mode !== "workflow") return expected;
  assert.equal(
    expected.output.root,
    path.relative(workerCwd, fixtureRoot) || ".",
    `logical graph root: ${item.id}`,
  );
  const output = { ...expected.output, root: "<runtime-root>" };
  if (item.mode === "workflow") {
    assert.equal(
      output.provenance.tsConfig,
      path.join(fixtureRoot, "tsconfig.json"),
      `selected config: ${item.id}`,
    );
    output.provenance = {
      ...output.provenance,
      tsConfig: "<runtime-root>/tsconfig.json",
    };
  }
  return { output };
}
function expectedCalls(item) {
  switch (item.mode) {
    case "workflow":
      return [
        "demlik_code_graph::extract::assemble::assemble_graph_with_reports",
      ];
    case "inputs":
      return ["demlik_code_graph::extract::analysis::analysis_inputs"];
    case "data":
      return item.id === "data-catalog-refusal"
        ? ["demlik_code_graph::extract::wrangler_config::load_binding_catalog"]
        : [
            "demlik_code_graph::extract::wrangler_config::load_binding_catalog",
            "demlik_code_graph::data::extract::scan_data_sites",
            "demlik_code_graph::data::extract::load_data_report",
          ];
    case "directories":
      return [
        "demlik_code_graph::extract::assemble::assemble_graph",
        "demlik_code_graph::extract::directories::build_directories",
      ];
    default:
      return ["demlik_code_graph::extract::assemble::assemble_graph"];
  }
}
export function sharedGraphPipeline(report, rawFile, expectedBinarySHA) {
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
  assert.deepEqual(report.reference.sourceHashes, sourcePins, "14 Source pins");
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
  const saved = report.reference.frozenSourceReport !== null;
  if (saved)
    assert.deepEqual(
      report.reference.frozenSourceReport,
      frozenSourceReport,
      "actual frozen Source execution",
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
      assert.equal(row.actual.error.name, "Error");
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
    const error = item.id === "data-catalog-refusal";
    assert.equal(row.actual.ok, !error);
    assert.deepEqual(Object.keys(row.expected), [error ? "error" : "output"]);
    assert.deepEqual(
      error ? row.actual.error : row.actual.output,
      error ? row.expected.error : row.expected.output,
      `whole Source view: ${row.id}`,
    );
    assert.equal(
      hash(
        JSON.stringify(
          canonical(
            wholeview(
              item,
              row.expected,
              row.root,
              saved ? frozenSourceCwd : root,
            ),
          ),
        ),
      ),
      sourceWholeviews[row.id],
      `frozen Source wholeview: ${row.id}`,
    );
  }
  return {
    ...report,
    rejectedInvalidInputRows: 5,
    scope:
      "H19 finite graph assembly/directories/analysis/cross-runtime/data ordering with the original owners and caller-borrowed checked ICU77 handle.18 strict views, five protocol rows and three response guards (zero extra credit).Remaining legacy collation sites are tracked by the current inventory; broader raw/reflection/numeric/host profiles and all53 CLI gaps remain OPEN.",
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
        fileURLToPath(new URL("./icu77-graph-pipeline.mjs", import.meta.url)),
        binary,
        rawFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
    );
    const normalized = sharedGraphPipeline(
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
      "graph pipeline worker/admission and identity checks failed",
    );
  if (identityError) throw identityError;
  if (operationError) throw operationError;
}
