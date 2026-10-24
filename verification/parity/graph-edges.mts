import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { TypeContext } from "../../packages/code-graph/src/checker/context.js";
import { discoverDeclarations } from "../../packages/code-graph/src/declarations/discover.js";
import { resolveDeclarationUses } from "../../packages/code-graph/src/declarations/uses.js";
import * as ts from "../../packages/code-graph/src/engine/tsgo.js";
import { analysisInputs } from "../../packages/code-graph/src/extract/analysis.js";
import { assembleGraphWithEdges } from "../../packages/code-graph/src/extract/assemble.js";
import { resolveEdges } from "../../packages/code-graph/src/extract/edges.js";
import { discoverFunctions } from "../../packages/code-graph/src/extract/functions.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import { resolveReferences } from "../../packages/code-graph/src/extract/references.js";
import {
  GraphSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";
import { resolveImports } from "../../packages/code-graph/src/syntax/imports.js";

const inputSchema = z.object({
  root: z.string(),
  repoRoot: z.string().optional(),
  scope: z.enum(["package", "deep"]).optional(),
  headers: z.boolean().optional(),
  thresholds: ThresholdsSchema.optional(),
});
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.edges"; input: Input };
const resultSchema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
type Result = z.infer<typeof resultSchema>;
const binary = process.argv[2];
assert.ok(
  binary,
  "usage: pnpm --filter @demlik/code-graph exec node --import tsx ../../verification/parity/graph-edges.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const manifest = createRequire(
  new URL("../../packages/code-graph/package.json", import.meta.url),
).resolve("@typescript/native-preview/package.json");
const compiler = await ts.tsgoBinary();
assert.equal(compiler.version, "7.0.0-dev.20260707.2");
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-edges-parity-")),
);
const cases: Case[] = [];
function write(relative: string, source: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}
function config(directory: string, extra = {}): void {
  write(
    `${directory}/tsconfig.json`,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        types: [],
        ...extra,
      },
      include: ["**/*.ts", "**/*.tsx"],
    }),
  );
}
function add(
  id: string,
  directory: string,
  options: Omit<Input, "root"> = {},
): void {
  cases.push({
    id,
    operation: "code_graph.edges",
    input: inputSchema.parse({ root: path.join(root, directory), ...options }),
  });
}
function reference(item: Case): Result {
  try {
    const input = item.input;
    const loaded = loadEdgeProject(
      input.root,
      input.scope ?? "package",
      input.repoRoot ?? input.root,
    );
    const { functions } = discoverFunctions(loaded.sourceFiles);
    const declarations = discoverDeclarations(loaded.sourceFiles);
    const imports = resolveImports(
      loaded.rootAbsolute,
      loaded.sourceFiles,
      loaded.tsConfigPath,
    );
    const context = TypeContext.open({
      rootAbsolute: loaded.rootAbsolute,
      tsConfigPath: loaded.tsConfigPath,
      sourceFiles: loaded.sourceFiles,
      functions,
    });
    let details: unknown;
    try {
      const edges = resolveEdges(
        context,
        imports,
        functions.map((fn) => fn.id),
      );
      const uses = resolveDeclarationUses(context, declarations);
      const inputs = analysisInputs(functions);
      const references = resolveReferences(
        context,
        inputs.names,
        inputs.exportsByFile,
      );
      details = {
        context: {
          files: context.files.map((file) => file.unit.file),
          joined: [...context.nodeToId].map(([node, id]) => ({
            id,
            file: context.relativePath(node.getSourceFile()),
            kind: ts.SyntaxKind[node.kind],
            start: node.getStart(node.getSourceFile()),
            line: context.startLine(node),
          })),
          unjoined: context.unjoined,
        },
        edges: {
          callsById: Object.fromEntries(edges.callsById),
          calledById: Object.fromEntries(edges.calledById),
          chainDepthById: Object.fromEntries(edges.chainDepthById),
          importsByFile: Object.fromEntries(edges.importsByFile),
          importedByFile: Object.fromEntries(edges.importedByFile),
          importEdgesByFile: Object.fromEntries(edges.importEdgesByFile),
        },
        uses: {
          usesById: Object.fromEntries(uses.usesById),
          unjoined: uses.unjoined,
        },
        references: {
          referencesById: Object.fromEntries(references.referencesById),
          moduleScopeRoots: references.moduleScopeRoots,
          testModuleScopeRoots: references.testModuleScopeRoots,
          identifierFiles: Object.fromEntries(references.identifierFiles),
        },
      };
    } finally {
      context.close();
    }
    const graph = assembleGraphWithEdges(
      loaded,
      input.thresholds ?? ThresholdsSchema.parse({}),
      loaded.scope,
      loaded.tsConfigPath,
      null,
      null,
      { headers: input.headers ?? false },
    );
    return {
      id: item.id,
      ok: true,
      output: { graph, details },
      observedCalls: [],
    };
  } catch (error) {
    return {
      id: item.id,
      ok: false,
      error: {
        kind: "driver_error",
        message: error instanceof Error ? error.message : String(error),
      },
      observedCalls: [],
    };
  }
}
function same(actual: unknown, expected: unknown, location: string): void {
  if (Object.is(actual, expected)) return;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${location}: actual is not an array`);
    assert.ok(Array.isArray(expected), `${location}: expected is not an array`);
    assert.equal(actual.length, expected.length, `${location}.length`);
    for (let index = 0; index < actual.length; index++)
      same(actual[index], expected[index], `${location}[${index}]`);
    return;
  }
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === "object" &&
    typeof expected === "object"
  ) {
    const a = Object.keys(actual);
    const b = Object.keys(expected);
    const ordered = [
      "callsById",
      "calledById",
      "chainDepthById",
      "importsByFile",
      "importedByFile",
      "importEdgesByFile",
      "usesById",
      "referencesById",
      "identifierFiles",
    ].some((key) => location.endsWith(`.${key}`));
    assert.deepEqual(
      ordered ? a : [...a].sort(),
      ordered ? b : [...b].sort(),
      `${location}.keys`,
    );
    for (const key of b)
      same(
        Reflect.get(actual, key),
        Reflect.get(expected, key),
        `${location}.${key}`,
      );
    return;
  }
  assert.deepEqual(actual, expected, location);
}

try {
  config("factory");
  write(
    "factory/origin.ts",
    "export const TOKEN = 'fixed';\nexport function target(value: string) { return value; }\nexport function recursion(n: number): string { if (n) return recursion(n - 1); return target(TOKEN); }\n",
  );
  write(
    "factory/entry.ts",
    "import { target as renamed, TOKEN, recursion } from './origin';\nfunction factory(config: { handle: () => number }) { return () => config.handle(); }\nconst wrapped = factory({ handle() { return 1; } });\nexport function run() { renamed(TOKEN); renamed(TOKEN); wrapped(); recursion(1); }\n",
  );
  add("aliases-factory-const-args-recursive-depth", "factory", {
    headers: true,
    thresholds: ThresholdsSchema.parse({ highFanIn: 0, deepCallChain: 1 }),
  });
  config("uses");
  write(
    "uses/types.ts",
    "export interface Shape { value: number }\nexport const TOKEN = 'fixed';\nexport class Box { method() { return 1; } }\nexport function target() { return 1; }\n",
  );
  write(
    "uses/entry.ts",
    "import { Shape as Alias, TOKEN, Box, target } from './types';\nconst holder = { TOKEN };\nexport function run(value: Alias) { target(); consume(target); return TOKEN; }\ntarget;\nconst lazy = import('./types');\nfunction consume(callback: () => number) { return callback(); }\n",
  );
  write("uses/entry.test.ts", "import { target } from './types';\ntarget;\n");
  add("alias-type-shorthand-callback-and-module-test-roots", "uses");
  config("constants");
  write(
    "constants/values.ts",
    "export const A = 1, B = 2, NEG = -1, AS = 1 as const, BOOL = true, TXT = 'text', TEMPLATE = `text`, OBJECT = {}, BIG = 1n, NIL = null;\nexport function target(...values: unknown[]) { return values; }\n",
  );
  write(
    "constants/entry.ts",
    "import type { A } from './values';\nimport { target, NEG, AS, BOOL, TXT, TEMPLATE, OBJECT, BIG, NIL, type B, A as RENAMED } from './values';\nexport function run(NEG: unknown) { return target(A, B, NEG, AS, BOOL, TXT, TEMPLATE, OBJECT, BIG, NIL, RENAMED, { TXT, key: BOOL }, [AS], target); }\n",
  );
  add("runtime-vs-type-bindings-and-literal-value-positions", "constants");
  config("external", { lib: ["es2022", "dom"] });
  write(
    "external/node_modules/library/package.json",
    JSON.stringify({ name: "library", types: "index.d.ts" }),
  );
  write(
    "external/node_modules/library/index.d.ts",
    "export declare function external(): number; export interface API { run(): number } export declare const api: API;\n",
  );
  write(
    "external/entry.ts",
    "import { external, api } from 'library';\nexport function run(values: string[]) { console.log(values.map(value => value.trim()).join(',')); api.run(); return external(); }\n",
  );
  add("default-library-and-package-declaration-origins", "external");
  config("deep");
  write("deep/shared/service.ts", "export function operate() { return 1; }\n");
  write(
    "deep/app/entry.ts",
    "import { operate } from '../shared/service';\nexport function run() { return operate(); }\n",
  );
  add("workspace-callee-outside-loaded-scope", "deep/app", {
    scope: "deep",
    repoRoot: path.join(root, "deep"),
  });
  config("overloads");
  write(
    "overloads/origin.ts",
    "export function choose(value: string): string;\nexport function choose(value: number): number;\nexport function choose(value: string | number) { return value; }\nexport default class Box { constructor(value: string); constructor(value: string | number) {} method(value: string): string; method(value: string) { return value; } }\nexport interface Merged { left: number }\nexport interface Merged { right: string }\nexport function __internal() { return 1; }\n",
  );
  write("overloads/anonymous.ts", "export default () => 1;\n");
  write(
    "overloads/entry.ts",
    "import Box, { choose as picked, __internal, Merged } from './origin'; import anonymous from './anonymous';\nexport function run(value: Merged) { picked(1); new Box('x').method('x'); __internal(); return anonymous(); }\n",
  );
  add("overloaded-default-merged-and-underscore-symbols", "overloads", {
    headers: true,
  });
  config("tsx", { experimentalDecorators: true });
  write(
    "tsx/view.tsx",
    "// 😀 Ω\r\nfunction target() { return 1; }\r\nconst view = () => (<button onClick={() => target()}>{target()}</button>);\r\nclass Box { #helper() { return target(); } run() { return this.#helper(); } [Symbol.iterator]() { return target(); } }\r\ninterface Size { get size(): number; }\r\nexport { view };\r\n",
  );
  write("tsx/bom.ts", "\uFEFFexport function bom() { return 1; }\n");
  add("tsx-private-computed-bodyless-accessors-and-utf16-bom", "tsx", {
    headers: true,
  });
  config("surrogate");
  write(
    "surrogate/entry.ts",
    "declare const effect: Record<string, () => void>;\nexport function run() { effect['\\ud800'](); effect['ordinary'](); }\n",
  );
  add("lossless-external-string-literal-callees", "surrogate");
  config("escaped");
  write(
    "escaped/defs.ts",
    "export interface \\u0055 { value: number }\nexport const \\u0056 = 1;\nexport function \\u0066() { return 1; }\n",
  );
  write(
    "escaped/entry.ts",
    "import { U, V, f } from './defs';\nexport function run(value: U) { f(); return V; }\n",
  );
  add("observable-unjoined-escaped-declaration-names", "escaped");
  config("bad-source");
  write("bad-source/bad.ts", "export function broken( {\n");
  write("bad-source/entry.ts", "export function run() { return 1; }\n");
  add("malformed-source-retains-parse-failure-data", "bad-source");
  write("bad-config/tsconfig.json", '{ "compilerOptions": ');
  write("bad-config/entry.ts", "export function run() { return 1; }\n");
  add("malformed-config-native-program-behavior", "bad-config");
  config("empty");
  add("empty-edge-project", "empty");
  fs.mkdirSync(path.join(root, "no-config"));
  add("missing-config-errors", "no-config");
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  cases.push({
    id: "existing-core-parity-fixture",
    operation: "code_graph.edges",
    input: {
      root: path.join(
        repo,
        "packages/code-graph/test/parity/fixture/apps/core",
      ),
      headers: true,
    },
  });
  cases.push({
    id: "existing-code-graph-source-consumer",
    operation: "code_graph.edges",
    input: { root: path.join(repo, "packages/code-graph/src"), headers: true },
  });

  let referenceWarnings = "";
  const stderrWrite = Object.getOwnPropertyDescriptor(process.stderr, "write");
  Object.defineProperty(process.stderr, "write", {
    configurable: true,
    value: (chunk: string | Uint8Array) => {
      referenceWarnings +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  });
  let expected: Result[];
  try {
    expected = cases.map(reference);
  } finally {
    if (stderrWrite)
      Object.defineProperty(process.stderr, "write", stderrWrite);
    else Reflect.deleteProperty(process.stderr, "write");
  }
  const outputSchema = z.object({ graph: GraphSchema });
  const first = outputSchema.parse(expected[0].output).graph;
  const run = first.functions.find((fn) => fn.id === "entry.ts:run");
  assert.deepEqual(
    run?.edges?.calls.map((site) => site.calleeId),
    ["entry.ts:handle", "origin.ts:recursion", "origin.ts:target"],
  );
  assert.equal(run?.edges?.callChainDepth, 3);
  assert.deepEqual(run?.edges?.calls[2].constArgs, ["TOKEN"]);
  assert.equal(
    outputSchema.parse(expected[9].output).graph.stats.parseFailures[0],
    "bad.ts",
  );
  const invalid = [
    "not json",
    '{"id":"missing","operation":"code_graph.edges","input":{}}',
    JSON.stringify({
      id: "unsupported",
      operation: "invented",
      input: { root },
    }),
    JSON.stringify({
      id: "invalid-scope",
      operation: "code_graph.edges",
      input: { root, scope: "invented" },
    }),
    JSON.stringify({
      id: "fractional-threshold",
      operation: "code_graph.edges",
      input: { root, thresholds: { highFanIn: 1.5 } },
    }),
  ];
  const native = spawnSync(binary, [manifest], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(
    native.stderr,
    referenceWarnings,
    "native warning output matches the source's observable unjoined failures",
  );
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => resultSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  try {
    for (const [index, answer] of expected.entries()) {
      const { observedCalls: _expectedCalls, ...e } = answer;
      const { observedCalls: _actualCalls, ...a } = actual[index];
      same(a, e, cases[index].id);
      assert.ok(
        actual[index].observedCalls.includes(
          "demlik_code_graph::project::load_edge_project",
        ),
      );
    }
  } catch (error) {
    if (process.argv[3])
      fs.writeFileSync(
        `${process.argv[3]}.debug.json`,
        `${JSON.stringify({ verified: false, expected, actual }, null, 2)}\n`,
      );
    throw error;
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
      nativeCompiler: compiler,
      parser: "0.151.0",
      resolver: "11.24.2",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: expected.reduce<number>(
      (count, answer) =>
        count +
        (answer.ok
          ? outputSchema.parse(answer.output).graph.functions.length
          : 0),
      0,
    ),
    warnings: referenceWarnings.split("\n").filter(Boolean),
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
