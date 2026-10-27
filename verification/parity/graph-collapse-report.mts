import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { findCollapseCandidates } from "../../packages/code-graph/src/collapse/candidates.js";
import { CollapseSettingsSchema } from "../../packages/code-graph/src/collapse/settings.js";
import { tsgoBinary } from "../../packages/code-graph/src/engine/tsgo.js";
import { assembleGraphWithEdges } from "../../packages/code-graph/src/extract/assemble.js";
import {
  discoverPackageRoots,
  loadEdgeProject,
} from "../../packages/code-graph/src/extract/project.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import { stableStringify } from "../../packages/code-graph/src/render/json.js";
import {
  type FunctionNode,
  FunctionNodeSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";
import {
  cases as baselineCases,
  type Expected,
  type Node,
  type Pure,
} from "./collapse-report-cases.mjs";
import { icu77CollapseCases } from "./icu77-collapse-cases.mjs";

const icu77Group = process.env.DEMLIK_ICU77_COLLAPSE === "1";
const cases = icu77Group ? icu77CollapseCases : baselineCases;

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const hash = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const numeric = z.number().nullable();
const signal = z.strictObject({
  signal: z.enum(["shape", "callees", "callers", "name"]),
  strength: numeric,
  detail: z.string(),
});
const costInputs = z.strictObject({
  callerUnion: z.number().int().nonnegative(),
  packagesSpanned: z.number().int().nonnegative(),
  crossesPackage: z.boolean(),
  effectOnPath: z.boolean(),
});
const candidate = z.strictObject({
  aId: z.string(),
  aFile: z.string(),
  aStartLine: z.number().int(),
  aEndLine: z.number().int(),
  bId: z.string(),
  bFile: z.string(),
  bStartLine: z.number().int(),
  bEndLine: z.number().int(),
  signals: z.array(signal),
  confidence: numeric,
  cost: numeric,
  costInputs,
  rank: numeric,
});
const partial = z.strictObject({
  aId: z.string(),
  aFile: z.string(),
  aStartLine: z.number(),
  aBlockLine: z.number(),
  aDiverges: z.string(),
  aDivergesLine: z.number(),
  bId: z.string(),
  bFile: z.string(),
  bStartLine: z.number(),
  bBlockLine: z.number(),
  bDiverges: z.string(),
  bDivergesLine: z.number(),
  sharedBlock: z.array(z.string()),
  sharedConstants: z.array(z.string()),
});
const reportSchema = z.strictObject({
  settings: CollapseSettingsSchema,
  consideredFunctions: z.number().int(),
  pairsScored: z.number().int(),
  skippedBlocks: z.array(
    z.strictObject({
      kind: z.enum(["callee", "caller", "name-token"]),
      key: z.string(),
      size: z.number().int(),
    }),
  ),
  candidates: z.array(candidate),
  clusters: z.array(
    z.strictObject({
      representative: candidate,
      members: z.array(z.string()),
      pairCount: z.number().int(),
      rank: numeric,
    }),
  ),
  partialTwins: z.array(partial),
});
const responseSchema = z.strictObject({
  id: z.string(),
  ok: z.literal(true),
  output: z.strictObject({
    report: reportSchema,
    compact: z.string(),
    pretty: z.string(),
    owners: z.strictObject({
      settings: z.boolean(),
      nodes: z.boolean(),
      representatives: z.boolean(),
      partials: z.boolean(),
    }),
    numeric: z.array(
      z.strictObject({
        confidence: z.string(),
        cost: z.string(),
        rank: z.string(),
        strengths: z.array(z.string()),
      }),
    ),
    facts: FunctionNodeSchema.array().optional(),
    observedCalls: z.array(z.string()),
  }),
});
type Response = z.infer<typeof responseSchema>;
type Project = {
  operation: "project";
  root: string;
  repoRoot: string;
  nativePreviewManifest: string;
  settings: z.infer<typeof CollapseSettingsSchema>;
};
type Input = Pure | Project;
const bits = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return b.readBigUInt64LE().toString(16).padStart(16, "0");
};
function fromNode(n: Node): FunctionNode {
  return {
    id: n.id,
    name: n.name,
    file: n.file,
    startLine: n.startLine,
    endLine: n.endLine,
    loc: n.loc,
    complexity: n.complexity,
    nestingDepth: n.nestingDepth,
    kind: n.kind,
    isTest: n.isTest,
    isExported: true,
    commentLines: 0,
    edges: n.noEdges
      ? null
      : {
          calls: n.calls.map((c) => ({ ...c, declaration: null })),
          calledBy: n.callers.map((callerId) => ({ callerId, line: 1 })),
          callChainDepth: 0,
        },
    nodeKind: n.effect ? { kind: "effect", evidence: [] } : null,
    smells: [],
  };
}
const outputCases: {
  id: string;
  input: Input;
  expectation?: Expected;
  source: unknown;
  sourceNumeric: unknown;
  native: unknown;
  passed: boolean;
  qualification: null;
  failure?: string;
  fixture?: unknown;
}[] = [];
const failures: {
  id: string;
  kind: "protocol" | "semantic";
  message: string;
}[] = [];
const nativeEvidence: Record<string, { observedCalls: string[] }> = {};
const sourceFiles = [
  "collapse/candidates.ts",
  "collapse/signals.ts",
  "collapse/tokens.ts",
  "collapse/cost.ts",
  "collapse/settings.ts",
  "collapse/partial.ts",
  "query/reach.ts",
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map((p) => [
    p,
    hash(fs.readFileSync(path.join(repository, "packages/code-graph/src", p))),
  ]),
);
const chosen =
  process.env.DEMLIK_COLLAPSE_REPORT_CASES?.split(",") ??
  (icu77Group ? cases.map((c) => c.id) : undefined);
const projectIds = [
  "project.baseline",
  "project.seven-callers",
  "project.drop-callers",
  "project.effect-helper",
  "project.drop-effect",
  "project.three-clique",
  "project.overlapping-chain",
];
assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
if (chosen)
  assert.ok(
    chosen.every(
      (id) => cases.some((c) => c.id === id) || projectIds.includes(id),
    ),
  );
const publicCalls = [
  "demlik_code_graph::collapse::candidates::find_collapse_candidates",
  "demlik_code_graph::render::json::stable_stringify",
  "demlik_code_graph::render::json::stable_stringify",
];
function source(input: Input) {
  if (input.operation === "pure")
    return { functions: input.nodes.map(fromNode), roots: input.packageRoots };
  const loaded = loadEdgeProject(input.root, "package", input.repoRoot);
  const graph = assembleGraphWithEdges(
    loaded,
    ThresholdsSchema.parse({}),
    "package",
    loaded.tsConfigPath,
    {
      crossRuntime: true,
      kinds: true,
      reach: false,
      clusters: false,
      interfaceWidth: false,
      kindRules: NodeKindRulesSchema.parse({}),
      repoRoot: input.repoRoot,
    },
  );
  return {
    functions: graph.functions,
    roots: discoverPackageRoots(input.root),
    facts: graph.functions,
  };
}
function literal(
  expected: ReturnType<typeof findCollapseCandidates>,
  e: Expected,
) {
  for (const [actual, want] of [
    [expected.consideredFunctions, e.considered],
    [expected.pairsScored, e.pairs],
    [expected.candidates.length, e.candidates],
    [expected.clusters.length, e.clusters],
    [expected.partialTwins.length, e.partial],
    [expected.skippedBlocks.length, e.skipped],
  ])
    if (want !== undefined) assert.equal(actual, want);
  for (const c of expected.candidates) {
    if (e.confidence !== undefined) assert.equal(c.confidence, e.confidence);
    if (e.cost !== undefined) assert.equal(c.cost, e.cost);
    if (e.rank !== undefined) assert.equal(c.rank, e.rank);
  }
  if (e.signals)
    assert.deepEqual(
      expected.candidates[0]?.signals.map((s) => s.signal),
      e.signals,
    );
  if (e.members) assert.equal(expected.clusters[0]?.members.length, e.members);
  if (e.pairCount) assert.equal(expected.clusters[0]?.pairCount, e.pairCount);
}
function check(
  id: string,
  input: Input,
  expectation?: Expected,
  fixture?: unknown,
) {
  if (chosen && !chosen.includes(id)) return;
  const prepared = source(input),
    before = JSON.stringify(prepared.functions);
  const expected = findCollapseCandidates(
    prepared.functions,
    prepared.roots,
    input.settings,
  );
  assert.equal(JSON.stringify(prepared.functions), before);
  const expectedWire: unknown = JSON.parse(JSON.stringify(expected));
  const expectedBits = expected.candidates.map((c) => ({
    confidence: bits(c.confidence),
    cost: bits(c.cost),
    rank: bits(c.rank),
    strengths: c.signals.map((s) => bits(s.strength)),
  }));
  const run = spawnSync(binary, [], {
    input: `${JSON.stringify({ id, input })}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let actual: Response | undefined;
  let kind: "protocol" | "semantic" = "protocol";
  let failure: string | undefined;
  try {
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    actual = responseSchema.parse(JSON.parse(run.stdout));
    assert.equal(actual.id, id);
    const prefix =
      input.operation === "pure"
        ? []
        : [
            "demlik_code_graph::project::load_edge_project_text",
            "demlik_code_graph::extract::assemble::assemble_graph_with_analysis_text",
            "demlik_code_graph::project::discover_package_roots",
          ];
    assert.deepEqual(actual.output.observedCalls, [...prefix, ...publicCalls]);
    kind = "semantic";
    assert.deepEqual(actual.output.report, expectedWire);
    assert.equal(actual.output.compact, stableStringify(expected, false));
    assert.equal(actual.output.pretty, stableStringify(expected, true));
    assert.deepEqual(actual.output.numeric, expectedBits);
    assert.ok(Object.values(actual.output.owners).every((v) => v === true));
    assert.equal(expected.settings, input.settings);
    assert.ok(
      expected.clusters.every((c) =>
        expected.candidates.includes(c.representative),
      ),
    );
    if (prepared.facts)
      assert.deepEqual(
        actual.output.facts,
        JSON.parse(JSON.stringify(prepared.facts)),
      );
    if (expectation) literal(expected, expectation);
    nativeEvidence[id] = { observedCalls: actual.output.observedCalls };
  } catch (e) {
    failure = String(e);
    failures.push({ id, kind, message: failure });
  }
  outputCases.push({
    id,
    input,
    expectation,
    source: expectedWire,
    sourceNumeric: expectedBits,
    native: actual ?? {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
    },
    passed: !failure,
    qualification: null,
    failure,
    fixture,
  });
}
for (const { id, input, expectation } of cases) check(id, input, expectation);
const fixtureRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-collapse-report-")),
);
const manifest = createRequire(
  path.join(repository, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const compiler = await tsgoBinary();
assert.equal(compiler.version, "7.0.0-dev.20260707.2");
const write = (name: string, text: string) =>
  fs.writeFileSync(path.join(fixtureRoot, name), text);
function snapshot() {
  return Object.fromEntries(
    fs
      .readdirSync(fixtureRoot)
      .filter((n) => n !== ".git")
      .sort()
      .map((n) => {
        const f = path.join(fixtureRoot, n),
          s = fs.statSync(f);
        return [
          n,
          {
            sha256: hash(fs.readFileSync(f)),
            mode: s.mode & 0o777,
            bytes: fs.readFileSync(f).toString("base64"),
          },
        ];
      }),
  );
}
function membership(name: string, fallback: string) {
  return `export function ${name}(input: {id: string; role: string}) {\n const id = normalizeId(input.id);\n const role = selectRole(input.role);\n if (role === '') {\n  return {id, role: '${fallback}'};\n }\n return {id, role};\n}\n`;
}
const imports = "import {normalizeId, selectRole} from './helpers.js';\n";
const helpers =
  "export function normalizeId(value: string) { return value.trim(); }\nexport function selectRole(value: string) { return value.toLowerCase(); }\nexport function readBand(value: string) { return value.trim(); }\nexport function selectBand(value: string) { return value.toLowerCase(); }\n";
const settings = CollapseSettingsSchema.parse({});
const normal = {
  considered: 2,
  pairs: 1,
  candidates: 1,
  clusters: 1,
  partial: 0,
  confidence: 0.625,
  cost: 1,
  rank: 0.625,
  signals: ["shape", "callees", "name"],
};
function project(id: string, expectation: Expected) {
  const before = snapshot();
  check(
    id,
    {
      operation: "project",
      root: fixtureRoot,
      repoRoot: fixtureRoot,
      nativePreviewManifest: manifest,
      settings,
    },
    expectation,
    before,
  );
  assert.deepEqual(snapshot(), before);
}
let fixtureRemoved = false;
try {
  const init = spawnSync("git", ["init", "--quiet", fixtureRoot], {
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["*.ts"],
    }),
  );
  write("package.json", '{"name":"membership-workflow","type":"module"}\n');
  write("helpers.ts", helpers);
  write("api.ts", imports + membership("normalizeMembership", "guest"));
  write("worker.ts", imports + membership("canonicalMembership", "member"));
  project("project.baseline", normal);
  write(
    "callers.ts",
    "import {normalizeMembership} from './api.js';\n" +
      Array.from(
        { length: 7 },
        (_, i) =>
          `export function caller${i}(input: {id:string;role:string}) { return normalizeMembership(input); }\n`,
      ).join(""),
  );
  project("project.seven-callers", { ...normal, cost: 4, rank: 0.1563 });
  fs.unlinkSync(path.join(fixtureRoot, "callers.ts"));
  project("project.drop-callers", normal);
  write(
    "helpers.ts",
    helpers.replace(
      "return value.trim();",
      "void fetch(value); return value.trim();",
    ),
  );
  project("project.effect-helper", { ...normal, cost: 2, rank: 0.3125 });
  write("helpers.ts", helpers);
  project("project.drop-effect", normal);
  write(
    "worker.ts",
    imports +
      membership("canonicalMembership", "member") +
      membership("projectMembership", "reader"),
  );
  project("project.three-clique", {
    ...normal,
    considered: 3,
    pairs: 3,
    candidates: 3,
    members: 3,
    pairCount: 3,
  });
  write("api.ts", imports + membership("impactBudget", "guest"));
  write(
    "worker.ts",
    "import {normalizeId,selectRole,readBand,selectBand} from './helpers.js';\n" +
      membership("impactSeverity", "member") +
      membership("severityBand", "reader")
        .replace("normalizeId(input.id)", "readBand(input.id)")
        .replace("selectRole(input.role)", "selectBand(input.role)"),
  );
  project("project.overlapping-chain", {
    considered: 3,
    pairs: 2,
    candidates: 2,
    clusters: 2,
    partial: 0,
  });
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRemoved = !fs.existsSync(fixtureRoot);
}
let protocol = 0,
  guards = 0;
for (const input of [
  "not JSON",
  "{}",
  JSON.stringify({ id: "unknown", input: { ...cases[0].input, extra: true } }),
  JSON.stringify({
    id: "wrong",
    input: { operation: "pure", nodes: "x", settings: {}, packageRoots: [] },
  }),
]) {
  const r = spawnSync(binary, [], { input: `${input}\n`, encoding: "utf8" });
  assert.ifError(r.error);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.length);
  protocol++;
}
const sample = outputCases.find((r) => r.passed)?.native;
if (sample)
  for (const mutate of [
    (r: Record<string, unknown>) => {
      r.id = "foreign";
    },
    (r: Record<string, unknown>) => {
      r.output = { ...(r.output as object), observedCalls: ["foreign::call"] };
    },
    (r: Record<string, unknown>) => {
      r.output = { ...(r.output as object), report: undefined };
    },
  ]) {
    const broken = structuredClone(sample) as Record<string, unknown>;
    mutate(broken);
    assert.throws(() => {
      const parsed = responseSchema.parse(broken),
        original = responseSchema.parse(sample);
      assert.equal(parsed.id, original.id);
      assert.deepEqual(
        parsed.output.observedCalls,
        original.output.observedCalls,
      );
    });
    guards++;
  }
const report = {
  scope:
    "Pure complete collapse report only; no renderer/lateCLI and all53CLI gaps remain OPEN",
  knownGaps: [
    "FunctionNode String-only reflection fields do not admit raw lone UTF16",
    "Raw/unvalidated/fractional/noncanonical graph/settings and JS object/prototype profiles remain outside the canonical typed/validated profile",
  ],
  reference: {
    node: process.version,
    v8: process.versions.v8,
    sourceHashes,
    compiler,
  },
  nativeExecutable: { path: binary, sha256: hash(fs.readFileSync(binary)) },
  fixture: { path: fixtureRoot, removed: fixtureRemoved },
  passed: outputCases.filter((r) => r.passed).length,
  attempted: outputCases.length,
  unqualifiedPairs: outputCases.filter((r) => r.passed).length,
  qualifiedPairs: 0,
  rejectedInvalidInputs: protocol,
  responseGuards: guards,
  nativeEvidence,
  qualifiedNativeEvidence: {},
  failures,
  cases: outputCases,
};
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    passed: report.passed,
    attempted: report.attempted,
    protocol,
    guards,
    failures: failures.map((f) => ({
      id: f.id,
      kind: f.kind,
      message: f.message.slice(0, 500),
    })),
  }),
);
assert.deepEqual(failures, []);
