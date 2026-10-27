import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  assembleGraph,
  assembleGraphWithEdges,
} from "../../packages/code-graph/src/extract/assemble.js";
import {
  loadCheapProject,
  loadEdgeProject,
} from "../../packages/code-graph/src/extract/project.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import {
  type Graph,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";
import {
  type PreparedUnreachableGate,
  prepareUnreachableGate,
  runUnreachableGate,
} from "../../packages/code-graph/src/unreachable/gate.js";
import {
  findingKey,
  reconcileUnreachable,
  serializeUnreachableLedger,
  unreachableLedgerOf,
  withAcceptedFindings,
} from "../../packages/code-graph/src/unreachable/ledger.js";
import {
  renderAcceptedDead,
  renderUnreachableGate,
} from "../../packages/code-graph/src/unreachable/render.js";

const kind = z.enum(["dead", "only-called-from-tests"]);
const finding = z.object({ scope: z.string(), kind, id: z.string() }).strict();
const entry = finding.extend({ reason: z.string() }).strict();
const pureSchema = z
  .object({
    scope: z.string(),
    gated: z.array(kind),
    findings: z.array(finding),
    entries: z.array(entry),
    reason: z.string(),
    json: z.boolean(),
    pretty: z.boolean(),
  })
  .strict();
const runSchema = z
  .object({
    root: z.string(),
    repoRoot: z.string(),
    file: z.string(),
    scope: z.string(),
    project: z.boolean().default(false),
    prepare: z.boolean().default(false),
    unreachable: z.boolean().default(false),
    ci: z.boolean().default(false),
    acceptDead: z.boolean().default(false),
    deadOnly: z.boolean().default(false),
    reason: z.string().nullable(),
    accept: z.boolean().default(false),
    entries: z.array(entry).default([]),
    gated: z.array(kind),
    reach: z.array(z.object({ id: z.string(), kind }).strict()).nullable(),
    json: z.boolean(),
    pretty: z.boolean(),
    failEmit: z.boolean().default(false),
    failReport: z.boolean().default(false),
    outputFile: z.string().nullable(),
  })
  .strict();
type Pure = z.infer<typeof pureSchema>;
type Run = z.infer<typeof runSchema>;
type Input =
  | { id: string; operation: "pure"; input: Pure }
  | { id: string; operation: "run"; input: Run };
const symbol = z
  .object({
    id: z.string(),
    file: z.string(),
    startLine: z.number(),
    category: kind,
    testReferences: z.array(z.string()),
  })
  .strict();
const reconciled = z
  .object({
    scope: z.string(),
    gated: z.array(kind),
    unrecorded: z.array(finding),
    pruned: z.array(entry),
    kept: z.object({ entries: z.array(entry) }).strict(),
  })
  .strict();
const pureResult = z
  .object({
    keys: z.array(z.string()),
    ledger: z.object({ entries: z.array(entry) }).strict(),
    serialized: z.string(),
    result: reconciled,
    accepted: z.object({ entries: z.array(entry) }).strict(),
    acceptedAll: z.object({ entries: z.array(entry) }).strict(),
    gate: z.object({ stdout: z.string(), exitCode: z.number().int() }).strict(),
    acceptedText: z.string(),
    unrecordedIdentity: z.array(z.number().int().min(-1)),
    prunedIdentity: z.array(z.number().int().min(-1)),
    keptIdentity: z.array(z.number().int().min(-1)),
  })
  .strict();
const failure = z
  .object({
    stage: z.enum(["write", "render", "emit", "report"]),
    name: z.string(),
    message: z.string(),
    ioKind: z.string().nullable(),
    callbackIdentity: z.boolean(),
  })
  .strict();
const preparation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("refused"), message: z.string() }).strict(),
]);
const runResult = z
  .object({
    exit: z.number().int().nullable(),
    thrown: failure.nullable(),
    emitted: z.array(z.string()),
    reported: z.array(z.string()),
    ledgerAtEmit: z.array(z.string().nullable()),
    preparation: preparation.nullable(),
    sourceFiles: z.number().int().nonnegative().nullable(),
    symbols: z.array(symbol).nullable(),
  })
  .strict();
const response = z
  .object({
    id: z.string(),
    result: z.unknown(),
    calls: z.array(z.string()).min(1),
  })
  .strict();
const binary = process.argv[2];
assert.ok(binary);
const reportFile = process.argv[3];
assert.ok(reportFile);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repo = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(
  path.join(repo, "packages/code-graph/package.json"),
);
const manifest = require.resolve("@typescript/native-preview/package.json");
const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-unreachable-pairs-")),
);
const sourceFiles = [
  "unreachable/ledger.ts",
  "unreachable/render.ts",
  "unreachable/gate.ts",
  "extract/assemble.ts",
  "extract/project.ts",
].map((f) => path.join(repo, "packages/code-graph/src", f));
const pins = Object.fromEntries(
  sourceFiles.map((f) => [path.relative(repo, f), hash(fs.readFileSync(f))]),
);
const rows: Record<string, unknown>[] = [],
  failures: { id: string; message: string }[] = [];
let protocols = 0;
function pure(input: Pure) {
  const ledger = unreachableLedgerOf(input.entries);
  const result = reconcileUnreachable(
    ledger,
    input.scope,
    input.findings,
    input.gated,
  );
  return {
    keys: input.findings.map(findingKey),
    ledger,
    serialized: serializeUnreachableLedger(ledger),
    result,
    accepted: withAcceptedFindings(
      result.kept,
      result.unrecorded,
      input.reason,
    ),
    acceptedAll: withAcceptedFindings(ledger, input.findings, input.reason),
    gate: renderUnreachableGate(result, input.json, input.pretty),
    acceptedText: renderAcceptedDead(
      result,
      input.reason,
      input.json,
      input.pretty,
    ),
    unrecordedIdentity: result.unrecorded.map((f) => input.findings.indexOf(f)),
    prunedIdentity: result.pruned.map((f) => input.entries.indexOf(f)),
    keptIdentity: result.kept.entries.map((f) => input.entries.indexOf(f)),
  };
}
function source(input: Run): z.infer<typeof runResult> {
  const out: z.infer<typeof runResult> = {
    exit: null,
    thrown: null,
    emitted: [],
    reported: [],
    ledgerAtEmit: [],
    preparation: null,
    sourceFiles: null,
    symbols: null,
  };
  let gate: PreparedUnreachableGate;
  if (input.prepare) {
    const messages: string[] = [];
    const prepared = prepareUnreachableGate(
      {
        unreachable: input.unreachable,
        ci: input.ci,
        acceptDead: input.acceptDead,
        deadOnly: input.deadOnly,
        boundaries: false,
        ...(input.reason === null ? {} : { reason: input.reason }),
      },
      input.root,
      input.repoRoot,
      (s) => messages.push(s),
    );
    if (prepared.kind !== "prepared") {
      out.preparation =
        prepared.kind === "none"
          ? prepared
          : { kind: "refused", message: messages[0] };
      return out;
    }
    gate = prepared.gate;
  } else
    gate = {
      file: input.file,
      scope: input.scope,
      mode: input.accept
        ? { kind: "accept", reason: input.reason ?? "" }
        : { kind: "gate", gated: input.gated },
      ledger: { entries: input.entries },
    };
  let graph: Graph;
  if (input.project) {
    const loaded = loadEdgeProject(input.root, "package", input.repoRoot);
    out.sourceFiles = loaded.sourceFiles.length;
    graph = assembleGraphWithEdges(
      loaded,
      ThresholdsSchema.parse({}),
      "package",
      loaded.tsConfigPath,
      {
        crossRuntime: false,
        kinds: false,
        reach: true,
        clusters: false,
        interfaceWidth: false,
        kindRules: NodeKindRulesSchema.parse({}),
        repoRoot: input.repoRoot,
      },
    );
  } else {
    graph = assembleGraph(
      loadCheapProject(input.root),
      ThresholdsSchema.parse({}),
    );
    graph.reachability =
      input.reach === null
        ? null
        : {
            entryCount: 0,
            exportedCount: input.reach.length,
            reachableCount: 0,
            unreachable: input.reach.map((s) => ({
              id: s.id,
              category: s.kind,
              file: "fixture.ts",
              startLine: 1,
              testReferences: [],
            })),
            withheld: [],
            unguarded: [],
          };
  }
  out.symbols = graph.reachability?.unreachable ?? null;
  const original = new Error("original callback");
  let stage: "write" | "emit" | "report" = "write";
  try {
    out.exit = runUnreachableGate(gate, graph, {
      json: input.json,
      pretty: input.pretty,
      emit(payload) {
        stage = "emit";
        out.ledgerAtEmit.push(
          fs.existsSync(gate.file) && fs.statSync(gate.file).isFile()
            ? fs.readFileSync(gate.file, "utf8")
            : null,
        );
        if (input.outputFile !== null)
          fs.writeFileSync(input.outputFile, payload);
        out.emitted.push(payload);
        if (input.failEmit) throw original;
      },
      report(payload) {
        stage = "report";
        out.reported.push(payload);
        if (input.failReport) throw original;
      },
    });
  } catch (error) {
    assert.ok(error instanceof Error);
    const errno = z.object({ code: z.string().optional() }).parse(error).code;
    out.thrown = {
      stage,
      name: error.name,
      message: error.message,
      ioKind:
        errno === "ENOENT"
          ? "NotFound"
          : errno === "EACCES"
            ? "PermissionDenied"
            : errno === "EISDIR"
              ? "IsADirectory"
              : errno === "EINVAL"
                ? "InvalidInput"
                : null,
      callbackIdentity: error === original,
    };
  }
  return out;
}
function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function files(root: string): Record<string, { bytes: string; mode: number }> {
  const result: Record<string, { bytes: string; mode: number }> = {};
  function visit(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) visit(f);
      else if (e.isFile())
        result[path.relative(root, f)] = {
          bytes: fs.readFileSync(f).toString("base64"),
          mode: fs.statSync(f).mode & 0o777,
        };
    }
  }
  visit(root);
  return result;
}
function restore(root: string, snapshot: ReturnType<typeof files>) {
  const current = files(root);
  for (const f of Object.keys(current))
    if (!(f in snapshot)) fs.unlinkSync(path.join(root, f));
  for (const [f, data] of Object.entries(snapshot)) {
    const file = path.join(root, f);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
    write(file, Buffer.from(data.bytes, "base64").toString("utf8"));
    fs.chmodSync(file, data.mode);
  }
}
function stamp(file: string) {
  try {
    const s = fs.statSync(file, { bigint: true });
    return `${s.ino}/${s.mtimeNs}/${s.size}`;
  } catch {
    return null;
  }
}
function compare(request: Input, fixture?: string, ioQualified = false) {
  const before = fixture ? files(fixture) : null;
  const sourceStamp =
    request.operation === "run" ? stamp(request.input.file) : null;
  const expected =
    request.operation === "pure" ? pure(request.input) : source(request.input);
  const after = fixture ? files(fixture) : null;
  const sourceUnchanged =
    request.operation === "run"
      ? sourceStamp === stamp(request.input.file)
      : null;
  if (fixture && before) restore(fixture, before);
  const nativeStamp =
    request.operation === "run" ? stamp(request.input.file) : null;
  const child = spawnSync(binary, [manifest], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    maxBuffer: 20 << 20,
  });
  let actual: unknown,
    calls: string[] = [],
    passed = false;
  try {
    assert.equal(child.status, 0, child.stderr);
    const parsed = response.parse(JSON.parse(child.stdout));
    assert.equal(parsed.id, request.id);
    calls = parsed.calls;
    actual = (request.operation === "pure" ? pureResult : runResult).parse(
      parsed.result,
    );
    const a = structuredClone(actual),
      e = structuredClone(expected);
    if (ioQualified && request.operation === "run") {
      const av = runResult.parse(a),
        ev = runResult.parse(e);
      assert.ok(av.thrown && ev.thrown);
      assert.equal(av.thrown.stage, "write");
      assert.equal(ev.thrown.stage, "write");
      av.thrown.message = ev.thrown.message =
        "<backend diagnostic retained separately>";
      // Node validates NUL paths before native IO; both exact diagnostics remain in the row.
      if (request.id.includes("nul")) {
        av.thrown.name = ev.thrown.name = "<host error class>";
        av.thrown.ioKind = ev.thrown.ioKind = null;
      }
      assert.deepEqual(av, ev);
    } else assert.deepEqual(a, e);
    if (fixture) assert.deepEqual(files(fixture), after);
    if (request.operation === "run")
      assert.equal(
        nativeStamp === stamp(request.input.file),
        sourceUnchanged,
        "repeat/write occurrence",
      );
    passed = true;
  } catch (error) {
    failures.push({ id: request.id, message: String(error) });
  }
  rows.push({
    id: request.id,
    operation: request.operation,
    passed,
    qualified: ioQualified,
    qualification: ioQualified
      ? "Original Source/OS diagnostic and NUL argument class retained; operation/effects compared"
      : null,
    input: request.input,
    expected,
    actual,
    calls,
    process: { status: child.status, stderr: child.stderr },
    before,
    afterSource: after,
    afterNative: fixture ? files(fixture) : null,
    sourceLedgerUnchanged: sourceUnchanged,
  });
  return actual;
}
const all: z.infer<typeof kind>[] = ["dead", "only-called-from-tests"];
const f = (scope: string, id: string, k: z.infer<typeof kind> = "dead") => ({
  scope,
  kind: k,
  id,
});
const e = (
  scope: string,
  id: string,
  reason = "old",
  k: z.infer<typeof kind> = "dead",
) => ({ ...f(scope, id, k), reason });
function p(id: string, patch: Partial<Pure> = {}) {
  const input: Pure = {
    scope: "app",
    gated: all,
    findings: [],
    entries: [],
    reason: "new",
    json: false,
    pretty: false,
    ...patch,
  };
  for (const [suffix, json, pretty] of [
    ["text", false, false],
    ["json", true, false],
    ["pretty", true, true],
  ] as const)
    compare({
      id: `pure.${id}.${suffix}`,
      operation: "pure",
      input: pureSchema.parse({ ...input, json, pretty }),
    });
}
function r(
  id: string,
  root: string,
  patch: Partial<Run> = {},
  qualified = false,
) {
  return compare(
    {
      id,
      operation: "run",
      input: runSchema.parse({
        root,
        repoRoot: root,
        file: path.join(root, "unreachable-ledger.json"),
        scope: "app",
        gated: all,
        reach: [],
        reason: "kept",
        json: false,
        pretty: false,
        outputFile: null,
        ...patch,
      }),
    },
    patch.repoRoot ?? root,
    qualified,
  );
}
try {
  p("empty");
  p("duplicate-findings", {
    findings: [f("app", "x"), f("app", "x"), f("app", "z")],
  });
  p("first-reason", {
    findings: [f("app", "x"), f("app", "y")],
    entries: [e("app", "x", "first"), e("app", "x", "second")],
  });
  p("foreign-scope", {
    findings: [f("foreign", "measured")],
    entries: [e("app", "gone"), e("app/sub", "child"), e("other", "keep")],
  });
  p("ungated-kind", {
    gated: ["dead"],
    findings: [f("app", "fresh", "only-called-from-tests")],
    entries: [e("app", "old", "keep", "only-called-from-tests")],
  });
  p("kind-change", {
    findings: [f("app", "same", "only-called-from-tests")],
    entries: [e("app", "same")],
  });
  p("all-recorded", {
    findings: [f("app", "x")],
    entries: [
      e("app", "x"),
      e("app", "test", "test", "only-called-from-tests"),
    ],
  });
  p("multiple-prunes", { entries: [e("app", "z"), e("app", "a")] });
  p("numeric", { entries: [e("app", "2"), e("app", "10")] });
  p("locale", {
    scope: "é",
    entries: [
      e("é", "z"),
      e("e", "é"),
      e("E", "x"),
      e("a", "𐀀"),
      e("a", "\ue000"),
      e("a", "\ud800"),
    ],
  });
  for (const [id, value] of [
    ["high", "\ud800"],
    ["low", "\udfff"],
    ["replacement", "�"],
    ["astral", "𐀀"],
    ["nul", "\0"],
    ["tab", "\t"],
    ["quotes", '"\\\n'],
    ["prototype", "__proto__"],
    ["separators", "\u2028\u2029"],
  ])
    p(`raw-${id}`, {
      scope: value,
      findings: [f(value, `src/${value}:x`)],
      reason: value,
    });
  p("tuple-collision", {
    findings: [
      f("a,b", "c"),
      f("a", "b,c"),
      f("a", "b,c", "only-called-from-tests"),
    ],
  });
  const kernel = path.join(directory, "kernel");
  write(path.join(kernel, "tsconfig.json"), '{"include":["*.ts"]}');
  r("run.prepared-refused-before-analysis", kernel, {
    prepare: true,
    acceptDead: true,
    project: true,
    root: path.join(kernel, "absent"),
  });
  r("run.prepared-inactive", kernel, { prepare: true });
  r("run.missing-reach", kernel, { reach: null });
  r("run.original-report-error", kernel, { reach: null, failReport: true });
  r("run.accept-both", kernel, {
    accept: true,
    reach: [
      { id: "test", kind: "only-called-from-tests" },
      { id: "dead", kind: "dead" },
    ],
  });
  r("run.dead-only", kernel, {
    gated: ["dead"],
    reach: [{ id: "test", kind: "only-called-from-tests" }],
    entries: [e("app", "old", "keep", "only-called-from-tests")],
  });
  const ledger = path.join(kernel, "unreachable-ledger.json");
  write(ledger, serializeUnreachableLedger({ entries: [e("app", "old")] }));
  r("run.prune-before-emit-error", kernel, {
    entries: [e("app", "old")],
    reach: [{ id: "new", kind: "dead" }],
    failEmit: true,
    outputFile: path.join(kernel, "output.txt"),
  });
  write(ledger, serializeUnreachableLedger({ entries: [e("app", "same")] }));
  fs.chmodSync(ledger, 0o444);
  r("run.repeat-no-write", kernel, {
    accept: true,
    entries: [e("app", "same")],
    reach: [{ id: "same", kind: "dead" }],
  });
  fs.chmodSync(ledger, 0o644);
  r(
    "run.missing-parent-write",
    kernel,
    {
      file: path.join(kernel, "missing", "ledger.json"),
      accept: true,
      reach: [{ id: "new", kind: "dead" }],
    },
    true,
  );
  r(
    "run.directory-write",
    kernel,
    { file: kernel, accept: true, reach: [{ id: "new", kind: "dead" }] },
    true,
  );
  r(
    "run.nul-write",
    kernel,
    {
      file: `${kernel}/nul\0`,
      accept: true,
      reach: [{ id: "new", kind: "dead" }],
    },
    true,
  );
  r("run.raw-scope-utf8-file", kernel, {
    scope: "raw\ud800",
    accept: true,
    reach: [{ id: "x", kind: "dead" }],
    outputFile: path.join(kernel, "raw-output.txt"),
    reason: "why\udfff",
  });
  const workspace = path.join(directory, "workspace");
  write(
    path.join(workspace, "pnpm-workspace.yaml"),
    "packages: [packages/*]\n",
  );
  fs.mkdirSync(path.join(workspace, ".git"));
  for (const name of ["a", "b"]) {
    const root = path.join(workspace, "packages", name);
    write(
      path.join(root, "package.json"),
      JSON.stringify({ name: `fixture-${name}`, private: true }),
    );
    write(
      path.join(root, "tsconfig.json"),
      '{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler"},"include":["src/**/*.ts"]}',
    );
    write(
      path.join(root, "src/dead.ts"),
      "export function unused(){ return 1; }\n",
    );
    write(
      path.join(root, "src/tested.ts"),
      "export function tested(){ return 2; }\n",
    );
    write(
      path.join(root, "src/helper.ts"),
      "export function helper(){ return 3; }\n",
    );
    write(
      path.join(root, "src/main.ts"),
      "import {helper} from './helper'; helper();\n",
    );
    write(
      path.join(root, "src/a.test.ts"),
      "import {tested} from './tested'; tested();\n",
    );
  }
  const a = path.join(workspace, "packages/a"),
    b = path.join(workspace, "packages/b");
  function workflow(id: string, root: string, patch: Partial<Run> = {}) {
    const actual = r(`workflow.${id}`, root, {
      repoRoot: workspace,
      file: path.join(workspace, "unreachable-ledger.json"),
      project: true,
      prepare: true,
      unreachable: true,
      acceptDead: true,
      reason: "intentional fixture",
      ...patch,
    });
    const parsed = runResult.parse(actual);
    assert.ok((parsed.sourceFiles ?? 0) > 2);
    return parsed;
  }
  const recordedB = workflow("record-b", b);
  assert.equal(recordedB.exit, 0);
  assert.equal(
    recordedB.symbols?.filter((s) => s.category === "dead").length,
    1,
  );
  assert.equal(
    recordedB.symbols?.filter((s) => s.category === "only-called-from-tests")
      .length,
    1,
  );
  workflow("record-a", a, { json: true, pretty: true });
  fs.chmodSync(path.join(workspace, "unreachable-ledger.json"), 0o444);
  workflow("repeat-a-readonly", a);
  fs.chmodSync(path.join(workspace, "unreachable-ledger.json"), 0o644);
  workflow("ci-pass", a, {
    acceptDead: false,
    reason: null,
    ci: true,
    json: true,
  });
  write(path.join(a, "src/dead.ts"), "export function changed(){return 4;}\n");
  const failed = workflow("change-ci-prunes-fails", a, {
    acceptDead: false,
    reason: null,
    ci: true,
  });
  assert.equal(failed.exit, 1);
  workflow("accept-changed", a);
  workflow("repeat-changed", a, { json: true });
  write(
    path.join(a, "src/tested.ts"),
    "export function renamedTested(){return 5;}\n",
  );
  write(
    path.join(a, "src/a.test.ts"),
    "import {renamedTested} from './tested'; renamedTested();\n",
  );
  workflow("dead-only-keeps-ungated", a, {
    acceptDead: false,
    reason: null,
    ci: true,
    deadOnly: true,
    json: true,
    pretty: true,
  });
  write(path.join(b, "src/dead.ts"), "// removed\n");
  workflow("second-scope-prunes-only-b", b, {
    acceptDead: false,
    reason: null,
    ci: true,
  });
  const final = JSON.parse(
    fs.readFileSync(path.join(workspace, "unreachable-ledger.json"), "utf8"),
  );
  assert.ok(
    final.entries.some(
      (v: { scope: string; id: string }) =>
        v.scope === "packages/a" && v.id.includes("changed"),
    ),
  );
  assert.ok(
    !final.entries.some(
      (v: { scope: string; id: string }) =>
        v.scope === "packages/b" && v.id.includes("unused"),
    ),
  );
  for (const [id, raw] of [
    ["unknown-op", { id: "bad", operation: "bad", input: {} }],
    [
      "bad-kind",
      {
        id: "bad",
        operation: "pure",
        input: {
          scope: "x",
          entries: [],
          findings: [],
          gated: ["unknown"],
          reason: "r",
          json: false,
          pretty: false,
        },
      },
    ],
    [
      "unknown-field",
      {
        id: "bad",
        operation: "pure",
        input: {
          ...pureSchema.parse({
            scope: "x",
            entries: [],
            findings: [],
            gated: [],
            reason: "r",
            json: false,
            pretty: false,
          }),
          extra: 1,
        },
      },
    ],
    ["malformed", "{"],
  ]) {
    const child = spawnSync(binary, [manifest], {
      input: typeof raw === "string" ? raw : JSON.stringify(raw),
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, "");
    rows.push({
      id: `protocol.${id}`,
      protocol: true,
      passed: true,
      status: child.status,
      stderr: child.stderr,
    });
    protocols++;
  }
} catch (error) {
  failures.push({ id: "harness", message: String(error) });
} finally {
  const result = {
    reference: { node: process.version, v8: process.versions.v8 },
    binary: { path: binary, sha256: hash(fs.readFileSync(binary)) },
    sourceHashes: pins,
    passed: rows.filter((r) => r.passed && !r.protocol).length,
    unqualifiedPairs: rows.filter(
      (r) => r.passed && !r.qualified && !r.protocol,
    ).length,
    qualifiedPairs: rows.filter((r) => r.passed && r.qualified && !r.protocol)
      .length,
    rejectedInvalidInputs: protocols,
    failures,
    cases: rows,
    scope:
      "Library domain and actual Go/OXC reachability workflow. No global CLI execution or flag closure. Graph String IDs remain existing profile.",
  };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`);
  for (const [file, digest] of Object.entries(pins))
    assert.equal(hash(fs.readFileSync(path.join(repo, file))), digest);
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    passed: rows.filter((r) => r.passed && !r.protocol).length,
    protocols,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
