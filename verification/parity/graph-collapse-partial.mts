import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isCandidateFunction } from "../../packages/code-graph/src/collapse/candidates.js";
import { findPartialTwins } from "../../packages/code-graph/src/collapse/partial.js";
import { CollapseSettingsSchema } from "../../packages/code-graph/src/collapse/settings.js";
import { tsgoBinary } from "../../packages/code-graph/src/engine/tsgo.js";
import { assembleGraphWithEdges } from "../../packages/code-graph/src/extract/assemble.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import { NodeKindRulesSchema } from "../../packages/code-graph/src/kinds/rules.js";
import {
  FunctionKindSchema,
  type FunctionNode,
  FunctionNodeSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";

const binary = process.argv[2],
  reportFile = process.argv[3];
assert.ok(
  binary && reportFile,
  "usage: graph-collapse-partial.mts <driver> <report> [--ids list]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const selectedAt = process.argv.indexOf("--ids"),
  selected =
    selectedAt < 0 ? null : new Set(process.argv[selectedAt + 1]?.split(","));
const repository = fileURLToPath(new URL("../..", import.meta.url));
const manifest = createRequire(
  path.join(repository, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const compiler = await tsgoBinary();
assert.equal(compiler.version, "7.0.0-dev.20260707.2");
const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const temporary = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-partial-parity-")),
);
const callSchema = z.strictObject({
  calleeId: z.string(),
  line: z.number().int().nonnegative(),
  constArgs: z.array(z.string()),
});
const nodeSchema = z.strictObject({
  id: z.string(),
  file: z.string(),
  startLine: z.number().int().nonnegative(),
  loc: z.number().int().nonnegative(),
  complexity: z.number().int().nonnegative(),
  kind: FunctionKindSchema,
  isTest: z.boolean(),
  calls: z.array(callSchema).nullable().default(null),
});
const pureSchema = z.strictObject({
  operation: z.literal("pure"),
  nodes: z.array(nodeSchema),
  settings: CollapseSettingsSchema.default(() =>
    CollapseSettingsSchema.parse({}),
  ),
  filterCandidates: z.boolean().default(false),
});
const projectSchema = z.strictObject({
  operation: z.literal("project"),
  root: z.string(),
  repoRoot: z.string(),
  nativePreviewManifest: z.string(),
  settings: CollapseSettingsSchema.default(() =>
    CollapseSettingsSchema.parse({}),
  ),
});
const inputSchema = z.discriminatedUnion("operation", [
  pureSchema,
  projectSchema,
]);
type Input = z.infer<typeof inputSchema>;
type Node = z.infer<typeof nodeSchema>;
type Call = z.infer<typeof callSchema>;
const twinSchema = z.strictObject({
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
const outputSchema = z.strictObject({
  eligible: z.array(z.boolean()),
  twins: z.array(twinSchema),
  borrowedOwners: z.boolean(),
  functions: FunctionNodeSchema.array().optional(),
  moduleFiles: z.array(z.string()).optional(),
});
const thrownSchema = z.strictObject({
  stage: z.enum(["load", "assembly"]),
  name: z.string(),
  message: z.string(),
});
const responseSchema = z
  .strictObject({
    id: z.string(),
    output: outputSchema.optional(),
    thrown: thrownSchema.optional(),
    observedCalls: z.array(z.string()),
  })
  .refine((x) => (x.output === undefined) !== (x.thrown === undefined));
type Response = z.infer<typeof responseSchema>;
type Case = {
  id: string;
  input: Input;
  expectedCount?: number;
  rawBackend?: true;
  fixtureChange?: {
    before: ReturnType<typeof snapshot>;
    after: ReturnType<typeof snapshot>;
  };
};
const cases: Case[] = [];
function call(calleeId: string, line = 10, constArgs = ["LIMIT"]): Call {
  return { calleeId, line, constArgs };
}
function node(
  id: string,
  callees = ["p", "q", "r", "left"],
  changes: Partial<Node> = {},
): Node {
  return {
    id,
    file: "retry.ts",
    startLine: 1,
    loc: 12,
    complexity: 2,
    kind: "function",
    isTest: false,
    calls: callees.map((c, index) =>
      call(c, 10 + index, index === 1 ? ["LIMIT"] : []),
    ),
    ...changes,
  };
}
const base = () => [node("a"), node("b", ["p", "q", "r", "right"])];
function pure(
  id: string,
  nodes: Node[],
  settings: Record<string, number> = {},
  filterCandidates = false,
  expectedCount?: number,
) {
  cases.push({
    id,
    input: inputSchema.parse({
      operation: "pure",
      nodes,
      settings,
      filterCandidates,
    }),
    expectedCount,
  });
}
pure("decision", base(), {}, false, 1);
pure("orientation", base().reverse(), {}, false, 1);
pure("empty", [], {}, false, 0);
pure("single", [node("a")], {}, false, 0);
pure(
  "absent-edges",
  [node("a", [], { calls: null }), node("b", [], { calls: null })],
  {},
  false,
  0,
);
for (const kind of FunctionKindSchema.options)
  pure(
    `kind.${kind}`,
    [node("a", undefined, { kind }), base()[1]],
    {},
    true,
    ["constructor", "getter", "setter"].includes(kind) ? 0 : 1,
  );
for (const [id, changes, count] of [
  ["test", { isTest: true }, 0],
  ["no-edges", { calls: null }, 0],
  ["short", { loc: 4 }, 0],
  ["loc-boundary", { loc: 5 }, 1],
  ["branchless", { complexity: 1 }, 0],
  ["complexity-boundary", { complexity: 2 }, 1],
] as const)
  pure(
    `candidate.${id}`,
    [node("a", undefined, changes), base()[1]],
    {},
    true,
    count,
  );
pure(
  "candidate.lower-threshold",
  [node("a", undefined, { loc: 1, complexity: 1 }), base()[1]],
  { minLoc: 1, minComplexity: 1 },
  true,
  1,
);
pure("candidate.higher-threshold", base(), { minLoc: 13 }, true, 0);
pure(
  "kernel-does-not-refilter",
  [
    node("a", undefined, { isTest: true }),
    node("b", ["p", "q", "r", "right"], { kind: "constructor" }),
  ],
  {},
  false,
  1,
);
pure(
  "zero-call-lines",
  [
    node("a", undefined, {
      calls: base()[0].calls?.map((c) => ({ ...c, line: 0 })),
    }),
    base()[1],
  ],
  {},
  false,
  1,
);
pure(
  "different-constants",
  [
    base()[0],
    node("b", undefined, {
      calls: base()[1].calls?.map((c) => ({
        ...c,
        constArgs: c.constArgs.map(() => "OTHER"),
      })),
    }),
  ],
  {},
  false,
  0,
);
pure(
  "no-constants",
  base().map((n) => ({
    ...n,
    calls: n.calls?.map((c) => ({ ...c, constArgs: [] })) ?? null,
  })),
  {},
  false,
  0,
);
pure(
  "constants-positional",
  [
    base()[0],
    node("b", undefined, {
      calls: [
        call("p", 10, ["LIMIT"]),
        call("q", 11, []),
        call("r", 12, []),
        call("right", 13, []),
      ],
    }),
  ],
  {},
  false,
  0,
);
pure(
  "constants-duplicate-does-not-inflate",
  base().map((n) => ({
    ...n,
    calls:
      n.calls?.map((c) => ({
        ...c,
        constArgs: c.constArgs.flatMap((x) => [x, x, x]),
      })) ?? null,
  })),
  { partialMinSharedConstants: 2 },
  false,
  0,
);
pure(
  "constants-across-positions-deduplicate",
  base().map((n) => ({
    ...n,
    calls: n.calls?.map((c) => ({ ...c, constArgs: ["LIMIT"] })) ?? null,
  })),
  { partialMinSharedConstants: 2 },
  false,
  0,
);
pure(
  "constants-two-shared",
  base().map((n) => ({
    ...n,
    calls:
      n.calls?.map((c) => ({
        ...c,
        constArgs: c.constArgs.length ? ["B", "A", "A"] : [],
      })) ?? null,
  })),
  { partialMinSharedConstants: 2 },
  false,
  1,
);
pure(
  "constants-empty-name-is-data",
  base().map((n) => ({
    ...n,
    calls:
      n.calls?.map((c) => ({
        ...c,
        constArgs: c.constArgs.length ? [""] : [],
      })) ?? null,
  })),
  {},
  false,
  1,
);
pure("containment", [node("a", ["p", "q", "r"]), base()[1]], {}, false, 0);
pure("identical-tail", [node("a"), node("b")], {}, false, 0);
pure("prefix-short", base(), { partialMinPrefix: 4 }, false, 0);
pure("width-two", base(), { partialMinPrefix: 2 }, false, 1);
pure("huge-width", base(), { partialMinPrefix: 1e12 }, false, 0);
pure(
  "huge-shared-constant-min",
  base(),
  { partialMinSharedConstants: 1e12 },
  false,
  0,
);
pure(
  "mid-block",
  [
    node("a", ["head-a", "p", "q", "r", "left"], {
      calls: [
        call("head-a", 1, []),
        call("p", 2, []),
        call("q", 3, ["LIMIT"]),
        call("r", 4, []),
        call("left", 5, []),
      ],
    }),
    node("b", ["head-b", "intro", "p", "q", "r", "right"], {
      calls: [
        call("head-b", 1, []),
        call("intro", 2, []),
        call("p", 3, []),
        call("q", 4, ["LIMIT"]),
        call("r", 5, []),
        call("right", 6, []),
      ],
    }),
  ],
  {},
  false,
  1,
);
pure(
  "maximal-left-right",
  [
    node("a", ["h", "p", "q", "r", "s", "t", "left"]),
    node("b", ["intro", "h", "p", "q", "r", "s", "t", "right"], {
      calls: ["intro", "h", "p", "q", "r", "s", "t", "right"].map((c, i) =>
        call(c, i + 1, ["LIMIT"]),
      ),
    }),
  ],
  {},
  false,
  1,
);
for (const [id, decoy] of [
  ["left-extension-through-skipped-bucket", ["p", "q", "r", "decoy"]],
  ["right-extension-through-skipped-bucket", ["q", "r", "s", "decoy"]],
] as const) {
  const constantsAt = id.startsWith("left") ? 0 : 3;
  const nodes = [
    node("a", [], {
      calls: ["p", "q", "r", "s", "left"].map((c, i) =>
        call(c, i + 1, i === constantsAt ? ["LIMIT"] : []),
      ),
    }),
    node("b", [], {
      calls: ["p", "q", "r", "s", "right"].map((c, i) =>
        call(c, i + 1, i === constantsAt ? ["LIMIT"] : []),
      ),
    }),
    node("decoy", [...decoy]),
  ];
  pure(id, nodes, { partialMaxBlockSize: 2 }, false, 1);
}
for (const limit of [0, 1, 2, 3, 40])
  pure(
    `bucket.${limit}`,
    base(),
    { partialMaxBlockSize: limit },
    false,
    limit < 2 ? 0 : 1,
  );
const repeated = [
  node("a", ["p", "q", "r", "p", "q", "r", "left"], {
    calls: ["p", "q", "r", "p", "q", "r", "left"].map((c, i) =>
      call(c, i + 1, ["LIMIT"]),
    ),
  }),
  node("b", ["p", "q", "r", "right"]),
];
pure(
  "bucket-repeats-count-as-occurrences",
  repeated,
  { partialMaxBlockSize: 2 },
  false,
  0,
);
pure("bucket-repeats-boundary", repeated, { partialMaxBlockSize: 3 }, false, 1);
pure("same-function-repeats-alone", [repeated[0]], {}, false, 0);
pure(
  "space-shingle-collision",
  [node("a", ["p q", "r", "s", "left"]), node("b", ["p", "q r", "s", "right"])],
  {},
  false,
  1,
);
pure(
  "nul-pair-collision",
  [
    node("a\0b"),
    node("c", ["p", "q", "r", "right"]),
    node("a", ["p", "q", "r", "third"]),
    node("b\0c", ["p", "q", "r", "last"]),
  ],
  {},
  false,
  5,
);
pure(
  "duplicate-ids-keep-first",
  [
    node("same"),
    node("same", ["p", "q", "r", "right"]),
    node("same", ["p", "q", "r", "last"]),
  ],
  {},
  false,
  1,
);
const manyBlocks = (id: string, last: string, constants: string[]) =>
  node(id, [], {
    calls: [
      call("p", 10, ["ONE"]),
      call("q", 11, []),
      call("r", 12, []),
      call(`${id}-split`, 13, []),
      call("x", 20, constants),
      call("y", 21, []),
      call("z", 22, []),
      call(last, 23, []),
    ],
  });
pure(
  "best-more-constants",
  [
    manyBlocks("a", "left", ["TWO", "THREE"]),
    manyBlocks("b", "right", ["TWO", "THREE"]),
  ],
  {},
  false,
  1,
);
pure(
  "best-exact-tie-first",
  [manyBlocks("a", "left", ["ONE"]), manyBlocks("b", "right", ["ONE"])],
  {},
  false,
  1,
);
pure(
  "best-longer-block",
  [
    node("a", [], {
      calls: [
        ...(base()[0].calls?.slice(0, 3) ?? []),
        call("a-split", 14, []),
        call("x", 20, ["L"]),
        call("y", 21, []),
        call("z", 22, []),
        call("w", 23, []),
        call("left", 24, []),
      ],
    }),
    node("b", [], {
      calls: [
        ...(base()[1].calls?.slice(0, 3) ?? []),
        call("b-split", 14, []),
        call("x", 20, ["L"]),
        call("y", 21, []),
        call("z", 22, []),
        call("w", 23, []),
        call("right", 24, []),
      ],
    }),
  ],
  {},
  false,
  1,
);
for (const [id, raw] of [
  ["high", "\ud800"],
  ["low", "\udc00"],
  ["pair", "𐀀"],
  ["nul", "\0"],
])
  pure(
    `callee.${id}`,
    [node("a", [raw, "q", "r", "left"]), node("b", [raw, "q", "r", "right"])],
    {},
    false,
    1,
  );
pure(
  "callee-raw-is-not-replacement",
  [
    node("a", ["\ud800", "q", "r", "left"]),
    node("b", ["�", "q", "r", "right"]),
  ],
  {},
  false,
  0,
);
pure(
  "unicode-constant-order",
  base().map((n) => ({
    ...n,
    calls:
      n.calls?.map((c) => ({
        ...c,
        constArgs: c.constArgs.length
          ? ["é", "e\u0301", "Z", "a", "A", "Á", "\0"]
          : [],
      })) ?? null,
  })),
  {},
  false,
  1,
);
pure(
  "unicode-id-final-order",
  ["z", "a", "A", "é", "e\u0301", "𐀀", "\ue000"].map((id, index) =>
    node(id, ["p", "q", "r", `out-${index}`]),
  ),
  {},
  false,
  21,
);
pure(
  "long-calls",
  Array.from({ length: 3 }, (_, i) =>
    node(`long-${i}`, [], {
      calls: [
        ...Array.from({ length: 130 }, (_, j) =>
          call(`step-${j}`, j + 1, ["LIMIT"]),
        ),
        call(`end-${i}`, 131, []),
      ],
    }),
  ),
  {},
  false,
  3,
);
function snapshot(root: string) {
  const files: Record<
    string,
    { sha256: string; base64: string; mode: number }
  > = {};
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name),
        stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(file);
        files[path.relative(root, file)] = {
          sha256: hash(bytes),
          base64: bytes.toString("base64"),
          mode: stat.mode & 0o777,
        };
      }
    }
  }
  walk(root);
  return files;
}
const fixtureSource = path.join(
  repository,
  "verification/parity/fixtures/collapse-partial",
);
function project(name: string, folder = "scope", parentConfig = false) {
  const base = path.join(temporary, name);
  fs.mkdirSync(base);
  const before = snapshot(base),
    root = path.join(base, folder);
  fs.mkdirSync(root);
  for (const name of ["tsconfig.json", "limits.ts", "helpers.ts", "retry.ts"])
    fs.copyFileSync(path.join(fixtureSource, name), path.join(root, name));
  if (parentConfig) {
    fs.renameSync(
      path.join(root, "tsconfig.json"),
      path.join(base, "tsconfig.json"),
    );
  }
  return { base, root, setup: { before, after: snapshot(base) } };
}
function graphCase(
  id: string,
  p: { root: string; base: string },
  expectedCount?: number,
  rawBackend?: true,
  fixtureChange?: Case["fixtureChange"],
) {
  return {
    id,
    input: inputSchema.parse({
      operation: "project",
      root: p.root,
      repoRoot: p.base,
      nativePreviewManifest: manifest,
    }),
    expectedCount,
    rawBackend,
    fixtureChange,
  };
}
const regular = project("regular"),
  high = project("high", "raw�"),
  child = project("child", "raw�", true),
  alias = project("alias"),
  duplicate = project("duplicate");
const aliasBefore = snapshot(alias.base),
  aliasFile = path.join(alias.root, "retry.ts");
fs.writeFileSync(
  aliasFile,
  fs
    .readFileSync(aliasFile, "utf8")
    .replace("MAX_ATTEMPTS,BACKOFF", "MAX_ATTEMPTS as LIMIT,BACKOFF")
    .replaceAll("decide(count,MAX_ATTEMPTS)", "decide(count,LIMIT)"),
);
cases.push(
  graphCase("graph.alias-name-not-canonicalized", alias, 0, undefined, {
    before: aliasBefore,
    after: snapshot(alias.base),
  }),
);
const dupBefore = snapshot(duplicate.base),
  dupFile = path.join(duplicate.root, "retry.ts");
fs.writeFileSync(
  dupFile,
  fs
    .readFileSync(dupFile, "utf8")
    .replaceAll(
      "decide(count,MAX_ATTEMPTS)",
      "decide(count,MAX_ATTEMPTS,MAX_ATTEMPTS)",
    ),
);
const helpers = path.join(duplicate.root, "helpers.ts");
fs.writeFileSync(
  helpers,
  fs
    .readFileSync(helpers, "utf8")
    .replace("max:number)", "max:number,...rest:number[])"),
);
cases.push(
  graphCase("graph.duplicate-named-arguments", duplicate, 1, undefined, {
    before: dupBefore,
    after: snapshot(duplicate.base),
  }),
);
cases.push(
  graphCase(
    "graph.raw-config",
    { ...high, root: `${high.root.slice(0, -1)}\ud800` },
    undefined,
    true,
  ),
  graphCase("graph.replacement-config", high, 1),
  graphCase(
    "graph.raw-source",
    { ...child, root: `${child.root.slice(0, -1)}\ud800` },
    undefined,
    true,
  ),
  graphCase("graph.replacement-source", child, 1),
);
const workflowThird =
  "\nexport function settleTransientStep(state:{attempts:number}) {\n  const count=noteAttempt(state);\n  const decision=decide(count,MAX_ATTEMPTS);\n  logAttempt(count);\n  if(decision==='give_up') {\n    return settlePending(decision);\n  }\n  return String(armTimer(BACKOFF));\n}\n";
const workflowIds = [
  "workflow.one",
  "workflow.repeat",
  "workflow.three",
  "workflow.zero",
];
const sourceHashes = Object.fromEntries(
  [
    "collapse/candidates.ts",
    "collapse/partial.ts",
    "collapse/settings.ts",
    "extract/assemble.ts",
    "extract/edges.ts",
    "checker/context.ts",
    "schema/core.ts",
  ].map((file) => [
    file,
    hash(
      fs.readFileSync(path.join(repository, "packages/code-graph/src", file)),
    ),
  ]),
);
function fromNode(n: Node): FunctionNode {
  return {
    id: n.id,
    name: n.id,
    file: n.file,
    kind: n.kind,
    startLine: n.startLine,
    endLine: n.startLine,
    loc: n.loc,
    commentLines: 0,
    nestingDepth: 0,
    complexity: n.complexity,
    isExported: false,
    isTest: n.isTest,
    edges:
      n.calls === null
        ? null
        : {
            calls: n.calls.map((c) => ({ ...c, declaration: null })),
            calledBy: [],
            callChainDepth: 0,
          },
    nodeKind: null,
    smells: [],
  };
}
function source(input: Input) {
  let stage: "load" | "assembly" = "load";
  try {
    if (input.operation === "pure") {
      const nodes = input.nodes.map(fromNode),
        before = JSON.stringify(nodes);
      const eligible = nodes.map((n) => isCandidateFunction(n, input.settings));
      const considered = nodes.filter(
        (_, i) => !input.filterCandidates || eligible[i],
      );
      const twins = findPartialTwins(considered, input.settings);
      assert.equal(JSON.stringify(nodes), before);
      return { output: { eligible, twins } };
    }
    const loaded = loadEdgeProject(input.root, "package", input.repoRoot);
    stage = "assembly";
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
    const eligible = graph.functions.map((n) =>
      isCandidateFunction(n, input.settings),
    );
    return {
      output: {
        eligible,
        twins: findPartialTwins(
          graph.functions.filter((_, i) => eligible[i]),
          input.settings,
        ),
        functions: graph.functions,
        moduleFiles: graph.modules.map((m) => m.file),
      },
    };
  } catch (error) {
    assert.ok(error instanceof Error);
    return { thrown: { stage, name: error.name, message: error.message } };
  }
}
function native(request: unknown) {
  const run = spawnSync(binary, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}
const answers: unknown[] = [],
  failures: { id: string; kind: string; message: string }[] = [];
let exact = 0,
  qualified = 0;
function pair(test: Case) {
  if (selected !== null && !selected.has(test.id)) return;
  const beforeSource = snapshot(temporary),
    expected = JSON.parse(JSON.stringify(source(test.input))),
    afterSource = snapshot(temporary),
    beforeNative = snapshot(temporary),
    run = native({ id: test.id, input: test.input }),
    afterNative = snapshot(temporary);
  let response: Response | undefined,
    qualification: string | undefined,
    passed = false,
    failureKind = "protocol";
  try {
    assert.equal(run.status, 0, run.stderr);
    response = responseSchema.parse(JSON.parse(run.stdout));
    assert.equal(response.id, test.id);
    failureKind = "semantic";
    assert.equal(run.stderr, "");
    assert.deepEqual(beforeSource, afterSource);
    assert.deepEqual(beforeNative, afterNative);
    assert.deepEqual(beforeSource, beforeNative);
    if (response.output) {
      assert.equal(response.output.borrowedOwners, true);
      if (test.expectedCount !== undefined) {
        assert.equal(
          expected.output.twins.length,
          test.expectedCount,
          "independent Source count",
        );
        assert.equal(response.output.twins.length, test.expectedCount);
      }
    }
    let actual: {
      output?: Omit<z.infer<typeof outputSchema>, "borrowedOwners">;
      thrown?: z.infer<typeof thrownSchema>;
    };
    if (response.output) {
      const { borrowedOwners: _, ...output } = response.output;
      actual = { output };
    } else actual = { thrown: response.thrown };
    try {
      assert.deepEqual(actual, expected);
    } catch (error) {
      if (
        !test.rawBackend ||
        response.thrown === undefined ||
        expected.thrown === undefined
      )
        throw error;
      const suffix = (message: string) => {
        assert.match(message, / after offset \d+$/);
        return message.replace(/ after offset \d+$/, " after offset <backend>");
      };
      assert.deepEqual(
        {
          ...actual,
          thrown: {
            ...response.thrown,
            message: suffix(response.thrown.message),
          },
        },
        {
          ...expected,
          thrown: {
            ...expected.thrown,
            message: suffix(expected.thrown.message),
          },
        },
      );
      qualification = "actual-backend-offset";
    }
    if (response.output) {
      assert.ok(
        response.observedCalls.includes(
          "demlik_code_graph::collapse::partial::find_partial_twins",
        ),
      );
      if (test.input.operation === "pure" && test.input.nodes.length > 0)
        assert.ok(
          response.observedCalls.includes(
            "demlik_code_graph::collapse::candidates::is_candidate_function",
          ),
        );
    }
    passed = true;
    if (qualification === undefined) exact++;
    else qualified++;
  } catch (error) {
    failures.push({ id: test.id, kind: failureKind, message: String(error) });
  }
  answers.push({
    id: test.id,
    input: test.input,
    source: expected,
    native: response ?? run,
    passed,
    qualification,
    files: { beforeSource, afterSource, beforeNative, afterNative },
    fixtureChange: test.fixtureChange,
  });
}
for (const test of cases) pair(test);
const workflowSetup = regular.setup,
  workflowChanges = [];
for (const [index, id] of workflowIds.entries()) {
  let change: Case["fixtureChange"];
  if (index === 2 || index === 3) {
    const before = snapshot(regular.base),
      file = path.join(regular.root, "retry.ts");
    let text = fs.readFileSync(file, "utf8");
    text =
      index === 2
        ? text + workflowThird
        : text.replaceAll("decide(count,MAX_ATTEMPTS)", "decide(count,3)");
    fs.writeFileSync(file, text);
    change = { before, after: snapshot(regular.base) };
    workflowChanges.push({ id, ...change });
  }
  pair(graphCase(id, regular, [1, 1, 3, 0][index], undefined, change));
}
const invalids = [
  {},
  { id: "bad", input: { operation: "unknown" } },
  {
    id: "bad",
    input: { operation: "pure", nodes: [], settings: { partialMinPrefix: 1 } },
  },
  { id: "bad", input: { operation: "pure", nodes: [], unknown: true } },
  {
    id: "bad",
    input: { operation: "pure", nodes: [{ ...node("a"), kind: "bogus" }] },
  },
  {
    id: "bad",
    input: {
      operation: "pure",
      nodes: [
        { ...node("a"), calls: [{ calleeId: 3, line: 1, constArgs: [] }] },
      ],
    },
  },
  {
    id: "bad",
    input: {
      operation: "project",
      root: regular.root,
      repoRoot: regular.base,
      nativePreviewManifest: manifest,
      settings: null,
    },
  },
];
for (const [index, input] of invalids.entries()) {
  const run = native(input),
    passed = run.status !== 0;
  answers.push({
    id: `protocol.${index}`,
    protocol: true,
    input,
    native: run,
    passed,
  });
  if (!passed)
    failures.push({
      id: `protocol.${index}`,
      kind: "protocol",
      message: "invalid driver request succeeded",
    });
}
for (const response of [
  {
    id: "bad",
    output: { eligible: [], twins: [], borrowedOwners: true },
    thrown: { stage: "load", name: "Error", message: "bad" },
    observedCalls: [],
  },
  { id: "bad", observedCalls: [] },
  {
    id: "bad",
    output: { eligible: [], twins: [{}], borrowedOwners: true },
    observedCalls: [],
  },
])
  assert.equal(responseSchema.safeParse(response).success, false);
const report = {
  scope:
    "Candidate predicate and borrowed partial-twin kernel only; no full similarity/ranking/cost/clique/ratchet/gate/CLI capability",
  passed: exact + qualified,
  attempted: answers.length - invalids.length,
  unqualifiedPairs: exact,
  qualifiedPairs: qualified,
  rejectedInvalidInputs: invalids.length,
  responseGuards: 3,
  failures,
  reference: {
    node: process.version,
    v8: process.versions.v8,
    sourceHashes,
    compiler: { ...compiler, sha256: hash(fs.readFileSync(compiler.path)) },
  },
  driverSha256: hash(fs.readFileSync(binary)),
  verifierSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  setups: [regular, high, child, alias, duplicate].map((p) => ({
    base: p.base,
    root: p.root,
    ...p.setup,
  })),
  workflowSetup,
  workflowChanges,
  cases: answers,
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    passed: report.passed,
    exact,
    qualified,
    protocol: invalids.length,
    guards: 3,
    failures: failures.length,
  }),
);
assert.equal(failures.length, 0, JSON.stringify(failures));
