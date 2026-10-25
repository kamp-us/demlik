import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { deployableDeclarationIssue } from "../../packages/code-graph/src/boundaries/deployables/declaration.js";
import {
  GLOBAL_OBJECT,
  IMPURE_GLOBALS,
  IMPURE_ROWS,
  impureBareNewOf,
  impureModuleOf,
  impureModulesOpened,
  impurePathOf,
} from "../../packages/code-graph/src/boundaries/impure.js";
import { libraryDeclarationIssue } from "../../packages/code-graph/src/boundaries/libraries/declaration.js";
import { BoundaryRulesSchema } from "../../packages/code-graph/src/boundaries/rules.js";
import { shapeDeclarationIssue } from "../../packages/code-graph/src/boundaries/shape/declaration.js";
import { resolveBoundaryRules } from "../../packages/code-graph/src/config.js";

const binary = process.argv[2];
assert.ok(binary, "provide the native boundary domain driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const impureInput = z.object({
  paths: z.array(z.array(z.string())),
  ctors: z.array(z.string()),
  edges: z.array(
    z.object({
      specifier: z.string(),
      target: z.string().nullable(),
      typeOnly: z.boolean(),
      kind: z.enum(["static", "export-from", "dynamic"]),
    }),
  ),
  runtime: z.array(z.string()),
});
type ImpureInput = z.infer<typeof impureInput>;
type Case = {
  id: string;
  operation: "code_graph.impure" | "code_graph.boundary-declarations";
  raw: string;
};
const cases: Case[] = [];
function declarations(id: string, rules: unknown) {
  cases.push({
    id,
    operation: "code_graph.boundary-declarations",
    raw: JSON.stringify(rules),
  });
}
function impure(id: string, input: Partial<ImpureInput>) {
  cases.push({
    id,
    operation: "code_graph.impure",
    raw: JSON.stringify({
      paths: [["process", "hrtime", "bigint"]],
      ctors: ["Date", "Other"],
      edges: [],
      runtime: [],
      ...input,
    }),
  });
}
const paths = [
  [],
  ["process"],
  ["process", "env"],
  ["process", "hrtime", "bigint"],
  ["Date"],
  ["Date", "now"],
  ["Date", "now", "call"],
  ["Math", "random"],
  ["crypto", "randomUUID"],
  ["crypto", "getRandomValues"],
  ["performance", "now"],
  ["fetch"],
  ["setTimeout"],
  ["setInterval"],
  ["console"],
  ["console", "log"],
  ["globalThis"],
  ["globalThis", "process", "env"],
  ["process", "\ud800"],
  ["fetcher"],
  ["x", "fetch"],
];
for (const [index, value] of paths.entries()) {
  impure(`path-${index}`, {
    paths: [value, [...value, "extra"], ["other", ...value]],
  });
}
for (const specifier of [
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "child_process",
  "node:child_process/spawn",
  "node:node:fs",
  "fs-extra",
  "./fs",
  "node:",
  "",
  "\ud800",
]) {
  for (const typeOnly of [false, true])
    for (const target of [null, "src/fs.ts"]) {
      const edge = { specifier, typeOnly, target, kind: "static" as const };
      impure(`module-${JSON.stringify(specifier)}-${typeOnly}-${target}`, {
        edges: [edge, edge],
        runtime: [specifier],
      });
    }
}
impure("runtime-filter", {
  edges: [
    {
      specifier: "node:fs",
      typeOnly: false,
      target: null,
      kind: "export-from",
    },
    {
      specifier: "child_process",
      typeOnly: false,
      target: null,
      kind: "dynamic",
    },
  ],
  runtime: ["child_process"],
});
impure("constructors", {
  ctors: ["Date", "date", "Date()", "globalThis.Date", "\ud800", "", "Object"],
});

declarations("defaults", {});
declarations("duplicate-feature", { features: { app: ["orders", "orders"] } });
declarations("feature-lib-collision", { features: { app: ["orders", "lib"] } });
declarations("mixed-layout", { features: { app: ["orders", "application"] } });
declarations("partial-port-layout", { features: { app: ["application"] } });
declarations("complete-port-layout", {
  features: { app: ["application", "driving-adapters", "driven-adapters"] },
});
declarations("feature-first", {
  features: { app: ["lib"] },
  libraries: { a: "missing" },
  compositionRoots: ["src/main.ts"],
});
const kernel = { imports: [], pure: true };
const types = { kernel, adapter: { imports: [], pure: false } };
declarations("declared-types", {
  libraryTypes: types,
  libraries: { a: "kernel", b: "adapter" },
});
declarations("unknown-import-type", {
  libraryTypes: { kernel: { imports: ["missing"], pure: true } },
});
declarations("unknown-library-type", { libraries: { a: "missing" } });
declarations("library-first", {
  libraryTypes: { kernel: { imports: ["missing"], pure: true } },
  worldLibraries: ["fetch"],
});
for (const glob of [
  "world/*",
  "*",
  "fetch",
  "{fetch,console}",
  "process.*",
  "node:*",
  "{open",
  "closed}",
  "a,b",
  "\ud800",
  "{a,{b,c}}",
])
  declarations(`world-${JSON.stringify(glob)}`, { worldLibraries: [glob] });
const libraries = { a: "kernel", b: "adapter" };
declarations("allowance-valid", {
  libraryTypes: types,
  libraries,
  allowImportNames: { a: { b: ["read"] } },
});
declarations("allowance-unknown-importer", {
  libraryTypes: types,
  libraries,
  allowImportNames: { missing: { b: ["read"] } },
});
declarations("allowance-unknown-target", {
  libraryTypes: types,
  libraries,
  allowImportNames: { a: { missing: ["read"] } },
});
declarations("allowance-redundant", {
  libraryTypes: { ...types, kernel: { imports: ["adapter"], pure: true } },
  libraries,
  allowImportNames: { a: { b: ["read"] } },
});
declarations("allowance-inherited-target", {
  libraryTypes: types,
  libraries,
  allowImportNames: { a: { toString: ["read"] } },
});
declarations("allowance-inherited-importer", {
  libraryTypes: types,
  libraries,
  allowImportNames: { toString: { b: ["read"] } },
});
declarations("allowance-inherited-importer-type", {
  libraries: { a: "toString", b: "contract" },
  allowImportNames: { a: { b: ["read"] } },
});
declarations("allowance-native-function-type", {
  libraryTypes: {
    adapter: types.adapter,
    "function toString() { [native code] }": {
      imports: ["adapter"],
      pure: false,
    },
  },
  libraries: { b: "adapter" },
  allowImportNames: { toString: { b: ["read"] } },
});

const B17 = "binding-outside-driven-adapter";
const B16 = "application-import-outside-allowlist";
const feature = { features: { app: ["orders"] } };
const driven = "src/orders/adapters/driven/db.ts";
for (const file of [
  driven,
  "src/orders/application/read.ts",
  "src/orders/adapters/driving/http.ts",
  "src/orders/index.ts",
  "src/other/adapters/driven/db.ts",
  "src/orders/adapters/driven",
  "src/orders/adapters/driven-extra/db.ts",
  "src/orders/adapters/driven/\ud800.ts",
]) {
  declarations(`owner-${JSON.stringify(file)}`, {
    ...feature,
    acrossDeployables: [B17],
    bindingOwners: { app: { DB: [file] } },
  });
  declarations(`read-${JSON.stringify(file)}`, {
    ...feature,
    readAllowance: { app: { driven: [file] } },
  });
}
declarations("owner-kind-off", {
  ...feature,
  bindingOwners: { app: { DB: [driven] } },
});
declarations("owner-unknown-scope", {
  acrossDeployables: [B17],
  bindingOwners: { missing: { DB: [driven] } },
});
declarations("owner-inherited-scope", {
  acrossDeployables: [B17],
  bindingOwners: { toString: { DB: [driven] } },
});
declarations("owner-port", {
  features: { app: ["application", "driving-adapters", "driven-adapters"] },
  acrossDeployables: [B17],
  bindingOwners: { app: { DB: ["src/driven-adapters/db.ts"] } },
});
for (const key of ["applicationMayImport", "pureDependencies"])
  declarations(`shape-kind-off-${key}`, { [key]: ["kernel"] });
declarations("shape-unknown-type", {
  applicationShape: [B16],
  applicationMayImport: ["missing"],
});
declarations("shape-known-type", {
  libraryTypes: types,
  applicationShape: [B16],
  applicationMayImport: ["kernel"],
});
for (const key of ["pureDependencies", "testFiles", "compositionRoots"])
  for (const glob of [
    "**/*.{test,spec}.ts",
    "{open",
    "a}",
    "x,y",
    "\ud800",
    "{a,{b,c}}",
  ])
    declarations(`shape-glob-${key}-${JSON.stringify(glob)}`, {
      applicationShape: [B16],
      testFiles: ["**/*.test.ts"],
      [key]: [glob],
    });
declarations("roots-need-tests", { compositionRoots: ["src/main.ts"] });
declarations("read-empty", {
  ...feature,
  readAllowance: { app: { driven: [] } },
});
declarations("read-empty-decision", {
  ...feature,
  readAllowance: { app: { driven: [driven], decidedBy: [] } },
});
declarations("read-unknown-type", {
  ...feature,
  readAllowance: { app: { driven: [driven], decidedBy: ["missing"] } },
});
declarations("read-valid-decision", {
  ...feature,
  libraryTypes: types,
  readAllowance: { app: { driven: [driven], decidedBy: ["kernel"] } },
});
declarations("read-unknown-scope", {
  readAllowance: { missing: { driven: [driven] } },
});
declarations("read-inherited-scope", {
  applicationMayImport: ["missing"],
  readAllowance: { toString: { driven: [] } },
});
declarations("raw-utf16-diagnostic", {
  libraryTypes: { "\ud800": { imports: ["\udfff"], pure: true } },
});
declarations("numeric-key-order", {
  libraryTypes: {
    z: { imports: ["missing-z"], pure: true },
    "2": { imports: ["missing-2"], pure: true },
    "1": { imports: ["missing-1"], pure: true },
  },
});
declarations("invalid-rule-input", { unknown: true });
declarations("invalid-rule-key", { features: { "": ["orders"] } });
declarations("thrown-rule-input", { libraryTypes: { constructor: null } });

function check(run: () => string | null) {
  try {
    return { issue: run() };
  } catch (error) {
    assert.ok(error instanceof Error);
    return { thrown: { name: error.name, message: error.message } };
  }
}
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-boundary-domain-"),
);
try {
  const configFile = path.join(directory, "rules.json");
  const expected = cases.map((item) => {
    const input: unknown = JSON.parse(item.raw);
    if (item.operation === "code_graph.impure") {
      const { paths, ctors, edges, runtime } = impureInput.parse(input);
      return {
        id: item.id,
        ok: true,
        output: {
          paths: paths.map(impurePathOf),
          ctors: ctors.map(impureBareNewOf),
          modules: edges.map(impureModuleOf),
          opened: impureModulesOpened(edges, new Set(runtime)),
          rows: IMPURE_ROWS,
          globals: IMPURE_GLOBALS,
          globalObject: GLOBAL_OBJECT,
        },
      };
    }
    try {
      const parsed = BoundaryRulesSchema.safeParse(input);
      if (!parsed.success)
        return {
          id: item.id,
          ok: true,
          output: {
            inputIssue: {
              path: parsed.error.issues[0].path,
              message: parsed.error.issues[0].message,
            },
          },
        };
      fs.writeFileSync(configFile, item.raw);
      const rules = parsed.data;
      return {
        id: item.id,
        ok: true,
        output: {
          library: check(() => libraryDeclarationIssue(rules)),
          deployable: check(() => deployableDeclarationIssue(rules)),
          shape: check(() => shapeDeclarationIssue(rules)),
          combined: check(() => {
            const messages: string[] = [];
            const resolved = resolveBoundaryRules(configFile, (message) =>
              messages.push(message),
            );
            assert.equal(messages.length, resolved === null ? 1 : 0);
            return messages[0] ?? null;
          }),
        },
      };
    } catch (error) {
      assert.ok(error instanceof Error);
      return {
        id: item.id,
        ok: true,
        output: { thrown: { name: error.name, message: error.message } },
      };
    }
  });
  const invalid = [
    "not json",
    JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
    JSON.stringify({
      id: "missing",
      operation: "code_graph.impure",
      input: {},
    }),
  ];
  const result = spawnSync(binary, [], {
    input: `${[...cases.map((item) => `{"id":${JSON.stringify(item.id)},"operation":${JSON.stringify(item.operation)},"input":${item.raw}}`), ...invalid].join("\n")}\n`,
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
      assert.ok(answers[index].observedCalls.length);
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
    reference: { node: process.version, v8: process.versions.v8 },
    passed: cases.length - failures.length,
    attempted: cases.length,
    failures,
    rejectedInvalidInputs: invalid.length,
    cases: answers,
    qualifications: [
      "Declaration checks consume validated rule records. The combined source observation uses resolveBoundaryRules against a real temporary rules file.",
      "Impurity vocabulary helpers are compared here; AST impurity detection is a separate pass.",
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
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
