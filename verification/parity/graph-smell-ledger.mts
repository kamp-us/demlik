import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { exitWith, outputTo } from "../../packages/code-graph/src/cli.js";
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
  type PreparedSmellGate,
  prepareSmellGate,
  runSmellLedgerGate,
} from "../../packages/code-graph/src/smells/gate.js";
import {
  findingsOf,
  measuredRules,
  reconcileSmells,
  repoTarget,
  serializeSmellLedger,
  smellKey,
  smellLedgerOf,
  withAcceptedSmells,
} from "../../packages/code-graph/src/smells/ledger.js";
import {
  renderAcceptedSmells,
  renderSmellLedgerGate,
} from "../../packages/code-graph/src/smells/ledger-render.js";
import { smellKinds } from "../../packages/code-graph/src/smells/rules.js";

const kind = z.enum(smellKinds());
const numeric = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
const finding = z
  .object({ rule: kind, target: z.string(), value: numeric })
  .strict();
const entry = finding.extend({ reason: z.string() }).strict();
const pureSchema = z
  .object({
    scope: z.string(),
    gated: z.array(kind),
    measured: z.array(kind),
    findings: z.array(finding),
    entries: z.array(entry),
    reason: z.string(),
    json: z.boolean(),
    pretty: z.boolean(),
  })
  .strict();
const target = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("function"),
      id: z.string(),
      file: z.string(),
      startLine: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("module"), file: z.string() }).strict(),
  z.object({ type: z.literal("directory"), dir: z.string() }).strict(),
]);
const smell = z
  .object({ kind, target, value: z.number().int().nonnegative() })
  .strict();
const targetsSchema = z
  .object({ scope: z.string(), smells: z.array(smell) })
  .strict();
const runSchema = z
  .object({
    root: z.string(),
    repoRoot: z.string(),
    file: z.string(),
    scope: z.string(),
    prepare: z.boolean(),
    accept: z.boolean(),
    ci: z.boolean(),
    reason: z.string().nullable(),
    gated: z.array(kind),
    entries: z.array(entry),
    smells: z.array(smell),
    project: z.boolean(),
    edges: z.boolean(),
    json: z.boolean(),
    pretty: z.boolean(),
    failEmit: z.boolean(),
    outputFile: z.string().nullable(),
    thresholds: ThresholdsSchema,
  })
  .strict();
type Pure = z.infer<typeof pureSchema>;
type Run = z.infer<typeof runSchema>;
type Request =
  | { id: string; operation: "pure"; input: Pure }
  | { id: string; operation: "targets"; input: z.infer<typeof targetsSchema> }
  | { id: string; operation: "run"; input: Run };
const response = z
  .object({
    id: z.string(),
    result: z.unknown(),
    calls: z.array(z.string()).min(1),
  })
  .strict();
const binary = process.argv[2],
  reportFile = process.argv[3];
assert.ok(binary && reportFile);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repo = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(
  path.join(repo, "packages/code-graph/package.json"),
);
const manifest = require.resolve("@typescript/native-preview/package.json");
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const sourceFiles = [
  "smells/ledger.ts",
  "smells/ledger-render.ts",
  "smells/gate.ts",
  "smells/rules.ts",
  "cli.ts",
  "extract/assemble.ts",
  "extract/project.ts",
].map((f) => path.join(repo, "packages/code-graph/src", f));
const sourceHashes = Object.fromEntries(
  sourceFiles.map((f) => [path.relative(repo, f), hash(fs.readFileSync(f))]),
);
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-smell-pairs-")),
);
const rows: Record<string, unknown>[] = [],
  failures: { id: string; message: string }[] = [];
const number = (value: z.infer<typeof numeric>) =>
  typeof value === "number"
    ? value
    : value === "NaN"
      ? NaN
      : value === "Infinity"
        ? Infinity
        : value === "-Infinity"
          ? -Infinity
          : -0;
const numberTag = (n: number) =>
  Number.isNaN(n) ? "NaN" : Object.is(n, -0) ? "-0" : String(n);
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function pure(input: Pure) {
  const entries = input.entries.map((e) => ({ ...e, value: number(e.value) }));
  const findings = input.findings.map((f) => ({
    ...f,
    value: number(f.value),
  }));
  const ledger = { gated: input.gated, entries };
  const canonical = smellLedgerOf(ledger.gated, entries);
  const result = reconcileSmells(
    ledger,
    input.scope,
    findings,
    new Set(input.measured),
  );
  const accepted = withAcceptedSmells(result, input.reason);
  return wire({
    keys: findings.map(smellKey),
    canonical,
    serialized: serializeSmellLedger(ledger),
    result,
    accepted,
    gate: renderSmellLedgerGate(result, input.json, input.pretty),
    acceptedText: renderAcceptedSmells(
      result,
      input.reason,
      input.json,
      input.pretty,
    ),
    gatedIdentity: result.gated === ledger.gated,
    canonicalIdentity: canonical.entries.map((e) => entries.indexOf(e)),
    unrecordedIdentity: result.unrecorded.map((f) => findings.indexOf(f)),
    keptIdentity: result.kept.entries.map((e) => entries.indexOf(e)),
    prunedIdentity: result.pruned.map((e) => entries.indexOf(e)),
    acceptedIdentity: accepted.entries.map((e) =>
      result.kept.entries.indexOf(e),
    ),
    keptNumbers: result.kept.entries.map((e) => numberTag(e.value)),
  });
}
function sourceTargets(input: z.infer<typeof targetsSchema>) {
  const smells = input.smells.map((s) => ({
    ...s,
    threshold: 1,
    severity: "warn" as const,
  }));
  return {
    targets: smells.map((s) => repoTarget(input.scope, s)),
    findings: findingsOf(input.scope, smells),
  };
}
function sourceRun(input: Run) {
  const out = {
    exit: null as number | null,
    processExit: null as number | null,
    thrown: null as null | {
      stage: string;
      name: string;
      message: string;
      ioKind: string | null;
      callbackIdentity: boolean;
    },
    payloads: [] as string[],
    stdoutBytes: [] as number[],
    stderrBytes: [] as number[],
    ledgerAtEmit: [] as (string | null)[],
    preparation: null as
      | null
      | { kind: "none" }
      | { kind: "refused"; message: string },
    sourceFiles: null as number | null,
    smells: [] as Graph["smells"],
    measured: [] as z.infer<typeof kind>[],
    pendingStdio: 0,
  };
  let gate: PreparedSmellGate;
  if (input.prepare) {
    const reports: string[] = [];
    const prep = prepareSmellGate(
      {
        ci: input.ci,
        acceptSmells: input.accept,
        ...(input.reason === null ? {} : { reason: input.reason }),
      },
      input.root,
      input.repoRoot,
      (s) => reports.push(s),
    );
    if (prep.kind !== "prepared") {
      out.preparation =
        prep.kind === "none" ? prep : { kind: "refused", message: reports[0] };
      return out;
    }
    gate = prep.gate;
  } else
    gate = {
      file: input.file,
      scope: input.scope,
      ledger: {
        gated: input.gated,
        entries: input.entries.map((e) => ({ ...e, value: number(e.value) })),
      },
      mode: input.accept
        ? { kind: "accept", reason: input.reason ?? "" }
        : { kind: "gate" },
    };
  let graph: Graph;
  if (input.project) {
    const loaded = loadEdgeProject(input.root, "package", input.repoRoot);
    out.sourceFiles = loaded.sourceFiles.length;
    graph = assembleGraphWithEdges(
      loaded,
      input.thresholds,
      "package",
      loaded.tsConfigPath,
      {
        crossRuntime: false,
        kinds: false,
        reach: false,
        clusters: false,
        interfaceWidth: false,
        kindRules: NodeKindRulesSchema.parse({}),
        repoRoot: input.repoRoot,
      },
    );
  } else {
    graph = assembleGraph(loadCheapProject(input.root), input.thresholds);
    graph.smells = input.smells.map((s) => ({
      ...s,
      threshold: 1,
      severity: "warn",
    }));
    if (input.edges)
      graph.provenance = {
        pass: "edges",
        tsConfig: "fixture.json",
        scope: "package",
      };
  }
  out.smells = graph.smells;
  out.measured = [...measuredRules(graph)];
  const original = new Error("original callback");
  let stage = "write";
  const previousOut = process.stdout.write,
    previousErr = process.stderr.write,
    previousExit = process.exitCode;
  const capture = (bytes: number[]) => (chunk: string | Uint8Array) => {
    bytes.push(
      ...(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)),
    );
    return true;
  };
  process.stdout.write = capture(out.stdoutBytes);
  process.stderr.write = capture(out.stderrBytes);
  process.exitCode = undefined;
  try {
    const code = runSmellLedgerGate(gate, graph, {
      json: input.json,
      pretty: input.pretty,
      emit(payload) {
        stage = "emit";
        out.ledgerAtEmit.push(
          fs.existsSync(gate.file) && fs.statSync(gate.file).isFile()
            ? fs.readFileSync(gate.file, "utf8")
            : null,
        );
        out.payloads.push(payload);
        if (input.failEmit) throw original;
        outputTo(input.outputFile ?? undefined)(payload);
      },
    });
    exitWith(code);
    out.exit = code;
  } catch (error) {
    assert.ok(error instanceof Error);
    const code = z.object({ code: z.string().optional() }).parse(error).code;
    out.thrown = {
      stage,
      name: error.name,
      message: error.message,
      ioKind:
        code === "ENOENT"
          ? "NotFound"
          : code === "EISDIR"
            ? "IsADirectory"
            : code === "EACCES"
              ? "PermissionDenied"
              : null,
      callbackIdentity: error === original,
    };
  } finally {
    out.processExit = z
      .number()
      .nullable()
      .parse(process.exitCode ?? null);
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
    process.exitCode = previousExit;
  }
  return out;
}
function files(root: string): Record<string, { bytes: string; mode: number }> {
  const out: Record<string, { bytes: string; mode: number }> = {};
  function visit(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) visit(f);
      else if (e.isFile())
        out[path.relative(root, f)] = {
          bytes: fs.readFileSync(f).toString("base64"),
          mode: fs.statSync(f).mode & 0o777,
        };
    }
  }
  visit(root);
  return out;
}
function write(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function restore(root: string, snapshot: ReturnType<typeof files>) {
  for (const f of Object.keys(files(root)))
    if (!(f in snapshot)) fs.unlinkSync(path.join(root, f));
  for (const [relative, value] of Object.entries(snapshot)) {
    const file = path.join(root, relative);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
    write(file, Buffer.from(value.bytes, "base64"));
    fs.chmodSync(file, value.mode);
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
const pureWire = z
  .object({
    gatedIdentity: z.boolean(),
    canonicalIdentity: z.array(z.number()),
    unrecordedIdentity: z.array(z.number()),
    keptIdentity: z.array(z.number()),
    prunedIdentity: z.array(z.number()),
    acceptedIdentity: z.array(z.number()),
    keptNumbers: z.array(z.string()),
    keys: z.array(z.string()),
    canonical: z.unknown(),
    serialized: z.string(),
    result: z.unknown(),
    accepted: z.unknown(),
    gate: z.object({ stdout: z.string(), exitCode: z.number() }),
    acceptedText: z.string(),
  })
  .strict();
const runWire = z
  .object({
    exit: z.number().nullable(),
    processExit: z.number().nullable(),
    thrown: z
      .object({
        stage: z.string(),
        name: z.string(),
        message: z.string(),
        ioKind: z.string().nullable(),
        callbackIdentity: z.boolean(),
      })
      .nullable(),
    payloads: z.array(z.string()),
    stdoutBytes: z.array(z.number()),
    stderrBytes: z.array(z.number()),
    ledgerAtEmit: z.array(z.string().nullable()),
    preparation: z.unknown(),
    sourceFiles: z.number().nullable(),
    smells: z.array(z.unknown()),
    measured: z.array(kind),
    pendingStdio: z.number(),
  })
  .strict();
function compare(
  request: Request,
  fixture?: string,
  qualified = false,
  literal?: (value: unknown) => void,
) {
  const before = fixture ? files(fixture) : null;
  const originalStamp =
    request.operation === "run" ? stamp(request.input.file) : null;
  const expected =
    request.operation === "pure"
      ? pure(request.input)
      : request.operation === "targets"
        ? sourceTargets(request.input)
        : sourceRun(request.input);
  if (literal) literal(expected);
  const after = fixture ? files(fixture) : null;
  const sourceUnchanged =
    request.operation === "run"
      ? originalStamp === stamp(request.input.file)
      : null;
  if (fixture && before) restore(fixture, before);
  const nativeStamp =
    request.operation === "run" ? stamp(request.input.file) : null;
  const child = spawnSync(binary, [manifest], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });
  let actual: unknown,
    calls: string[] = [],
    passed = false;
  try {
    assert.equal(child.status, 0, child.stderr);
    const parsed = response.parse(JSON.parse(child.stdout));
    assert.equal(parsed.id, request.id);
    calls = parsed.calls;
    actual =
      request.operation === "pure"
        ? pureWire.parse(parsed.result)
        : request.operation === "run"
          ? runWire.parse(parsed.result)
          : z
              .object({
                targets: z.array(z.string()),
                findings: z.array(z.unknown()),
              })
              .strict()
              .parse(parsed.result);
    if (qualified && request.operation === "run") {
      const a = runWire.parse(structuredClone(actual)),
        e = runWire.parse(structuredClone(expected));
      assert.ok(a.thrown && e.thrown);
      assert.equal(a.thrown.stage, e.thrown.stage);
      a.thrown.message = e.thrown.message =
        "<original backend diagnostics retained>";
      assert.deepEqual(a, e);
    } else assert.deepEqual(actual, expected);
    if (literal) literal(actual);
    if (fixture) assert.deepEqual(files(fixture), after);
    if (request.operation === "run")
      assert.equal(
        nativeStamp === stamp(request.input.file),
        sourceUnchanged,
        "actual write/no-write occurrence",
      );
    passed = true;
  } catch (error) {
    failures.push({ id: request.id, message: String(error) });
  }
  rows.push({
    id: request.id,
    operation: request.operation,
    passed,
    qualified,
    qualification: qualified
      ? "Original Source/native backend messages retained; exact remaining behavior/file bytes/modes/ordering compared"
      : null,
    input: request.input,
    expected,
    actual,
    calls,
    process: {
      status: child.status,
      signal: child.signal,
      stderr: child.stderr,
    },
    before,
    afterSource: after,
    afterNative: fixture ? files(fixture) : null,
    sourceLedgerUnchanged: sourceUnchanged,
  });
  return actual;
}
const high = "high-complexity" as const,
  fan = "high-fan-in" as const;
const f = (
  target: string,
  value: z.infer<typeof numeric>,
  rule: z.infer<typeof kind> = high,
) => ({ rule, target, value });
const e = (
  target: string,
  value: z.infer<typeof numeric>,
  reason = "old",
  rule: z.infer<typeof kind> = high,
) => ({ ...f(target, value, rule), reason });
function p(
  id: string,
  patch: Partial<Pure> = {},
  literal?: (value: unknown) => void,
) {
  for (const [suffix, json, pretty] of [
    ["text", false, false],
    ["json", true, false],
    ["pretty", true, true],
  ] as const)
    compare(
      {
        id: `pure.${id}.${suffix}`,
        operation: "pure",
        input: pureSchema.parse({
          scope: "app",
          gated: [high],
          measured: [high],
          findings: [],
          entries: [],
          reason: "new",
          json,
          pretty,
          ...patch,
        }),
      },
      undefined,
      false,
      literal,
    );
}
function r(
  id: string,
  root: string,
  patch: Partial<Run> = {},
  qualified = false,
  literal?: (value: unknown) => void,
) {
  return compare(
    {
      id,
      operation: "run",
      input: runSchema.parse({
        root,
        repoRoot: root,
        file: path.join(root, "smell-ledger.json"),
        scope: "app",
        prepare: false,
        accept: false,
        ci: false,
        reason: "intentional",
        gated: [high],
        entries: [],
        smells: [],
        project: false,
        edges: false,
        json: false,
        pretty: false,
        failEmit: false,
        outputFile: null,
        thresholds: ThresholdsSchema.parse({ highComplexity: 1, highFanIn: 1 }),
        ...patch,
      }),
    },
    patch.repoRoot ?? root,
    qualified,
    literal,
  );
}
const functionSmell = (value: number): z.infer<typeof smell> => ({
  kind: high,
  target: {
    type: "function",
    file: "x.ts",
    id: "x.ts:calculate",
    startLine: 1,
  },
  value,
});
try {
  p("empty");
  p(
    "duplicate-last",
    { findings: [f("app/z", 2), f("app/a", 3), f("app/z", 7)] },
    (v) => {
      const x = pureWire.parse(v);
      assert.deepEqual(x.unrecordedIdentity, [2, 1]);
    },
  );
  p("sibling-scope", {
    entries: [e("app/gone", 3), e("application/keep", 5), e("app", 4)],
  });
  p("unmeasured", {
    gated: [high, fan],
    entries: [e("app/calls", 4, "edges", fan)],
    measured: [high],
  });
  p("ungated", {
    entries: [e("app/calls", 4, "edges", fan)],
    findings: [f("app/ignored", 9, fan)],
    measured: [high, fan],
  });
  p(
    "worsened",
    { entries: [e("app/x", 3)], findings: [f("app/x", 7)] },
    (v) => {
      const x = pureWire.parse(v);
      assert.deepEqual(x.keptNumbers, ["3"]);
    },
  );
  p("lowered", { entries: [e("app/x", 7)], findings: [f("app/x", 3)] }, (v) =>
    assert.equal(pureWire.parse(v).gate.exitCode, 0),
  );
  p(
    "fresh-equal",
    { entries: [e("app/x", 3)], findings: [f("app/x", 3)] },
    (v) => assert.deepEqual(pureWire.parse(v).keptIdentity, [-1]),
  );
  p(
    "retained",
    {
      entries: [e("other/x", 3), e("app/edge", 7, "edges", fan)],
      gated: [high, fan],
    },
    (v) => assert.ok(pureWire.parse(v).keptIdentity.every((n) => n >= 0)),
  );
  p(
    "first-reason",
    { entries: [e("other/x", 3, "first"), e("other/x", 7, "second")] },
    (v) => assert.deepEqual(pureWire.parse(v).canonicalIdentity, [0]),
  );
  p("accepted-reason", {
    entries: [e("app/x", 2)],
    findings: [f("app/x", 4), f("app/new", 6)],
    reason: "  supplied literally  ",
  });
  p("sections", {
    entries: [e("app/lower", 7), e("app/gone", 4), e("app/worse", 2)],
    findings: [f("app/lower", 3), f("app/worse", 5), f("app/new", 6)],
  });
  p("all-kept-count", { entries: [e("other/x", 3), e("else/y", 4)] });
  p("foreign-unrecorded", { findings: [f("foreign/x", 3)] });
  p("root-scope", { scope: ".", entries: [e("any/gone", 4)] });
  p("key-collision", { findings: [f('a", "b', 3), f("a", 4)] });
  for (const [id, raw] of [
    ["high", "\ud800"],
    ["low", "\udfff"],
    ["astral", "𐀀"],
    ["prototype", "__proto__"],
    ["nul", "\0"],
  ] as const)
    p(`raw-${id}`, {
      scope: raw,
      entries: [e(`${raw}/old`, 3)],
      findings: [f(`${raw}/new`, 4)],
      reason: raw,
    });
  const numbers = ["-Infinity", -3, "-0", 0, 3, "Infinity", "NaN"] as const;
  for (let a = 0; a < numbers.length; a++)
    for (let b = 0; b < numbers.length; b++)
      compare(
        {
          id: `pure.numeric-${a}-${b}`,
          operation: "pure",
          input: pureSchema.parse({
            scope: "app",
            gated: [high],
            measured: [high],
            entries: [e("app/x", numbers[a])],
            findings: [f("app/x", numbers[b])],
            reason: "raw numbers",
            json: false,
            pretty: false,
          }),
        },
        undefined,
        false,
        (v) =>
          assert.deepEqual(pureWire.parse(v).keptNumbers, [
            numberTag(Math.min(number(numbers[a]), number(numbers[b]))),
          ]),
      );
  for (const [id, scope, smells, expected] of [
    [
      "function-id",
      "packages/app",
      [
        {
          kind: high,
          target: {
            type: "function",
            file: "src/x.ts",
            id: "src/x.ts:calculate#2",
            startLine: 900,
          },
          value: 3,
        },
      ],
      ["packages/app/src/x.ts:calculate#2"],
    ],
    [
      "mismatched-utf16-prefix",
      "app",
      [
        {
          kind: high,
          target: { type: "function", file: "a", id: "𐀀:x", startLine: 1 },
          value: 2,
        },
      ],
      ["app/a\udc00:x"],
    ],
    [
      "long-prefix",
      ".",
      [
        {
          kind: high,
          target: { type: "function", file: "long.ts", id: "x", startLine: 1 },
          value: 2,
        },
      ],
      ["long.ts"],
    ],
    [
      "paths",
      "packages/app",
      [
        {
          kind: high,
          target: { type: "module", file: "./x/../file.ts" },
          value: 2,
        },
        { kind: high, target: { type: "directory", dir: "." }, value: 4 },
      ],
      ["packages/app/file.ts", "packages/app"],
    ],
  ] as const)
    compare(
      {
        id: `targets.${id}`,
        operation: "targets",
        input: targetsSchema.parse({ scope, smells }),
      },
      undefined,
      false,
      (v) =>
        assert.deepEqual(
          z.object({ targets: z.array(z.string()) }).parse(v).targets,
          expected,
        ),
    );
  const kernel = path.join(directory, "kernel");
  write(path.join(kernel, "tsconfig.json"), "{}");
  r("run.inactive-before-analysis", kernel, {
    prepare: true,
    root: path.join(kernel, "absent"),
  });
  r("run.syntax-measured", kernel);
  r("run.edges-measured", kernel, { edges: true });
  r("run.unrecorded-fails", kernel, { smells: [functionSmell(3)] });
  r("run.accept", kernel, { accept: true, smells: [functionSmell(3)] });
  write(
    path.join(kernel, "smell-ledger.json"),
    serializeSmellLedger({
      gated: [high],
      entries: [
        { rule: high, target: "app/x.ts:calculate", value: 7, reason: "old" },
      ],
    }),
  );
  r("run.lowered-before-emit-error", kernel, {
    entries: [e("app/x.ts:calculate", 7)],
    smells: [functionSmell(3)],
    failEmit: true,
  });
  r("run.improves-while-failing", kernel, {
    entries: [e("app/x.ts:calculate", 7)],
    smells: [
      functionSmell(3),
      { kind: high, target: { type: "module", file: "new.ts" }, value: 4 },
    ],
  });
  const ledger = path.join(kernel, "smell-ledger.json");
  write(ledger, ' {"entries":[],"gated":["high-complexity"]}  \n');
  fs.chmodSync(ledger, 0o444);
  r("run.repeat-no-write", kernel, {
    accept: true,
    entries: [e("app/x.ts:calculate", 3)],
    smells: [functionSmell(3)],
  });
  fs.chmodSync(ledger, 0o644);
  r(
    "run.missing-parent-write",
    kernel,
    {
      file: path.join(kernel, "missing/ledger.json"),
      accept: true,
      smells: [functionSmell(3)],
    },
    true,
  );
  r(
    "run.directory-write",
    kernel,
    { file: kernel, accept: true, smells: [functionSmell(3)] },
    true,
  );
  r(
    "run.nul-write",
    kernel,
    { file: `${kernel}/bad\0`, accept: true, smells: [functionSmell(3)] },
    true,
  );
  r("run.output-file", kernel, {
    smells: [functionSmell(3)],
    outputFile: path.join(kernel, "report.txt"),
    json: true,
    pretty: true,
  });
  r(
    "run.output-refused-after-write",
    kernel,
    {
      accept: true,
      smells: [functionSmell(3)],
      outputFile: path.join(kernel, "absent/out.txt"),
    },
    true,
  );
  r("run.raw-host-bytes", kernel, {
    scope: "raw\ud800",
    reason: "why\udfff",
    accept: true,
    smells: [functionSmell(3)],
    outputFile: path.join(kernel, "raw.txt"),
  });
  const workspace = path.join(directory, "workspace");
  write(
    path.join(workspace, "pnpm-workspace.yaml"),
    "packages: [packages/*]\n",
  );
  const api = (branches: number) =>
    `import {price} from './pricing';\nexport function api(amount:number){${branches === 2 ? "if(amount<0)return -1;" : ""}${branches > 0 ? "if(amount>0)return price(amount);return 0;" : "return price(amount);"}}\n`;
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
      path.join(root, "src/pricing.ts"),
      "export function price(amount:number){return amount;}\n",
    );
    write(path.join(root, "src/api.ts"), api(1));
    write(
      path.join(root, "src/worker.ts"),
      "import {price} from './pricing';export function worker(amount:number){return price(amount);}\n",
    );
  }
  write(
    path.join(workspace, "smell-ledger.json"),
    '{"gated":["high-fan-in","high-complexity"],"entries":[]}\n',
  );
  const a = path.join(workspace, "packages/a"),
    b = path.join(workspace, "packages/b");
  const workflow = (id: string, root: string, patch: Partial<Run> = {}) =>
    r(`workflow.${id}`, root, {
      repoRoot: workspace,
      file: path.join(workspace, "smell-ledger.json"),
      prepare: true,
      project: true,
      accept: true,
      reason: "intentional fixture",
      ...patch,
    });
  const recorded = runWire.parse(workflow("record-two", a));
  assert.equal(recorded.exit, 0);
  assert.equal(recorded.sourceFiles, 3);
  const parsedSmells = z
    .array(z.object({ kind, value: z.number(), target: z.unknown() }))
    .parse(recorded.smells);
  assert.equal(parsedSmells.find((s) => s.kind === fan)?.value, 2);
  assert.equal(parsedSmells.find((s) => s.kind === high)?.value, 2);
  fs.chmodSync(path.join(workspace, "smell-ledger.json"), 0o444);
  workflow("repeat-readonly", a);
  fs.chmodSync(path.join(workspace, "smell-ledger.json"), 0o640);
  write(path.join(a, "src/api.ts"), api(2));
  assert.equal(
    runWire.parse(
      workflow("worse-fails", a, { accept: false, ci: true, reason: null }),
    ).exit,
    1,
  );
  workflow("raise-with-reason", a, {
    reason: "accepted extra branch",
    json: true,
    pretty: true,
  });
  write(path.join(a, "src/api.ts"), api(1));
  workflow("shrink-tightens", a, { accept: false, ci: true, reason: null });
  write(path.join(a, "src/api.ts"), api(0));
  workflow("gone-prunes", a, { accept: false, ci: true, reason: null });
  workflow("second-scope-record", b);
  write(path.join(b, "src/api.ts"), api(0));
  workflow("second-scope-prune", b, {
    accept: false,
    ci: true,
    reason: null,
    json: true,
  });
  workflow("first-scope-retained", a, {
    accept: false,
    ci: true,
    reason: null,
    json: true,
  });
  const final = z
    .object({
      entries: z.array(
        z.object({ target: z.string(), rule: kind, value: z.number() }),
      ),
    })
    .parse(
      JSON.parse(
        fs.readFileSync(path.join(workspace, "smell-ledger.json"), "utf8"),
      ),
    );
  assert.deepEqual(
    final.entries.map((e) => [e.rule, e.target, e.value]),
    [
      [fan, "packages/a/src/pricing.ts:price", 2],
      [fan, "packages/b/src/pricing.ts:price", 2],
    ],
  );
  for (const [id, input] of [
    ["unknown-op", { id: "bad", operation: "bad", input: {} }],
    [
      "bad-kind",
      {
        id: "bad",
        operation: "pure",
        input: {
          scope: "x",
          gated: ["unknown"],
          measured: [],
          entries: [],
          findings: [],
          reason: "x",
          json: false,
          pretty: false,
        },
      },
    ],
    [
      "unknown-field",
      {
        id: "bad",
        operation: "targets",
        input: { scope: "x", smells: [], extra: true },
      },
    ],
    ["malformed", "{"],
  ] as const) {
    const child = spawnSync(binary, [manifest], {
      input: typeof input === "string" ? input : JSON.stringify(input),
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
  }
} catch (error) {
  failures.push({ id: "harness", message: String(error) });
} finally {
  const report = {
    reference: { node: process.version, v8: process.versions.v8 },
    binary: { path: binary, sha256: hash(fs.readFileSync(binary)) },
    sourceHashes,
    passed: rows.filter((r) => r.passed && !r.protocol).length,
    strict: rows.filter((r) => r.passed && !r.protocol && !r.qualified).length,
    qualified: rows.filter((r) => r.passed && !r.protocol && r.qualified)
      .length,
    protocolRefusals: rows.filter((r) => r.protocol).length,
    failures,
    cases: rows,
    knownGaps: [
      "Existing ICU4X mixed-lone collation gap remains OPEN, not exercised as strict equivalence here; prior exact three-case evidence is separately pinned.",
      "Graph IDs/files/dirs remain canonical String profile; raw Graph/prototype/getter/extra-field behavior not claimed.",
      "Native stdio pending failure contract and platform diagnostic messages remain qualified; no CLI attachment or closure of53CLI gaps.",
    ],
  };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  for (const [file, digest] of Object.entries(sourceHashes))
    assert.equal(hash(fs.readFileSync(path.join(repo, file))), digest);
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    observations: rows.filter((r) => !r.protocol).length,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
