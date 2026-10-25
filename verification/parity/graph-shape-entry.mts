import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import { firstOffendingForm } from "../../packages/code-graph/src/boundaries/shape/entry-file.js";
import { sourceUnit } from "../../packages/code-graph/src/test-helpers/source-unit.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled boundary domain driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const cases: { id: string; input: { file: string; source: string } }[] = [];
function add(id: string, source: string, file = "fixture.ts") {
  cases.push({ id, input: { file, source } });
}
const allowed = [
  "",
  "// a comment\n",
  'export { a } from "./a";',
  'export type { A } from "./a";',
  'export { type A, b } from "./a";',
  'export { a as b } from "./a";',
  'export { default as c } from "./a";',
  'export { a } from "./a"; export type { B } from "./b";',
];
for (const [index, source] of allowed.entries()) add(`clean-${index}`, source);
const offending = [
  'export * from "./a";',
  'export * as ns from "./a";',
  'export type * from "./a";',
  "export default {};",
  "export default function f() {}",
  "export default class C {}",
  "export { a };",
  "export type { A };",
  'import { a } from "./a";',
  'import type { A } from "./a";',
  'import "./a";',
  "export const a = 1;",
  "export function f() {}",
  "export class C {}",
  "export type A = string;",
  "export interface I {}",
  "export enum E { A }",
  "const a = 1;",
  "function f() {}",
  "type A = string;",
  "declare const a: string;",
  "declare function f(): void;",
  "abstract class C {}",
  "run();",
  '"use strict";',
  'export {} from "./a";',
  "export = a;",
  "namespace N {}",
  'declare module "m" {}',
  ";",
  "if (true) run();",
];
for (const [index, source] of offending.entries()) {
  add(`form-${index}`, source);
  add(`after-clean-${index}`, `export { before } from './safe';\n${source}`);
}
add("first-default", "export default {}; export const next = 1;");
add("first-declaration", "export const first = 1; export * from './a';");
add("first-import", "import './a'; export default {};");
add("first-directive", "'use strict'; export default {};");
add("empty-export-is-not-a-reexport", "export {};");
add("jsx", "export default <button />;", "view.tsx");
add("string-export-name", 'export { "space name" as alias } from "./m";');
for (const file of [
  "packages/tea/src/flow/index.ts",
  "packages/code-graph/src/boundaries/shape/entry-file.ts",
  "packages/code-graph/src/boundaries/analyze.ts",
  "packages/code-graph/src/layers/resolve-target.ts",
]) {
  add(`repo-${file}`, fs.readFileSync(file, "utf8"), file);
}
assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
const expected = cases.map(({ id, input }) => {
  try {
    return firstOffendingForm(sourceUnit(input.source, input.file).syntax);
  } catch (cause) {
    throw new Error(`source entry fixture ${id} failed`, { cause });
  }
});
const invalid = [
  {
    id: "missing-file",
    operation: "code_graph.entry-form",
    input: { source: "" },
  },
  {
    id: "wrong-source",
    operation: "code_graph.entry-form",
    input: { file: "a.ts", source: 1 },
  },
  {
    id: "extra-field",
    operation: "code_graph.entry-form",
    input: { file: "a.ts", source: "", extra: true },
  },
  {
    id: "wrong-operation",
    operation: "code_graph.unknown",
    input: { file: "a.ts", source: "" },
  },
];
const malformedExport = 'export { "\\ud800" as alias } from "./m";';
assert.throws(() => sourceUnit(malformedExport), /does not parse/);
invalid.push({
  id: "source-refuses-surrogate-export",
  operation: "code_graph.entry-form",
  input: { file: "fixture.ts", source: malformedExport },
});
const result = spawnSync(binary, [], {
  encoding: "utf8",
  input: [
    ...cases.map((item) => ({ ...item, operation: "code_graph.entry-form" })),
    ...invalid,
  ]
    .map((item) => `${JSON.stringify(item)}\n`)
    .join(""),
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
const answer = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  observedCalls: z.array(z.string()),
});
const answers = result.stdout
  .trim()
  .split("\n")
  .map((line) => answer.parse(JSON.parse(line)));
assert.equal(answers.length, cases.length + invalid.length);
const failures: {
  id: string;
  reference: { ok: true; output: unknown };
  native: z.infer<typeof answer>;
  message: string;
}[] = [];
for (const [index, item] of cases.entries()) {
  assert.equal(answers[index].id, item.id);
  assert.equal(answers[index].ok, true, answers[index].error);
  assert(
    answers[index].observedCalls.includes(
      "demlik_code_graph::boundaries::shape::entry_file::first_offending_form",
    ),
  );
  try {
    assert.deepEqual(answers[index].output, expected[index]);
  } catch (error) {
    failures.push({
      id: item.id,
      reference: { ok: true, output: expected[index] },
      native: answers[index],
      message: String(error),
    });
  }
}
for (const item of answers.slice(cases.length)) {
  assert.equal(item.ok, false);
  assert(item.error);
}
const report = {
  reference: { node: process.version, v8: process.versions.v8 },
  passed: cases.length - failures.length,
  attempted: cases.length,
  failures,
  rejectedInvalidInputs: invalid.length,
  parserRefusals: 1,
  qualifications: [
    "Entry-form extraction only; shape judgments and the complete boundary analyzer are separate.",
  ],
  nativeApis: [...new Set(answers.flatMap((item) => item.observedCalls))],
  cases: answers,
};
if (process.argv[3])
  fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, cases: undefined }));
if (failures.length) process.exitCode = 1;
