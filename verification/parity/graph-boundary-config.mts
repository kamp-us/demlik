import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import { BoundaryRulesSchema } from "../../packages/code-graph/src/boundaries/rules.js";

type Case = { id: string; raw: string };
const cases: Case[] = [];
const binary = process.argv[2];
assert.ok(binary, "provide the native boundary configuration driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const add = (id: string, value: unknown) =>
  cases.push({ id, raw: JSON.stringify(value) });
const raw = (id: string, text: string) => cases.push({ id, raw: text });
add("defaults", {});
for (const [index, value] of [null, false, 0, "text", []].entries())
  add(`root-${index}`, value);
const full = {
  features: { app: ["orders"] },
  lib: ["lib", "shared"],
  libraryTypes: {
    contract: { imports: ["contract"], pure: true, importedFrom: ["any"] },
  },
  libraries: { "packages/a": "contract" },
  libraryRoots: ["packages"],
  worldLibraries: ["world/*"],
  allowImportNames: { "packages/a": { "packages/b": ["read"] } },
  acrossDeployables: [
    "binding-outside-driven-adapter",
    "worker-call-cycle",
    "relative-import-crosses-workspace",
  ],
  bindingOwners: { app: { DB: ["src/orders/adapters/driven/db.ts"] } },
  applicationShape: [
    "index-not-exports-only",
    "application-import-outside-allowlist",
  ],
  applicationMayImport: ["contract"],
  pureDependencies: ["pure/*"],
  testFiles: ["**/*.test.ts"],
  readAllowance: { app: { driven: ["src/a.ts"], decidedBy: ["contract"] } },
  compositionRoots: ["src/worker.ts"],
};
add("all-fields", full);
const fields = Object.keys(full);
for (const key of fields)
  for (const [index, value] of [null, false, 3, "text", [], {}].entries())
    add(`field-${key}-${index}`, { [key]: value });
for (const key of [
  "lib",
  "libraryRoots",
  "worldLibraries",
  "applicationMayImport",
  "pureDependencies",
  "testFiles",
  "compositionRoots",
])
  for (const [index, value] of [
    [""],
    [false],
    [null],
    [{}],
    [1],
    ["x", ""],
    ["\ud800"],
  ].entries())
    add(`strings-${key}-${index}`, { [key]: value });
for (const [index, value] of [
  [],
  [""],
  ["x/y"],
  ["x\\y"],
  ["\n"],
  ["x/\n"],
  ["\ud800"],
  [null],
  [1],
  false,
].entries())
  add(`features-${index}`, { features: { app: value } });
add("empty-feature-key", { features: { "": ["orders"] } });
add("empty-library-key", { libraries: { "": "contract" } });
add("empty-library-type-key", {
  libraryTypes: { "": { imports: [], pure: true } },
});
add("empty-nested-allow-key", { allowImportNames: { app: { "": ["read"] } } });
add("empty-nested-binding-key", {
  bindingOwners: { app: { "": ["src/a.ts"] } },
});
add("empty-read-allowance-key", { readAllowance: { "": { driven: [] } } });
for (const [index, value] of [
  {},
  { imports: [] },
  { imports: [], pure: false },
  { imports: [""], pure: true },
  { imports: [], pure: null },
  { imports: [], pure: true, importedFrom: [] },
  { imports: [], pure: true, importedFrom: ["unknown"] },
  { imports: [], pure: true, importedFrom: [false] },
  { imports: [], pure: true, importedFrom: ["driven", "configurator", "any"] },
  { imports: [], pure: true, extra: 1 },
  null,
  [],
].entries())
  add(`library-type-${index}`, { libraryTypes: { contract: value } });
for (const key of ["allowImportNames", "bindingOwners"])
  for (const [index, value] of [
    {},
    { a: {} },
    { a: { b: [] } },
    { a: { b: [""] } },
    { a: { b: ["\ud800"] } },
    { a: { b: false } },
    { a: [] },
  ].entries())
    add(`names-${key}-${index}`, { [key]: value });
for (const [index, value] of [
  {},
  { driven: [] },
  { driven: [], decidedBy: [] },
  { driven: [""] },
  { driven: [], decidedBy: [""] },
  { driven: [], extra: 1 },
  null,
].entries())
  add(`allowance-${index}`, { readAllowance: { app: value } });
for (const key of ["acrossDeployables", "applicationShape"])
  for (const [index, value] of [
    [],
    [""],
    ["impure"],
    [null],
    [3],
    "worker-call-cycle",
  ].entries())
    add(`enum-${key}-${index}`, { [key]: value });
for (const key of [
  "features",
  "libraryTypes",
  "libraries",
  "allowImportNames",
  "bindingOwners",
  "readAllowance",
]) {
  for (const [index, ctorValue] of [
    null,
    false,
    1,
    "value",
    [],
    {},
    { prototype: {} },
    { prototype: null },
    { prototype: { isPrototypeOf: 0 } },
    { prototype: { isPrototypeOf: null } },
  ].entries()) {
    add(`constructor-${key}-${index}`, { [key]: { constructor: ctorValue } });
    add(`late-throw-${key}-${index}`, {
      features: { app: [] },
      [key]: { constructor: ctorValue },
    });
  }
  raw(`proto-${key}`, `{"${key}":{"__proto__":null}}`);
}
for (const key of ["allowImportNames", "bindingOwners"]) {
  add(`nested-constructor-${key}`, { [key]: { app: { constructor: null } } });
  add(`nested-late-throw-${key}`, {
    features: { app: [] },
    [key]: { app: { constructor: null } },
  });
  add(`invalid-parent-hides-child-${key}`, {
    [key]: { constructor: false, app: { constructor: null } },
  });
  add(`empty-key-throw-${key}`, { [key]: { "": { constructor: null } } });
  raw(`nested-proto-${key}`, `{"${key}":{"__proto__":{"constructor":null}}}`);
}
add("unknown-root-one", { extra: 1 });
add("unknown-root-many", { z: 1, a: 2 });
raw("unknown-root-key-order", '{"z":1,"2":2,"1":3}');
raw("unknown-lone-key", '{"\\ud800":1}');
raw("unknown-root-proto", '{"__proto__":1}');
raw("own-key-order-first-invalid", '{"features":{"z":[],"2":false,"1":null}}');
raw(
  "duplicate-feature-key-last-wins",
  '{"features":{"app":[],"app":["orders"]}}',
);
raw("overflow-number-remains-number", '{"features":{"app":1e400}}');
raw(
  "deep-irrelevant-field",
  `{"unknown":${"[".repeat(350)}0${"]".repeat(350)}}`,
);
raw(
  "raw-lone-values",
  '{"features":{"\\ud800":["\\udfff"]},"libraries":{"\\ud800":"\\udfff"}}',
);
function reference(test: Case) {
  try {
    const input: unknown = JSON.parse(test.raw);
    const result = BoundaryRulesSchema.safeParse(input);
    return {
      id: test.id,
      ok: true,
      output: result.success
        ? { success: true, data: result.data }
        : {
            success: false,
            issue: {
              path: result.error.issues[0].path,
              message: result.error.issues[0].message,
            },
          },
    };
  } catch (error) {
    assert.ok(error instanceof Error);
    return {
      id: test.id,
      ok: true,
      output: { thrown: { name: error.name, message: error.message } },
    };
  }
}
const expected = cases.map(reference);
const invalid = [
  "not json",
  JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
  JSON.stringify({ id: "missing", operation: "code_graph.boundary-config" }),
];
const result = spawnSync(binary, [], {
  input: `${[...cases.map((test) => `{"id":${JSON.stringify(test.id)},"operation":"code_graph.boundary-config","input":${test.raw}}`), ...invalid].join("\n")}\n`,
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
for (const [index, answer] of expected.entries()) {
  try {
    const { observedCalls: _calls, ...actual } = answers[index];
    assert.deepEqual(actual, answer, cases[index].id);
    assert.ok(answers[index].observedCalls.length);
  } catch (error) {
    failures.push({
      id: cases[index].id,
      message: error instanceof Error ? error.message : String(error),
      reference: answer,
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
  reference: { node: process.version, v8: process.versions.v8 },
  passed: cases.length - failures.length,
  attempted: cases.length,
  failures,
  rejectedInvalidInputs: invalid.length,
  cases: answers,
  qualifications: [
    "Rule input validation projects the first path/message or thrown TypeError, as the package config caller does. Declaration consistency is a separate pass.",
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
