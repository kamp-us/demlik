import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { tsgoBinary } from "../../src/engine/tsgo.js";
import { loadInProcessGraph } from "../../src/resolve.js";

const stepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("origin"),
    fromFile: z.string(),
    specifier: z.string(),
    name: z.string(),
  }),
  z.object({ kind: z.literal("module"), file: z.string(), name: z.string() }),
  z.object({
    kind: z.literal("publishing"),
    entries: z.record(z.string(), z.string()),
    name: z.string(),
  }),
  z.object({ kind: z.literal("dispose") }),
]);
const inputSchema = z.object({
  root: z.string(),
  repoRoot: z.string().optional(),
  scope: z.enum(["package", "deep"]).optional(),
  steps: z.array(stepSchema),
});
type Input = z.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.semantic"; input: Input };
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
  "usage: pnpm exec node --import tsx test/rust/semantic-resolution.ts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const compiler = await tsgoBinary();
assert.equal(compiler.version, "7.0.0-dev.20260707.2");
const manifest = createRequire(import.meta.url).resolve("@typescript/native-preview/package.json");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demlik-semantic-parity-")));
const cases: Case[] = [];
const config = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
    target: "es2022",
    types: [],
  },
  include: ["**/*.ts"],
});

function write(relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function add(id: string, input: Input): void {
  cases.push({ id, operation: "code_graph.semantic", input: inputSchema.parse(input) });
}

function reference(item: Case): Result {
  const input = inputSchema.parse(item.input);
  const graph = loadInProcessGraph(input.root, { scope: input.scope, repoRoot: input.repoRoot });
  if (graph === null)
    return { id: item.id, ok: true, output: { loaded: false, answers: [] }, observedCalls: [] };
  try {
    const answers = input.steps.map((step) => {
      try {
        let answer: unknown;
        switch (step.kind) {
          case "origin":
            answer = graph.resolveExportOrigin(step.fromFile, step.specifier, step.name);
            break;
          case "module":
            answer = graph.resolveModuleExport(step.file, step.name);
            break;
          case "publishing":
            answer = graph.resolvePublishingSubpaths(step.entries, step.name);
            break;
          case "dispose":
            graph.dispose();
            answer = null;
            break;
        }
        return { ok: true, answer };
      } catch (error) {
        return { ok: false, error: { kind: "query_error", message: (error as Error).message } };
      }
    });
    return { id: item.id, ok: true, output: { loaded: true, answers }, observedCalls: [] };
  } finally {
    graph.dispose();
  }
}

try {
  write("barrel/tsconfig.json", config);
  const origin = write(
    "barrel/origin.ts",
    "/** Original declaration */\nexport function realName(): number { return 1; }\nexport default () => 2;\n",
  );
  const barrel = write(
    "barrel/barrel.ts",
    "export { realName as renamed } from './origin';\nexport { default } from './origin';\n",
  );
  const consumer = write(
    "barrel/consumer.ts",
    "import { renamed } from './barrel';\nexport const value = renamed();\n",
  );
  const global = write("barrel/global.ts", "declare const globalOnly: number;\n");
  const absent = path.join(root, "barrel/absent.ts");
  add("barrel-origins", {
    root: path.dirname(origin),
    steps: [
      { kind: "origin", fromFile: consumer, specifier: "./barrel", name: "renamed" },
      { kind: "origin", fromFile: consumer, specifier: "./barrel", name: "default" },
      { kind: "module", file: barrel, name: "renamed" },
      { kind: "origin", fromFile: barrel, specifier: "./origin", name: "realName" },
      { kind: "origin", fromFile: consumer, specifier: "./missing", name: "renamed" },
      { kind: "origin", fromFile: consumer, specifier: "./barrel", name: "absent" },
      { kind: "module", file: global, name: "globalOnly" },
      { kind: "module", file: absent, name: "missing" },
      {
        kind: "publishing",
        entries: { "./barrel": barrel, "./unpublished": global, "./missing": absent, ".": origin },
        name: "realName",
      },
    ],
  });

  write("declarations/tsconfig.json", config);
  const declarations = write(
    "declarations/definitions.ts",
    [
      "// 😀 Ω before declarations",
      "/** API documentation",
      " * for both overloads",
      " */",
      "export function run(value: string): string;",
      "export function run(value: number): number;",
      "export function run(value: string | number): string | number { return value; }",
      "export interface Merged { value: number }",
      "export namespace Merged { export const marker = 1; }",
      "export const { external: bound } = { external: 1 };",
      "export const __internal = 1;",
      "export default class Named {}",
      "export const π = 3;",
      "export { π as 'unicode-alias' };",
    ].join("\r\n"),
  );
  const anonymous = write(
    "declarations/anonymous.ts",
    "\uFEFF/** description */\nexport default () => 2;\n",
  );
  const declarationConsumer = write(
    "declarations/consumer.ts",
    "import { run } from './definitions';\nexport const result = run('x');\n",
  );
  add("declaration-names-lines", {
    root: path.dirname(declarations),
    steps: [
      ...["run", "Merged", "bound", "__internal", "default", "π", "unicode-alias"].map((name) => ({
        kind: "module" as const,
        file: declarations,
        name,
      })),
      { kind: "module", file: anonymous, name: "default" },
      {
        kind: "origin",
        fromFile: declarationConsumer,
        specifier: "./definitions",
        name: "default",
      },
    ],
  });

  write(
    "aliases/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "esnext",
        moduleResolution: "bundler",
        baseUrl: ".",
        paths: { "@app/*": ["src/*"] },
        types: [],
      },
    }),
  );
  const aliasSource = write(
    "aliases/src/value.ts",
    "export interface Product { name: string }\nexport const product = 1;\n",
  );
  const aliasConsumer = write(
    "aliases/src/consumer.ts",
    "import { product } from '@app/value';\nimport { remote } from 'typed-package';\nexport const result = product + remote;\n",
  );
  const typedPackage = write(
    "aliases/node_modules/typed-package/index.d.ts",
    "/** external API */\nexport declare const remote: number;\n",
  );
  write("aliases/node_modules/typed-package/implementation.js", "export const remote = 2;\n");
  write(
    "aliases/node_modules/typed-package/package.json",
    JSON.stringify({
      name: "typed-package",
      exports: { ".": { types: "./index.d.ts", import: "./implementation.js" } },
    }),
  );
  add("compiler-module-resolution", {
    root: path.join(root, "aliases"),
    steps: [
      { kind: "origin", fromFile: aliasConsumer, specifier: "@app/value", name: "product" },
      { kind: "origin", fromFile: aliasConsumer, specifier: "@app/value", name: "Product" },
      { kind: "origin", fromFile: aliasConsumer, specifier: "typed-package", name: "remote" },
      { kind: "module", file: typedPackage, name: "remote" },
      { kind: "module", file: aliasSource, name: "Product" },
    ],
  });

  write("isolation/tsconfig.json", config);
  write("isolation/origin.ts", "export const original = 1;\n");
  const augmentation = write(
    "isolation/augmentation.ts",
    "import './origin';\ndeclare module './origin' { export const injected: number; }\nexport const marker = 1;\n",
  );
  const isolationConsumer = write(
    "isolation/consumer.ts",
    "import { original } from './origin';\nexport const observed = original;\n",
  );
  add("program-isolation", {
    root: path.dirname(augmentation),
    steps: [
      { kind: "origin", fromFile: augmentation, specifier: "./origin", name: "injected" },
      { kind: "origin", fromFile: isolationConsumer, specifier: "./origin", name: "injected" },
      { kind: "origin", fromFile: augmentation, specifier: "./origin", name: "injected" },
    ],
  });

  add("disposal", {
    root: path.dirname(origin),
    steps: [
      { kind: "module", file: origin, name: "realName" },
      { kind: "dispose" },
      { kind: "module", file: origin, name: "realName" },
      { kind: "module", file: absent, name: "missing" },
      { kind: "publishing", entries: { "./missing": absent }, name: "missing" },
      { kind: "dispose" },
    ],
  });
  add("dispose-before-lookup", {
    root: path.dirname(origin),
    steps: [
      { kind: "dispose" },
      { kind: "module", file: origin, name: "realName" },
      { kind: "dispose" },
    ],
  });
  fs.mkdirSync(path.join(root, "no-config"));
  add("missing-config", { root: path.join(root, "no-config"), steps: [] });
  write("no-config/package/tsconfig.json", "{}");
  add("deep-missing-config", {
    root: path.join(root, "no-config/package"),
    repoRoot: path.join(root, "no-config"),
    scope: "deep",
    steps: [],
  });

  write("malformed-config/tsconfig.json", '{ "compilerOptions": ');
  const malformedConfigFile = write("malformed-config/entry.ts", "export const available = 1;\n");
  add("malformed-config-behavior", {
    root: path.dirname(malformedConfigFile),
    steps: [{ kind: "module", file: malformedConfigFile, name: "available" }],
  });
  write("malformed-source/tsconfig.json", "{}");
  const malformedSource = write("malformed-source/entry.ts", "export function broken( {\n");
  add("malformed-source-behavior", {
    root: path.dirname(malformedSource),
    steps: [
      { kind: "module", file: malformedSource, name: "broken" },
      { kind: "module", file: malformedSource, name: "absent" },
    ],
  });

  write(
    "javascript/tsconfig.json",
    JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, types: [] },
      include: ["*.js"],
    }),
  );
  const javascript = write(
    "javascript/entry.js",
    "/** creates a value */\nexports.create = function createValue() { return 1; };\n",
  );
  add("javascript-declaration", {
    root: path.dirname(javascript),
    steps: [{ kind: "module", file: javascript, name: "create" }],
  });

  write("surrogate/tsconfig.json", "{}");
  const surrogateOrigin = write("surrogate/origin.ts", "export const value = 1;\n");
  const surrogateConsumer = write(
    "surrogate/consumer.ts",
    "import unused from '\\ud800';\nimport { value } from './origin';\nexport const result = value;\n",
  );
  add("unpaired-surrogate-specifier", {
    root: path.dirname(surrogateOrigin),
    steps: [{ kind: "origin", fromFile: surrogateConsumer, specifier: "./origin", name: "value" }],
  });

  const expected = cases.map(reference);
  const graphOutput = z.object({
    loaded: z.boolean(),
    answers: z.array(z.object({ ok: z.boolean(), answer: z.unknown().optional() })),
  });
  const first = graphOutput.parse(expected[0].output);
  assert.deepEqual(first.answers[0].answer, { file: origin, name: "realName" });
  assert.deepEqual(first.answers[1].answer, { file: origin, name: "default" });
  assert.deepEqual(first.answers[2].answer, { file: origin, name: "realName", line: 2 });
  const named = graphOutput.parse(expected[1].output);
  assert.deepEqual(named.answers[0].answer, { file: declarations, name: "run", line: 5 });
  assert.deepEqual(named.answers[1].answer, { file: declarations, name: "Merged", line: 8 });
  assert.deepEqual(named.answers[4].answer, { file: declarations, name: "Named", line: 12 });

  const invalid = [
    '{"id":"missing-input","operation":"code_graph.semantic","input":{}}',
    JSON.stringify({
      id: "unknown-operation",
      operation: "not-implemented",
      input: { root, steps: [] },
    }),
    JSON.stringify({
      id: "invalid-step",
      operation: "code_graph.semantic",
      input: { root, steps: [{ kind: "invented" }] },
    }),
    "not json",
  ];
  const native = spawnSync(binary, [manifest], {
    input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const actual = native.stdout
    .trim()
    .split("\n")
    .map((line) => resultSchema.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length + invalid.length);
  for (const [index, answer] of expected.entries()) {
    const { observedCalls: _expectedCalls, ...expectedResult } = answer;
    const { observedCalls: _actualCalls, ...actualResult } = actual[index];
    assert.deepEqual(actualResult, expectedResult, cases[index].id);
    assert.ok(actual[index].observedCalls.length > 0);
    assert.ok(actual[index].observedCalls.every((name) => name.startsWith("demlik_code_graph::")));
  }
  for (const answer of actual.slice(cases.length)) {
    assert.equal(answer.ok, false);
    assert.ok(answer.error?.message);
    assert.deepEqual(answer.observedCalls, []);
  }
  for (const directory of [
    "barrel",
    "declarations",
    "aliases",
    "isolation",
    "malformed-config",
    "malformed-source",
    "javascript",
  ]) {
    assert.ok(
      fs.readdirSync(path.join(root, directory)).every((file) => !file.startsWith(".code-graph-")),
      "virtual configs must not be written to the source tree",
    );
  }
  const graphCalls = actual
    .flatMap((answer) => answer.observedCalls)
    .filter((name) => name.startsWith("demlik_code_graph::resolve::InProcessGraph::"));
  const evidence = {
    reference: { node: process.version, v8: process.versions.v8, nativeCompiler: compiler },
    passed: cases.length,
    steps: graphCalls.length,
    queries: graphCalls.filter((name) => !name.endsWith("::dispose")).length,
    rejectedInvalidInputs: invalid.length,
    nativeApis: [...new Set(actual.flatMap((answer) => answer.observedCalls))].sort(),
    cases: actual,
  };
  if (process.argv[3]) fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, cases: undefined }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
