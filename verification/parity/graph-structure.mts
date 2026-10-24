import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { discoverDeclarations } from "../../packages/code-graph/src/declarations/discover.js";
import { assembleGraph } from "../../packages/code-graph/src/extract/assemble.js";
import { loadCheapProject } from "../../packages/code-graph/src/extract/project.js";
import {
  GraphSchema,
  ThresholdsSchema,
} from "../../packages/code-graph/src/schema.js";
import {
  importDeclarationSpecifiers,
  importedNamesOf,
  importLiterals,
  resolveImports,
  runtimeSpecifiers,
} from "../../packages/code-graph/src/syntax/imports.js";

const inputSchema = z.object({
  root: z.string(),
  headers: z.boolean().optional(),
  thresholds: ThresholdsSchema.optional(),
  tsConfig: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.structure"; input: Input };
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
  "usage: pnpm --filter @demlik/code-graph exec node --import tsx ../../verification/parity/graph-structure.mts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-structure-parity-")),
);
const cases: Case[] = [];
function write(relative: string, source: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}
function add(
  id: string,
  directory: string,
  options: Omit<Input, "root"> = {},
): void {
  cases.push({
    id,
    operation: "code_graph.structure",
    input: inputSchema.parse({ root: path.join(root, directory), ...options }),
  });
}
function reference(item: Case): unknown {
  const loaded = loadCheapProject(item.input.root);
  const graph = assembleGraph(
    loaded,
    item.input.thresholds ?? ThresholdsSchema.parse({}),
    null,
    { headers: item.input.headers ?? false },
  );
  const resolved =
    item.input.tsConfig === undefined
      ? null
      : resolveImports(
          item.input.root,
          loaded.sourceFiles,
          item.input.tsConfig,
        );
  return {
    graph,
    imports: loaded.sourceFiles.map(({ file, syntax }) => ({
      file,
      literals: importLiterals(syntax).map(({ imported, ...literal }) => ({
        ...literal,
        imported: {
          names: [...imported.names],
          unreadable: imported.unreadable,
        },
      })),
      runtimeSpecifiers: [...runtimeSpecifiers(syntax)],
      importedNames: [...importedNamesOf(syntax)].map(([specifier, names]) => [
        specifier,
        { names: [...names.names], unreadable: names.unreadable },
      ]),
      declarationSpecifiers: importDeclarationSpecifiers(syntax),
    })),
    resolvedImports:
      resolved === null
        ? null
        : {
            importsByFile: Object.fromEntries(resolved.importsByFile),
            importedByFile: Object.fromEntries(resolved.importedByFile),
            importEdgesByFile: Object.fromEntries(resolved.importEdgesByFile),
          },
    declarations: discoverDeclarations(loaded.sourceFiles),
  };
}

try {
  write(
    "cheap/a.ts",
    "import { value } from './values';\nexport function run(x: number) {\n  if (x) { return value; }\n  return 0;\n}\n",
  );
  write(
    "cheap/values.ts",
    "export const value = 1;\nexport interface Shape { value: number }\n",
  );
  write("cheap/bad.ts", "export function broken( {");
  add("default-cheap-graph", "cheap");
  add("headers-and-low-threshold-smells", "cheap", {
    headers: true,
    thresholds: ThresholdsSchema.parse({
      longFunctionLoc: 2,
      deepNesting: 0,
      highComplexity: 1,
      bigFileLoc: 3,
      directorySprawl: 1,
    }),
  });
  write(
    "declarations/definitions.test.ts",
    [
      "export interface Merged { left: number }",
      "export interface Merged { right: string }",
      "type Local = number;",
      "const left = 1,",
      "  right = 2, arrow = () => 1, expression = function named() {};",
      "export { left };",
      "export default class {}",
      "export enum Choice { A, B }",
      "namespace Nested { export interface Ignored {} }",
      "function body() { type Ignored = string; return 1; }",
      "export const wrapped = (() => 1);",
      "",
    ].join("\n"),
  );
  add(
    "merged-declarations-ordinals-constants-and-source-lines",
    "declarations",
    { headers: true },
  );
  write(
    "imports/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@app/*": ["src/*"] },
        module: "esnext",
        moduleResolution: "bundler",
      },
    }),
  );
  write(
    "imports/src/entry.ts",
    [
      "import { type A, type B as C } from './types';",
      "import value, { named as local } from '@app/value.js';",
      "import type Old = require('./types');",
      "export { type A } from './types';",
      "export * from './value';",
      "export type * from './types';",
      "import './script'; import './meta'; import './missing'; import 'node:fs';",
      "import { External } from 'typed-package';",
      "const lazy = () => import(`./value`); type Imported = import('./types').A;",
      "import '';",
      "",
    ].join("\n"),
  );
  write(
    "imports/src/types.ts",
    "export interface A {} export interface B {}\n",
  );
  write(
    "imports/src/value.ts",
    "export const named = 1; export default named;\n",
  );
  write("imports/src/script.ts", "const globalValue = 1;\n");
  write("imports/src/meta.ts", "const url = import.meta.url;\n");
  write("imports/src/ignored.d.ts", "export declare const ignored: number;\n");
  write(
    "imports/node_modules/typed-package/package.json",
    JSON.stringify({
      name: "typed-package",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    }),
  );
  write(
    "imports/node_modules/typed-package/index.d.ts",
    "export interface External {}\n",
  );
  write(
    "imports/node_modules/typed-package/index.js",
    "export const External = 1;\n",
  );
  add(
    "aliases-exports-dynamic-imports-and-script-module-distinction",
    "imports",
    { tsConfig: path.join(root, "imports/tsconfig.json") },
  );
  write("ambient/tsconfig.json", "{}");
  write(
    "ambient/types.ts",
    [
      "declare module 'ambient' {",
      "  import './relative'; import { Remote } from 'remote';",
      "  export { type Remote } from 'remote';",
      "  declare module 'nested' { import * as Another from 'another'; }",
      "  type Shape = import('shape').Shape;",
      "}",
      "namespace NotAmbient { import { Missing } from 'not-recorded'; }",
      "",
    ].join("\n"),
  );
  add("ambient-erased-imports-and-recorded-type-imports", "ambient", {
    tsConfig: path.join(root, "ambient/tsconfig.json"),
  });
  write("strings/tsconfig.json", "{}");
  write(
    "strings/entry.ts",
    "import './\\ud800'; import './\\udc00'; import './�'; import { '\\ud800' as named } from './origin'; export { named };\n",
  );
  write("strings/�.ts", "export const replacement = 1;\n");
  write(
    "strings/origin.ts",
    "const value = 1; export { value as '\\ud800' };\n",
  );
  add("lossless-surrogate-imports-and-native-path-encoding", "strings", {
    tsConfig: path.join(root, "strings/tsconfig.json"),
  });
  fs.mkdirSync(path.join(root, "empty"));
  add("empty-cheap-graph", "empty");
  add("missing-cheap-project", "missing");
  write("malformed-config/tsconfig.json", '{ "compilerOptions": ');
  write(
    "malformed-config/entry.ts",
    "import './value'; export const marker = 1;",
  );
  write("malformed-config/value.ts", "export const value = 1;");
  add("malformed-resolver-config-facade", "malformed-config", {
    tsConfig: path.join(root, "malformed-config/tsconfig.json"),
  });
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  cases.push({
    id: "existing-parity-fixture-cheap-graph",
    operation: "code_graph.structure",
    input: {
      root: path.join(repo, "packages/code-graph/test/parity/fixture"),
      headers: true,
      tsConfig: path.join(
        repo,
        "packages/code-graph/test/parity/fixture/apps/core/tsconfig.json",
      ),
    },
  });
  cases.push({
    id: "existing-code-graph-source-cheap-graph",
    operation: "code_graph.structure",
    input: {
      root: path.join(repo, "packages/code-graph/src"),
      headers: true,
      tsConfig: path.join(repo, "packages/code-graph/tsconfig.json"),
    },
  });
  add("maximum-safe-integer-threshold", "cheap", {
    thresholds: ThresholdsSchema.parse({
      deepNesting: Number.MAX_SAFE_INTEGER,
    }),
  });

  const expected = cases.map(reference);
  const outputSchema = z.object({ graph: GraphSchema });
  const cheap = outputSchema.parse(expected[0]).graph;
  assert.equal(cheap.stats.fileCount, 2);
  assert.equal(cheap.stats.functionCount, 1);
  assert.equal(cheap.stats.totalLoc, 9);
  assert.deepEqual(cheap.stats.parseFailures, ["bad.ts"]);
  assert.equal(cheap.declarations.length, 2);
  assert.equal(cheap.functions[0].edges, null);
  assert.ok(cheap.declarations.every((node) => node.uses === null));
  const flagged = outputSchema.parse(expected[1]).graph;
  assert.equal(flagged.smells.length, 6);
  assert.equal(flagged.summary.highSeverityCount, 6);
  assert.equal(flagged.summary.health, "rotten");
  for (const deepNesting of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(ThresholdsSchema.safeParse({ deepNesting }).success, false);
  const invalid = [
    "not json",
    '{"id":"missing","operation":"code_graph.structure","input":{}}',
    JSON.stringify({
      id: "unsupported",
      operation: "invented",
      input: { root },
    }),
    JSON.stringify({
      id: "negative-threshold",
      operation: "code_graph.structure",
      input: { root, thresholds: { deepNesting: -1 } },
    }),
    JSON.stringify({
      id: "unknown-threshold",
      operation: "code_graph.structure",
      input: { root, thresholds: { invented: 1 } },
    }),
    JSON.stringify({
      id: "invalid-headers",
      operation: "code_graph.structure",
      input: { root, headers: "yes" },
    }),
    JSON.stringify({
      id: "oversized-threshold",
      operation: "code_graph.structure",
      input: { root, thresholds: { deepNesting: Number.MAX_SAFE_INTEGER + 1 } },
    }),
    JSON.stringify({
      id: "fractional-threshold",
      operation: "code_graph.structure",
      input: { root, thresholds: { deepNesting: 1.5 } },
    }),
  ];
  const native = spawnSync(binary, [], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => resultSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, output] of expected.entries()) {
    assert.equal(
      actual[index].ok,
      true,
      `${cases[index].id}: ${JSON.stringify(actual[index].error)}`,
    );
    assert.deepEqual(actual[index].output, output, cases[index].id);
    assert.ok(
      actual[index].observedCalls.includes(
        "demlik_code_graph::extract::assemble::assemble_graph",
      ),
    );
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
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: expected.reduce<number>(
      (count, output) =>
        count + outputSchema.parse(output).graph.functions.length,
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
