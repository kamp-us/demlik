import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z as Zod } from "../../packages/code-graph/node_modules/zod/index.js";

import { discoverFunctions } from "../../packages/code-graph/src/extract/functions.js";
import {
  collectModuleCommentRanges,
  computeFunctionMetrics,
  moduleCommentLines,
  moduleLoc,
} from "../../packages/code-graph/src/extract/metrics.js";
import {
  listRepo,
  loadCheapProject,
} from "../../packages/code-graph/src/extract/project.js";
import { patternNames } from "../../packages/code-graph/src/syntax/bindings.js";
import {
  field,
  type SyntaxNode,
} from "../../packages/code-graph/src/syntax/file.js";
import { functionHeader } from "../../packages/code-graph/src/syntax/headers.js";

const { z }: { z: typeof Zod } = createRequire(
  new URL("../../packages/code-graph/package.json", import.meta.url),
)("zod");
const inputSchema = z.object({
  root: z.string(),
  includeNodes: z.boolean().optional(),
  sharedListing: z.boolean().optional(),
});
type Input = Zod.infer<typeof inputSchema>;
type Case = { id: string; operation: "code_graph.syntax"; input: Input };
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
  "usage: pnpm --filter @demlik/code-graph exec node --import tsx ../../verification/parity/code-graph-syntax.ts <native-driver> [evidence.json]",
);
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-syntax-parity-")),
);
const cases: Case[] = [];
const units = (value: string) =>
  Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
function write(relative: string, source: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}
function add(
  id: string,
  directory: string,
  includeNodes = true,
  sharedListing = false,
): void {
  cases.push({
    id,
    operation: "code_graph.syntax",
    input: inputSchema.parse({
      root: path.join(root, directory),
      includeNodes,
      sharedListing,
    }),
  });
}
function reference(item: Case): unknown {
  const project = loadCheapProject(
    item.input.root,
    item.input.sharedListing ? listRepo(item.input.root) : undefined,
  );
  const { functions } = discoverFunctions(project.sourceFiles);
  return {
    parseFailures: project.parseFailures,
    functions: functions.map((fn) => {
      const { unit: _unit, node: _node, ...value } = fn;
      return {
        function: value,
        metrics: computeFunctionMetrics(fn),
        header: functionHeader(fn.unit.syntax, fn.node),
      };
    }),
    files: project.sourceFiles.map(({ file, syntax }) => {
      const descendants: SyntaxNode[] = [syntax.program];
      syntax.forEachTsDescendant(syntax.program, (node) =>
        descendants.push(node),
      );
      return {
        file,
        loc: moduleLoc(syntax),
        commentLines: moduleCommentLines(syntax),
        comments: collectModuleCommentRanges(syntax),
        bindings: descendants
          .filter((node) =>
            ["TSParameterProperty", "ObjectPattern", "ArrayPattern"].includes(
              node.type,
            ),
          )
          .map((node) => ({ start: node.start, names: patternNames(node) })),
        literalUnits: descendants.flatMap((node) => {
          if (
            node.type === "Literal" &&
            typeof field(node, "value") === "string"
          )
            return [
              {
                start: node.start,
                value: units(z.string().parse(field(node, "value"))),
              },
            ];
          if (node.type === "TemplateElement")
            return [
              {
                start: node.start,
                value:
                  typeof node.value.cooked === "string"
                    ? units(node.value.cooked)
                    : null,
              },
            ];
          return [];
        }),
        nodes: item.input.includeNodes
          ? descendants.map((node) => ({
              kind: node.type,
              start: node.start,
              end: node.end,
              tsStart: syntax.tsStart(node),
              line: syntax.startLine(node),
              column: syntax.startColumn(node),
              endLine: syntax.endLine(node),
              children: syntax
                .tsChildren(node)
                .map((child) => [child.type, child.start, child.end]),
            }))
          : [],
      };
    }),
  };
}

try {
  write(
    "ordinary/src/main.ts",
    [
      "/** Public entry. */",
      "export function parent(xs: number[]) {",
      "  function child(x: number) { if (x) { if (x > 1) { return x; } } return 0; }",
      "  // Keep anonymous callback work here.",
      "  return xs.map(x => { if (x) { return x && 1; } return 0; });",
      "}",
      "",
    ].join("\n"),
  );
  write("ordinary/src/bad.ts", "export function broken( {");
  write("ordinary/src/ignored.d.ts", "declare function ignored(): void;");
  write("ordinary/.hidden.ts", "export function hidden() {}");
  write("ordinary/generated.gen.ts", "export function generated() {}");
  write("ordinary/vendor/skip.ts", "export function skipped() {}");
  add("ordinary-project-and-metrics", "ordinary");
  add("shared-visible-listing", "ordinary", true, true);
  write(
    "headers/fixture.ts",
    [
      "// Signature.",
      "export function pick(a: string): string;",
      "/** Second. */",
      "export function pick(a: number): number;",
      "// Implementation.",
      "export function pick(a: string | number): string | number /* note */ { return a; }",
      "const make = (value: number) => /* body */ ({ value });",
      "class C { static run(x: string): string; static run(x: string) { return x; } }",
      "interface I { get size(): number; }",
      "",
    ].join("\n"),
  );
  add("contiguous-overload-headers", "headers");
  write(
    "members/fixture.test.ts",
    [
      "@decorator class C {",
      "  constructor(private readonly db: DB, { left: renamed, flag = 1, ...rest }: Options, [head, , ...tail]: unknown[]) {}",
      "  #secret = () => 1;",
      "  accessor value = 1;",
      "  get item() { return this.value; }",
      "  set item(value: number) {}",
      "  [Symbol.iterator]() {}",
      "}",
      "const object = { method() {}, 'quoted'() {}, [Symbol.iterator]() {}, field: function named() {}, arrow: () => 1 };",
      "export { object };",
      "export default (value: number) => value;",
      "",
    ].join("\n"),
  );
  add("members-decorators-bindings-and-ordinals", "members");
  write(
    "unicode/view.tsx",
    "\uFEFF// 😀 Ω\r\nexport const view = () => (<div>\r\n  {/* one\r\n      two */}\r\n  <b />\r\n</div>);\r\nconst π = function Ω() { return 1; };\u2028// separator\u2029export { π };\r\n",
  );
  add("tsx-bom-crlf-unicode-columns-comments", "unicode");
  write(
    "comments/tokens.ts",
    [
      "// module",
      "export function run(x: number, y: number) {",
      "  try {",
      "    for (const a of [x]) { while (a) { break; } }",
      "    switch (x) { case 1: return x ? y : 0; case 2: break; default: return 0; }",
      "  } catch {",
      "    // swallowed",
      "  }",
      "  return (x && y || x) ?? y; // result",
      "}",
      "// end",
      "",
    ].join("\n"),
  );
  add("branch-tokens-closers-and-trailing-comments", "comments");
  write(
    "strings/literals.ts",
    "const high = '\\ud800'; const low = '\\udc00'; const cooked = `\\ud800\\uFFFD`; const paired = '\\ud83d\\ude00'; const bigint = 123n; const re = /ok/giu; export function alive() {}\n",
  );
  add("native-literal-utf16-values", "strings");
  write(
    "nested/source.ts",
    `export const nested = ${"(".repeat(160)}1${")".repeat(160)};`,
  );
  add("nested-estree-container-depth", "nested");
  fs.mkdirSync(path.join(root, "empty"));
  add("empty-project", "empty");
  add("missing-project", "missing");
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  for (const relative of [
    "packages/code-graph/src/extract/metrics.test.ts",
    "packages/code-graph/src/syntax/headers.test.ts",
    "packages/code-graph/src/extract/functions.ts",
    "packages/tea/src/pure/core.ts",
  ]) {
    write(
      `existing/${path.basename(relative)}`,
      fs.readFileSync(path.join(repo, relative), "utf8"),
    );
  }
  add("existing-reference-fixtures-and-tea-consumer", "existing", false);
  cases.push({
    id: "existing-graph-parity-project",
    operation: "code_graph.syntax",
    input: {
      root: path.join(repo, "packages/code-graph/test/parity/fixture"),
      includeNodes: false,
    },
  });
  cases.push({
    id: "existing-code-graph-source-consumers",
    operation: "code_graph.syntax",
    input: {
      root: path.join(repo, "packages/code-graph/src"),
      includeNodes: false,
    },
  });

  const expected = cases.map(reference);
  const ordinary = z
    .object({
      parseFailures: z.array(z.string()),
      files: z.array(
        z.object({
          file: z.string(),
          loc: z.number(),
          commentLines: z.number(),
        }),
      ),
      functions: z.array(
        z.object({
          function: z.object({ name: z.string() }),
          metrics: z.object({
            loc: z.number(),
            commentLines: z.number(),
            nestingDepth: z.number(),
            complexity: z.number(),
          }),
        }),
      ),
    })
    .parse(expected[0]);
  assert.deepEqual(ordinary.parseFailures, ["src/bad.ts"]);
  assert.deepEqual(ordinary.files, [
    { file: "src/main.ts", loc: 7, commentLines: 2 },
  ]);
  assert.equal(ordinary.functions.length, 2);
  assert.deepEqual(
    ordinary.functions.find((fn) => fn.function.name === "parent")?.metrics,
    { loc: 5, commentLines: 2, nestingDepth: 2, complexity: 3 },
  );
  const invalid = [
    "not json",
    '{"id":"missing","operation":"code_graph.syntax","input":{}}',
    JSON.stringify({
      id: "unsupported",
      operation: "invented",
      input: { root },
    }),
  ];
  const native = spawnSync(binary, [], {
    input:
      [...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n") +
      "\n",
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
        "demlik_code_graph::project::load_cheap_project",
      ),
    );
  }
  for (const result of actual.slice(cases.length)) {
    assert.equal(result.ok, false);
    assert.ok(result.error?.message);
    assert.deepEqual(result.observedCalls, []);
  }
  const evidence = {
    reference: {
      node: process.version,
      v8: process.versions.v8,
      parser: "0.151.0",
    },
    passed: cases.length,
    rejectedInvalidInputs: invalid.length,
    functions: expected.reduce<number>(
      (count, output) =>
        count +
        z.object({ functions: z.array(z.unknown()) }).parse(output).functions
          .length,
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
