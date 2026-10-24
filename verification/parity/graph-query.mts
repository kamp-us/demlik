import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { TypeContext } from "../../packages/code-graph/src/checker/context.js";
import * as ts from "../../packages/code-graph/src/engine/tsgo.js";
import { analysisInputs } from "../../packages/code-graph/src/extract/analysis.js";
import { assembleGraphWithEdges } from "../../packages/code-graph/src/extract/assemble.js";
import { discoverFunctions } from "../../packages/code-graph/src/extract/functions.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import { resolveReferences } from "../../packages/code-graph/src/extract/references.js";
import {
  compileGroup,
  matchingRules,
} from "../../packages/code-graph/src/kinds/rules.js";
import { buildClusterReport } from "../../packages/code-graph/src/query/clusters.js";
import {
  findInterfaceWidth,
  packageOf,
} from "../../packages/code-graph/src/query/interface-width.js";
import { louvain } from "../../packages/code-graph/src/query/louvain.js";
import {
  fullAdjacency,
  invokedAdjacency,
  reachableFrom,
} from "../../packages/code-graph/src/query/reach.js";
import { publicSurfaceFiles } from "../../packages/code-graph/src/query/surface.js";
import { findUnguarded } from "../../packages/code-graph/src/query/unguarded.js";
import { findUnreachable } from "../../packages/code-graph/src/query/unreachable.js";
import {
  type NodeKind,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";

const kindSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("entry"),
    guards: z.array(z.string()).default([]),
    reach: z.enum(["public", "service-binding", "platform"]),
  }),
  z.strictObject({ kind: z.literal("auth") }),
  z.strictObject({ kind: z.literal("effect") }),
  z.strictObject({ kind: z.literal("plain") }),
]);
const ruleSchema = z.strictObject({
  key: z.string(),
  patterns: z.array(z.string()),
});
const querySchema = z.strictObject({
  root: z.string(),
  extraEntryFiles: z.array(z.string()).default([]),
  exportPatterns: z.array(z.string()).default([]),
  testSupport: z.array(ruleSchema).default([]),
  nodeKinds: z.record(z.string(), kindSchema).default({}),
  roots: z.array(z.string()).default([]),
  packageDirs: z.array(z.string()).default([]),
});
const partitionSchema = z.strictObject({
  nodes: z.array(z.string()),
  edges: z.array(
    z.strictObject({ a: z.string(), b: z.string(), weight: z.number() }),
  ),
});
const caseSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    id: z.string(),
    operation: z.literal("code_graph.query"),
    input: querySchema,
  }),
  z.strictObject({
    id: z.string(),
    operation: z.literal("code_graph.partition"),
    input: partitionSchema,
  }),
  z.strictObject({
    id: z.string(),
    operation: z.literal("code_graph.pattern"),
    input: z.strictObject({ source: z.string(), values: z.array(z.string()) }),
  }),
  z.strictObject({
    id: z.string(),
    operation: z.literal("code_graph.rules"),
    input: z.strictObject({
      rules: z.array(ruleSchema),
      values: z.array(z.string()),
    }),
  }),
]);
type Case = z.infer<typeof caseSchema>;
type Query = z.infer<typeof querySchema>;
const resultSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-query.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifest = createRequire(
  path.join(repo, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const compiler = await ts.tsgoBinary();
assert.equal(compiler.version, "7.0.0-dev.20260707.2");
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-query-parity-")),
);
const cases: Case[] = [];
function write(relative: string, source: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}
function config(directory: string): void {
  write(
    `${directory}/tsconfig.json`,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        module: "esnext",
        moduleResolution: "bundler",
        target: "es2022",
      },
    }),
  );
}
function add(
  id: string,
  directory: string,
  options: Partial<Query> = {},
): void {
  cases.push(
    caseSchema.parse({
      id,
      operation: "code_graph.query",
      input: { root: path.join(root, directory), ...options },
    }),
  );
}
function nodeKind(kind: z.infer<typeof kindSchema>): NodeKind {
  switch (kind.kind) {
    case "entry":
      return { ...kind, evidence: ["adapter-entry"] };
    case "auth":
      return { ...kind, evidence: ["adapter-auth"] };
    case "effect":
      return { ...kind, evidence: ["adapter-effect"] };
    case "plain":
      return kind;
  }
}
function reference(item: Case): {
  ok: boolean;
  output?: unknown;
  message?: string;
} {
  try {
    switch (item.operation) {
      case "code_graph.pattern":
        return {
          ok: true,
          output: item.input.values.map((value) =>
            new RegExp(item.input.source).test(value),
          ),
        };
      case "code_graph.rules": {
        const group = Object.fromEntries(
          item.input.rules.map((rule) => [rule.key, rule.patterns]),
        );
        const compiled = compileGroup(group);
        return {
          ok: true,
          output: item.input.values.map((value) =>
            matchingRules(compiled, value),
          ),
        };
      }
      case "code_graph.partition": {
        const result = louvain(item.input.nodes, item.input.edges);
        return {
          ok: true,
          output: {
            membership: Object.fromEntries(result.membership),
            membershipEntries: [...result.membership],
            modularity: result.modularity,
          },
        };
      }
      case "code_graph.query": {
        const input = item.input;
        const loaded = loadEdgeProject(input.root, "package", input.root);
        const { functions } = discoverFunctions(loaded.sourceFiles);
        const inputs = analysisInputs(functions);
        const context = TypeContext.open({
          rootAbsolute: loaded.rootAbsolute,
          tsConfigPath: loaded.tsConfigPath,
          sourceFiles: loaded.sourceFiles,
          functions,
        });
        let references: ReturnType<typeof resolveReferences>;
        try {
          references = resolveReferences(
            context,
            inputs.names,
            inputs.exportsByFile,
          );
        } finally {
          context.close();
        }
        const graph = assembleGraphWithEdges(
          loaded,
          ThresholdsSchema.parse({}),
          "package",
          loaded.tsConfigPath,
          null,
        );
        for (const [id, kind] of Object.entries(input.nodeKinds)) {
          const node = graph.functions.find((node) => node.id === id);
          assert.ok(node, `unknown function: ${id}`);
          node.nodeKind = nodeKind(kind);
        }
        const patterns = input.exportPatterns.map(
          (source) => new RegExp(source),
        );
        const support = input.testSupport.map((rule) => ({
          key: rule.key,
          patterns: rule.patterns.map((source) => new RegExp(source)),
        }));
        const full = fullAdjacency(graph.functions, references.referencesById);
        return {
          ok: true,
          output: {
            functionCount: graph.functions.length,
            invoked: Object.fromEntries(invokedAdjacency(graph.functions)),
            full: Object.fromEntries(full),
            reachable: [...reachableFrom(full, input.roots)],
            surface: [
              ...publicSurfaceFiles(
                graph.modules,
                input.extraEntryFiles,
                patterns,
              ),
            ],
            unreachable: findUnreachable(
              graph.functions,
              graph.modules,
              references,
              input.extraEntryFiles,
              support,
              patterns,
            ),
            unguarded: findUnguarded(graph.functions),
            width: findInterfaceWidth(
              graph.functions,
              references,
              input.packageDirs,
            ),
            packages: graph.modules.map((node) =>
              packageOf(node.file, input.packageDirs),
            ),
            clusters: buildClusterReport(graph.functions, graph.modules),
            references: {
              referencesById: Object.fromEntries(references.referencesById),
              moduleScopeRoots: references.moduleScopeRoots,
              testModuleScopeRoots: references.testModuleScopeRoots,
              identifierFiles: Object.fromEntries(references.identifierFiles),
            },
          },
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
try {
  config("guards");
  write(
    "guards/entry.ts",
    "export function fetch() { guarded(); open(); }\nexport function rpc() { persist(); }\nexport function scheduled() { persist(); }\nfunction guarded() { persist(); }\nfunction open() { persist(); }\nexport function persist() {}\n",
  );
  const guardKinds = {
    "entry.ts:fetch": { kind: "entry", reach: "public" },
    "entry.ts:rpc": { kind: "entry", reach: "service-binding" },
    "entry.ts:scheduled": { kind: "entry", reach: "platform" },
    "entry.ts:guarded": { kind: "auth" },
    "entry.ts:persist": { kind: "effect" },
  };
  add(
    "unguarded-prefers-public-witness-over-shorter-binding-and-platform-paths",
    "guards",
    {
      nodeKinds: querySchema.shape.nodeKinds.parse(guardKinds),
      roots: ["entry.ts:fetch", "outside", "entry.ts:fetch"],
    },
  );
  add("declared-entry-guard-blocks-public-path", "guards", {
    nodeKinds: querySchema.shape.nodeKinds.parse({
      ...guardKinds,
      "entry.ts:fetch": {
        kind: "entry",
        reach: "public",
        guards: ["authScopes"],
      },
    }),
  });
  add("no-measured-kinds-means-no-unguarded-effects", "guards");
  config("packages");
  for (const name of ["a", "b", "a/nested"])
    write(`packages/packages/${name}/package.json`, JSON.stringify({ name }));
  write("packages/packages/a/index.ts", "export { facade } from './facade';");
  write("packages/packages/a/facade.ts", "export function facade() {}");
  write(
    "packages/packages/a/leaf.ts",
    "export function dead() {}\nexport function testOnly() {}\nexport function callback() {}\nexport function mentioned() {}\n",
  );
  write("packages/packages/a/helpers.ts", "export function testHelper() {}");
  write(
    "packages/packages/a/leaf.test-d.ts",
    "import { testOnly } from './leaf'; testOnly();",
  );
  write(
    "packages/packages/a/nested/run.ts",
    "import { callback } from '../leaf'; export function nested() { return callback(); }",
  );
  write(
    "packages/packages/b/main.ts",
    "import { callback, mentioned } from '../a/leaf'; declare function register(fn: () => void): void; register(callback); export type Name = { mentioned: number };",
  );
  add(
    "dead-test-only-callback-public-surface-and-nested-package-consumers",
    "packages",
    {
      packageDirs: ["", "packages/a", "packages/b", "packages/a/nested"],
      testSupport: [{ key: "helpers", patterns: ["helpers\\.ts$"] }],
    },
  );
  add("explicit-entry-and-export-pattern-follow-reexports", "packages", {
    extraEntryFiles: ["missing.ts", "packages/a/leaf.ts"],
    exportPatterns: ["/helpers\\.ts$"],
    packageDirs: ["packages/a", "packages/b"],
  });
  config("cycles");
  write("cycles/index.ts", "export * from './other'; export * from './types';");
  write(
    "cycles/other.ts",
    "export * from './index'; export function entry() { a(); } function a() { b(); } function b() { a(); persist(); } function persist() {} ",
  );
  write("cycles/types.ts", "export interface Type {} ");
  add("reexport-and-call-cycles-terminate-with-shortest-witness", "cycles", {
    nodeKinds: {
      "other.ts:entry": { kind: "entry", guards: [], reach: "public" },
      "other.ts:persist": { kind: "effect" },
    },
    roots: ["other.ts:entry"],
  });
  config("triangles");
  const triangles: Record<string, string[]> = {
    "left/a": ["left/b", "right/c"],
    "left/b": ["left/a", "right/c"],
    "right/c": ["left/a", "left/b"],
    "right/d": ["right/e", "left/f"],
    "right/e": ["right/d", "left/f"],
    "left/f": ["right/d", "right/e"],
  };
  for (const [file, targets] of Object.entries(triangles)) {
    const name = path.posix.basename(file);
    const imports = targets
      .map(
        (target) =>
          `import { ${path.posix.basename(target)} } from '${path.posix.relative(path.posix.dirname(file), target).replace(/^(?!\.)/, "./")}';`,
      )
      .join("\n");
    write(
      `triangles/${file}.ts`,
      `${imports}\nexport function ${name}() { ${targets.map((target) => `${path.posix.basename(target)}();`).join(" ")} }`,
    );
  }
  write("triangles/left/isolated.ts", "export function lonely() {}");
  write(
    "triangles/left/a.test-d.ts",
    "import { a } from './a'; export function test() { a(); }",
  );
  add(
    "weighted-call-and-import-triangles-isolates-and-type-test-exclusion",
    "triangles",
  );
  config("unicode");
  write(
    "unicode/Ω.ts",
    "export function Ω() {} export function z() {} export function a() { Ω(); z(); } export function Z() {} ",
  );
  write(
    "unicode/é.ts",
    "import { a as call } from './Ω'; export const lazy = () => import('./Ω'); call();",
  );
  add(
    "unicode-locale-order-dynamic-import-and-external-identifier-roots",
    "unicode",
    { roots: ["Ω.ts:a"], packageDirs: ["", "é.ts"] },
  );
  config("empty");
  add("empty-project-has-measured-zero-reports", "empty");
  config("malformed-source");
  write("malformed-source/bad.ts", "export function broken( {");
  add("malformed-source-keeps-queries-observable-as-empty", "malformed-source");
  add("missing-config-is-a-visible-failure", "missing");
  cases.push(
    caseSchema.parse({
      id: "existing-type-tests-query-reports",
      operation: "code_graph.query",
      input: { root: path.join(repo, "packages/code-graph/test/type-tests") },
    }),
  );
  cases.push(
    caseSchema.parse({
      id: "existing-code-graph-source-query-reports",
      operation: "code_graph.query",
      input: { root: path.join(repo, "packages/code-graph/src") },
    }),
  );
  const weighted = {
    nodes: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
    edges: [
      { a: "a.ts", b: "b.ts", weight: 3 },
      { a: "b.ts", b: "c.ts", weight: 3 },
      { a: "a.ts", b: "c.ts", weight: 3 },
      { a: "c.ts", b: "d.ts", weight: 1 },
      { a: "d.ts", b: "e.ts", weight: 3 },
      { a: "e.ts", b: "f.ts", weight: 3 },
      { a: "d.ts", b: "f.ts", weight: 3 },
    ],
  };
  cases.push(
    {
      id: "weighted-barbell-partition",
      operation: "code_graph.partition",
      input: weighted,
    },
    {
      id: "reversed-barbell-partition",
      operation: "code_graph.partition",
      input: {
        nodes: [...weighted.nodes].reverse(),
        edges: [...weighted.edges].reverse(),
      },
    },
    {
      id: "isolates-self-and-unknown-endpoint-partition",
      operation: "code_graph.partition",
      input: {
        nodes: ["z", "x", "y"],
        edges: [
          { a: "x", b: "y", weight: 2 },
          { a: "x", b: "x", weight: 100 },
          { a: "unknown", b: "z", weight: 99 },
        ],
      },
    },
  );
  for (const [index, source] of [
    "(?<=pre)(a)\\1(?=post)",
    "^.$",
    "^..$",
    "😀",
    "\ud83d",
    "(?<name>a)\\k<name>",
    "[a-\\s]",
    "(?=a)?a",
    "\\8",
    "\\p{L}",
    "[\\ud800-\\udfff]",
    "a$",
    "(?<!x)y",
    "(?<=(a+)b)\\1",
    "[",
    "(?<x>a)(?<x>b)",
  ].entries())
    cases.push({
      id: `ecmascript-pattern-${index}`,
      operation: "code_graph.pattern",
      input: {
        source,
        values: [
          "preaapost",
          "😀",
          "aa",
          "a",
          "a\n",
          "xya",
          "p{L}",
          "8",
          "y",
          "aabaa",
          "\ud800",
          "\udfff",
        ],
      },
    });
  cases.push({
    id: "compiled-rule-key-order-and-lossless-surrogate-labels",
    operation: "code_graph.rules",
    input: {
      rules: [
        { key: "Z", patterns: ["^a"] },
        { key: "é", patterns: ["a$"] },
        { key: "a", patterns: ["a"] },
        { key: "\ud800", patterns: ["^..$"] },
      ],
      values: ["a", "a\n", "😀", "no"],
    },
  });
  const expected = cases.map((item) => {
    if (process.env.DEMLIK_QUERY_TRACE) console.error(`reference: ${item.id}`);
    return reference(item);
  });
  const queryResult = z.object({
    functionCount: z.number(),
    unguarded: z.array(
      z.object({
        effectId: z.string(),
        entryId: z.string(),
        path: z.array(z.string()),
        reach: z.string(),
      }),
    ),
    clusters: z.object({
      modularity: z.number(),
      clusterCount: z.number(),
      isolatedFileCount: z.number(),
      excludedTestFileCount: z.number(),
    }),
  });
  const witness = queryResult.parse(expected[0].output);
  assert.deepEqual(
    witness.unguarded,
    [
      {
        effectId: "entry.ts:persist",
        file: "entry.ts",
        startLine: 6,
        entryId: "entry.ts:fetch",
        path: ["entry.ts:fetch", "entry.ts:open", "entry.ts:persist"],
        reach: "public",
      },
    ].map(({ file: _file, startLine: _line, ...rest }) => rest),
  );
  assert.equal(
    queryResult.parse(expected[1].output).unguarded[0].reach,
    "service-binding",
  );
  const clustered = queryResult.parse(expected[6].output).clusters;
  assert.equal(clustered.modularity, 0.5);
  assert.equal(clustered.clusterCount, 2);
  assert.equal(clustered.isolatedFileCount, 1);
  assert.equal(clustered.excludedTestFileCount, 1);
  const invalid = [
    "not json",
    JSON.stringify({
      id: "missing-root",
      operation: "code_graph.query",
      input: {},
    }),
    JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
    JSON.stringify({
      id: "bad-roots",
      operation: "code_graph.query",
      input: { root, roots: "x" },
    }),
    JSON.stringify({
      id: "unknown-option",
      operation: "code_graph.query",
      input: { root, ignored: true },
    }),
    JSON.stringify({
      id: "bad-partition-weight",
      operation: "code_graph.partition",
      input: { nodes: ["a"], edges: [{ a: "a", b: "a", weight: "1" }] },
    }),
    JSON.stringify({
      id: "bad-pattern-value",
      operation: "code_graph.pattern",
      input: { source: "a", values: [1] },
    }),
  ];
  if (process.env.DEMLIK_QUERY_TRACE) console.error("native: shared trace");
  const native = spawnSync(binary, [manifest], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stderr, "");
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => resultSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, answer] of expected.entries()) {
    assert.equal(
      actual[index].ok,
      answer.ok,
      `${cases[index].id}: ${JSON.stringify(actual[index].error)} / ${answer.message}`,
    );
    if (answer.ok) {
      assert.deepEqual(actual[index].output, answer.output, cases[index].id);
      assert.ok(actual[index].observedCalls.length > 0, cases[index].id);
    } else assert.ok(actual[index].error?.message);
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.ok(answer.error?.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "0.151.0",
      resolver: "11.24.2",
      compiler: compiler.version,
      protocol: 5,
      regex: "regress 0.12.0 unflagged UCS2",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: expected.reduce(
      (count, answer, index) =>
        count +
        (answer.ok && cases[index].operation === "code_graph.query"
          ? queryResult.parse(answer.output).functionCount
          : 0),
      0,
    ),
    nativeApis: [
      ...new Set(actual.flatMap((answer) => answer.observedCalls)),
    ].sort(),
    cases: actual,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
