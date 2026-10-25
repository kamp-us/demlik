import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import { detectImpureUses } from "../../packages/code-graph/src/boundaries/impure-uses.js";
import { BOUNDARY_KINDS } from "../../packages/code-graph/src/boundaries/ledger.js";
import {
  BoundaryRulesSchema,
  placeOf,
  scopeZoning,
} from "../../packages/code-graph/src/boundaries/rules.js";
import type { BoundaryViolation } from "../../packages/code-graph/src/boundaries/violation.js";
import { impureViolations } from "../../packages/code-graph/src/boundaries/zones/impure-violations.js";
import {
  isTestFile,
  judgedInTestFile,
  matchesGlobs,
} from "../../packages/code-graph/src/boundaries/zones/test-role.js";
import { globToRegExp } from "../../packages/code-graph/src/kinds/glob.js";
import {
  importLiterals,
  runtimeSpecifiers,
} from "../../packages/code-graph/src/syntax/imports.js";
import { sourceUnit } from "../../packages/code-graph/src/test-helpers/source-unit.js";

const binary = process.argv[2];
assert.ok(binary, "provide the native boundary zone driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
type ZoneInput = {
  scope: string;
  file: string;
  source: string;
  rules: unknown;
};
type RoleInput = {
  scope: string;
  file: string;
  patterns: string[];
  violations: BoundaryViolation[];
};
type Case =
  | { id: string; operation: "code_graph.zone-impurity"; input: ZoneInput }
  | { id: string; operation: "code_graph.test-role"; input: RoleInput };
const cases: Case[] = [];
const source =
  "console.log('x'); console.warn('x'); fetch('url'); Date.now(); process.env.CI; import fs from 'node:fs';";
const rules = { features: { app: ["orders"] } };
for (const file of [
  "src/orders/index.ts",
  "src/orders/ports.ts",
  "src/orders/application/use.ts",
  "src/orders/adapters/driving/http.ts",
  "src/orders/adapters/driven/db.ts",
  "src/orders/other/a.ts",
  "src/lib/clock.ts",
  "src/main.ts",
  "src/orders/application/\ud800.ts",
]) {
  cases.push({
    id: `feature-${JSON.stringify(file)}`,
    operation: "code_graph.zone-impurity",
    input: { scope: "app", file, source, rules },
  });
}
for (const file of [
  "src/application/use.ts",
  "src/application/driven-ports/db.ts",
  "src/driving-adapters/http.ts",
  "src/driven-adapters/db.ts",
]) {
  cases.push({
    id: `port-${file}`,
    operation: "code_graph.zone-impurity",
    input: {
      scope: "app",
      file,
      source,
      rules: {
        features: {
          app: ["application", "driving-adapters", "driven-adapters"],
        },
      },
    },
  });
}
for (const [index, body] of [
  "import type {Stats} from 'node:fs';",
  "import {type Stats} from 'node:fs';",
  "const fetch = () => 1; fetch();",
  "function read(process:P) { return process.env.X; }",
  "const { stdin:{isTTY} } = process; globalThis.process.env.CI;",
  "process['\\ud800']; new Date();",
].entries()) {
  cases.push({
    id: `source-${index}`,
    operation: "code_graph.zone-impurity",
    input: {
      scope: "app",
      file: "src/orders/application/use.ts",
      source: body,
      rules,
    },
  });
}
cases.push({
  id: "root-scope",
  operation: "code_graph.zone-impurity",
  input: {
    scope: ".",
    file: "src/orders/application/use.ts",
    source,
    rules: { features: { ".": ["orders"] } },
  },
});
cases.push({
  id: "inherited-scope",
  operation: "code_graph.zone-impurity",
  input: {
    scope: "toString",
    file: "src/orders/application/use.ts",
    source,
    rules: {},
  },
});

const violations = BOUNDARY_KINDS.map((kind): BoundaryViolation => {
  const base = {
    from: "apps/api/src/orders/use.test.ts",
    specifier: "a",
    typeOnly: false as const,
  };
  const to = "apps/api/src/billing/ports.ts";
  switch (kind) {
    case "cross-feature":
      return { kind, ...base, to, fromFeature: "orders", toFeature: "billing" };
    case "lib-imports-feature":
    case "outside-imports-feature-internal":
      return { kind, ...base, to, toFeature: "billing" };
    case "application-imports-adapter":
      return { kind, ...base, to, feature: "orders" };
    case "driving-reaches-driven":
      return {
        kind,
        ...base,
        to,
        feature: "orders",
        write: { file: "src/db.ts", line: 7, binding: "DB" },
      };
    case "unknown-zone":
      return { kind, ...base, to: null, feature: "orders" };
    case "impure":
    case "index-not-exports-only":
    case "library-undeclared":
    case "binding-outside-driven-adapter":
    case "worker-call-cycle":
      return { kind, ...base, to: null };
    case "application-import-outside-allowlist":
    case "library-imports-up":
    case "adapter-library-imported-outside-driven":
    case "relative-import-crosses-workspace":
    case "test-reaches-composition-root":
      return { kind, ...base, to };
  }
  const exhaustive: never = kind;
  throw new Error(`Unsupported boundary kind: ${exhaustive}`);
});
const roleCases: [string, string, string[]][] = [
  ["apps/api", "src/orders/use.test.ts", ["**/*.test.ts"]],
  ["apps/api", "src/orders/use.ts", ["**/*.test.ts"]],
  ["apps/api", "src/orders/use.test.ts", ["apps/*/src/**/*.test.ts"]],
  [".", "src/orders/use.test.ts", ["src/**/*.test.ts"]],
  [".", "use.test.ts", ["*.test.ts"]],
  ["apps/api", "src/orders/use.test.ts", []],
  ["apps/api", "src/orders/use.test.ts", ["*.test.ts"]],
  ["apps/api", "src/\ud800.test.ts", ["**/*.test.ts"]],
  [".", "\ud800", ["\ud800"]],
  ["", "src/orders/use.test.ts", ["/src/**/*.test.ts"]],
  ["apps/api", "src/\nname.test.ts", ["**/*.test.ts"]],
];
for (const [index, [scope, file, patterns]] of roleCases.entries())
  cases.push({
    id: index === 0 ? "test-role-all-kinds" : `test-role-${index}`,
    operation: "code_graph.test-role",
    input: { scope, file, patterns, violations },
  });
const expected = cases.map((item) => {
  try {
    if (item.operation === "code_graph.test-role") {
      const { scope, file, patterns, violations } = item.input,
        globs = patterns.map(globToRegExp),
        judged = judgedInTestFile(violations);
      return {
        id: item.id,
        ok: true,
        output: {
          matches: matchesGlobs(globs, scope, file),
          isTest: isTestFile(globs, scope, file),
          judged,
          sameRefs: judged.map((row) => violations.indexOf(row)),
        },
      };
    }
    const { scope, file, source, rules } = item.input;
    const parsed = BoundaryRulesSchema.safeParse(rules);
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
    const place = placeOf(file, scopeZoning(parsed.data, scope)),
      syntax = sourceUnit(source, file).syntax;
    const module = {
      file,
      impureUses: detectImpureUses(syntax),
      importEdges: importLiterals(syntax).map(
        ({ specifier, kind, typeOnly }) => ({
          specifier,
          kind,
          typeOnly,
          target: null,
        }),
      ),
      runtimeSpecifiers: runtimeSpecifiers(syntax),
    };
    return {
      id: item.id,
      ok: true,
      output: { place, violations: impureViolations({ scope, module, place }) },
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
    operation: "code_graph.test-role",
    input: {},
  }),
];
const result = spawnSync(binary, [], {
  input: `${[...cases.map((item) => JSON.stringify(item)), ...invalid].join("\n")}\n`,
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
    "Glob matching uses the package's unflagged glob compiler. Zone impurity uses real OXC trees and unresolved import edges; resolving loaded modules belongs to the scope reader.",
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
