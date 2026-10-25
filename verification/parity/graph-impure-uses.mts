import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import {
  detectImpureUses,
  impureNamesOf,
} from "../../packages/code-graph/src/boundaries/impure-uses.js";
import {
  importLiterals,
  runtimeSpecifiers,
} from "../../packages/code-graph/src/syntax/imports.js";
import { sourceUnit } from "../../packages/code-graph/src/test-helpers/source-unit.js";

const binary = process.argv[2];
assert.ok(binary, "provide the native impurity syntax driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
type Case = { id: string; input: { source: string; file: string } };
const cases: Case[] = [];
function add(id: string, source: string, file = "fixture.ts") {
  cases.push({ id, input: { source, file } });
}
add(
  "bound-parameter",
  "function injected(fetch: unknown) {} function other() { fetch('url'); }",
);
add(
  "only-types",
  "type F = typeof fetch; let p: typeof process.hrtime; type D = Date; interface X { run: typeof setTimeout }",
);
const sources = [
  "process.env.X;",
  "process.env['X'];",
  "process.env[k];",
  "process['env'].X;",
  "const { X } = process.env;",
  "const { env } = process;",
  "const all = {...process.env};",
  "load(process.env);",
  "const { X = 1, Y: renamed, ...rest } = process.env;",
  "process?.env?.X;",
  "(process as NodeJS.Process).env;",
  "process.env!.X;",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: This parser fixture must retain its template expression.
  "`${process.env.X}`;",
  "process.argv.slice(2);",
  "const [, , first] = process.argv;",
  "process.stdin.isTTY;",
  "process.stdin.on('data', f);",
  "const { stdin } = process;",
  "process.stdout.write('x');",
  "const { stdout: { isTTY } } = process;",
  "process.stderr.write('x');",
  "process.exit(1);",
  "run(process.exit);",
  "process.cwd();",
  "const { cwd } = process;",
  "process.hrtime();",
  "process['hrtime']();",
  "process.hrtime.bigint();",
  "const { hrtime } = process;",
  "const { memoryUsage: mem } = process;",
  "process.platform;",
  "globalThis.process.platform;",
  "process?.on?.('exit', f);",
  "process.versions.node;",
  "const { arch } = process;",
  "process.uptime();",
  "const p = process;",
  "process;",
  "process[k];",
  "const { ...rest } = process;",
  "const { [k]: v } = process;",
  "o.process.hrtime();",
  "const process = inject(); process.platform;",
  "function run(process: P) { return process.hrtime(); }",
  "import process from './world.js'; process.platform;",
  "Date.now();",
  "const now = Date.now;",
  "const { now } = Date;",
  "Date['now']();",
  "Date.parse('x'); Date.UTC(2020,1);",
  "Math.random();",
  "const { random } = Math;",
  "Math.floor(n);",
  "crypto.randomUUID();",
  "const { randomUUID } = crypto;",
  "crypto.getRandomValues(new Uint8Array(4));",
  "const { getRandomValues } = crypto;",
  "crypto.subtle;",
  "performance.now();",
  "const { now } = performance;",
  "performance.mark('a');",
  "fetch('u');",
  "const f = fetch;",
  "run(fetch);",
  "typeof fetch;",
  "fetch?.('u');",
  "const o = {fetch: 1}; o.fetch('u'); this.fetch('u'); class A {fetch(){}}",
  "setTimeout(f, 1);",
  "const t = setTimeout;",
  "o.setTimeout(f,1);",
  "setInterval(f,1);",
  "console.log('x');",
  "const { log } = console;",
  "globalThis;",
  "globalThis.globalThis.process.env.X;",
  "new Date();",
  "new Date(0);",
  "new globalThis.Date();",
  "const Date = clock; new Date();",
  "const { stdin: { isTTY = false } } = process;",
  "({ env } = process);",
  "({ env } = process) => env;",
  "const { ['env']: e } = process;",
  "const { [Date.now()]: e } = process;",
  "process[Date.now()].env;",
  "process.env[fetch('key')].OTHER;",
  "(globalThis as unknown as World)['process']['env'];",
  "process['\\ud800'].x; process['\\udfff'].x;",
  "process['a\\0b'].x; process.a['b\\0x'];",
  "fetch: for (;;) { break fetch; }",
  "const o = { [fetch('key')]: 1, fetch };",
  "export { fetch }; export * as console from 'node:fs';",
  "class A { [Date.now()]() { return fetch('u') } }",
  "try {} catch(fetch) { fetch('u'); }",
  "class fetch {} function other(){ fetch('u') }",
  "const o = class fetch {}; function other(){ fetch('u') }",
  "const f = function fetch() {}; fetch('u');",
  "const { fetch } = injected; fetch('u');",
  "const [fetch] = injected; fetch('u');",
  "function f({fetch = fallback}: Input) { fetch('u') }",
  "class X { constructor(private fetch: F) {} } fetch('u');",
  "declare const process: Process; process.env.CI;",
  "namespace X { export const x = process.env.CI; }",
  "namespace fetch { export const x = 1; } fetch('u');",
  "export = process.env;",
  "fetch!.call(null, 'u'); (fetch satisfies F)('u'); (<F>fetch)('u');",
  "f<typeof fetch>(process.env);",
  "import type { fetch } from './types'; fetch('u');",
  "import {type Stats} from 'node:fs';",
  "import type { Stats } from 'node:fs';",
  "import fs from 'node:fs';",
  "export type { Stats } from 'node:fs';",
  "export { type Stats } from 'node:fs';",
  "export { readFile } from 'node:fs';",
  "import('node:fs');",
  "require('node:fs');",
  "import { type Stats } from 'node:fs'; import fs from 'node:fs';",
];
for (const [index, source] of sources.entries()) add(`syntax-${index}`, source);
add(
  "tsx",
  "const view = <button onClick={() => fetch('u')}>{process.env.CI}</button>;",
  "view.tsx",
);
for (const file of [
  "packages/code-graph/src/boundaries/impure-uses.ts",
  "packages/code-graph/src/config.ts",
  "packages/code-graph/src/extract/wrangler-config.ts",
  "packages/tea/src/promise/run.ts",
]) {
  add(
    `repo-${file}`,
    fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
    file,
  );
}
const expected = cases.map((item) => {
  const syntax = sourceUnit(item.input.source, item.input.file).syntax;
  const uses = detectImpureUses(syntax),
    runtime = runtimeSpecifiers(syntax);
  const importEdges = importLiterals(syntax).map(
    ({ specifier, kind, typeOnly }) => ({
      specifier,
      kind,
      typeOnly,
      target: null,
    }),
  );
  return {
    id: item.id,
    ok: true,
    output: {
      uses,
      names: impureNamesOf({
        impureUses: uses,
        importEdges,
        runtimeSpecifiers: runtime,
      }),
      runtime: [...runtime],
    },
  };
});
assert.deepEqual(expected[0].output.uses, []);
assert.deepEqual(expected[1].output.uses, []);
const invalid = [
  "not json",
  JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
  JSON.stringify({
    id: "missing",
    operation: "code_graph.impure-uses",
    input: { file: "fixture.ts" },
  }),
];
const result = spawnSync(binary, [], {
  input: `${[...cases.map((item) => JSON.stringify({ id: item.id, operation: "code_graph.impure-uses", input: item.input })), ...invalid].join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  timeout: 30_000,
});
assert.equal(result.status, 0, result.stderr);
const schema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  diagnostic: z.string().optional(),
  observedCalls: z.array(z.string()),
});
const answers = result.stdout
  .trim()
  .split("\n")
  .map((line) => schema.parse(JSON.parse(line)));
assert.equal(answers.length, cases.length + invalid.length);
const failures: {
  id: string;
  message: string;
  reference: unknown;
  native: unknown;
}[] = [];
for (const [index, reference] of expected.entries()) {
  try {
    const { observedCalls: _calls, ...actual } = answers[index];
    assert.deepEqual(actual, reference, cases[index].id);
    assert.ok(
      answers[index].observedCalls.includes(
        "demlik_code_graph::boundaries::impure_uses::detect_impure_uses",
      ),
    );
  } catch (error) {
    failures.push({
      id: cases[index].id,
      message: error instanceof Error ? error.message : String(error),
      reference,
      native: answers[index],
    });
  }
}
for (const answer of answers.slice(cases.length)) {
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "driver_error");
  assert.ok(answer.diagnostic);
  assert.deepEqual(answer.observedCalls, []);
}
const report = {
  reference: {
    node: process.version,
    v8: process.versions.v8,
    parser: "OXC0.151.0",
  },
  passed: cases.length - failures.length,
  attempted: cases.length,
  failures,
  rejectedInvalidInputs: invalid.length,
  cases: answers,
  qualifications: [
    "Source binding checks deliberately collect names across the whole file, matching the current detector's scope. Import observations use the real literal/runtime pass with unresolved targets.",
  ],
};
if (process.argv[3])
  fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    { ...report, cases: undefined, failures: failures.slice(0, 4) },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
