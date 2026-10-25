import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import { declaresDeployables } from "../../packages/code-graph/src/boundaries/deployables/schema.js";
import { declaresLibraries } from "../../packages/code-graph/src/boundaries/libraries/schema.js";
import {
  type BoundaryRules,
  BoundaryRulesSchema,
  DRIVEN_HOMES,
  featureFileOf,
  inScope,
  layoutIssue,
  placeOf,
  scopeZoning,
  unlistedPortFolderIssue,
} from "../../packages/code-graph/src/boundaries/rules.js";
import { declaresReadAllowance } from "../../packages/code-graph/src/boundaries/shape/schema.js";

type Input = {
  rules: Partial<BoundaryRules>;
  scopes: string[];
  files: string[];
  folders: string[];
  held: string[];
};
type Case = { id: string; operation: "code_graph.zoning"; input: Input };
const defaults = BoundaryRulesSchema.parse({});
const cases: Case[] = [];
const binary = process.argv[2];
assert.ok(binary, "provide the native zoning driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const files = [
  "src/orders/index.ts",
  "src/orders/ports.ts",
  "src/orders/application/place.ts",
  "src/orders/adapters/driving/http.ts",
  "src/orders/adapters/driven/db.ts",
  "src/orders/domain/helpers.ts",
  "src/orders/adapters/shared/a.ts",
  "src/orders/adapters/odd/a.ts",
  "src/orders/index.ts/odd.ts",
  "src/orders/application-extra/x.ts",
  "src/orders/adapters",
  "src/orders/adapters/",
  "src/orders/adapters//x.ts",
  "src/orders",
  "src/orders/",
  "src/lib/clock.ts",
  "src/lib/",
  "src/lib",
  "src/application/driving-ports/http.ts",
  "src/application/driven-ports/db.ts",
  "src/application/order.ts",
  "src/driving-adapters/http.ts",
  "src/driven-adapters/db.ts",
  "src/other/a.ts",
  "src//a.ts",
  "other/orders/a.ts",
  "src\\orders\\index.ts",
  "",
  "src/orders/\ud800/a.ts",
];
function add(id: string, input: Partial<Input> = {}) {
  cases.push({
    id,
    operation: "code_graph.zoning",
    input: {
      rules: {},
      scopes: ["app"],
      files,
      folders: [],
      held: [],
      ...input,
    },
  });
}
add("empty-declaration");
add("per-feature", { rules: { features: { app: ["orders"] } } });
add("feature-before-lib", { rules: { features: { app: ["orders", "lib"] } } });
add("custom-lib", { rules: { lib: ["other", "other"] } });
add("port-complete", {
  rules: {
    features: { app: ["application", "driving-adapters", "driven-adapters"] },
  },
});
add("mixed-layout-helpers", {
  rules: { features: { app: ["orders", "application"] } },
});
add("shared-zone-rule-owners", {
  rules: {
    features: {
      feature: ["orders"],
      port: ["application", "driving-adapters", "driven-adapters"],
    },
  },
  scopes: ["feature", "port"],
});
add("scope-is-feature-name-in-port-layout", {
  rules: {
    features: {
      "apps/api": ["application", "driving-adapters", "driven-adapters"],
    },
  },
  scopes: ["apps/api", ".", "elsewhere"],
});
add("raw-utf16-paths", {
  rules: { features: { "\ud800": ["\udfff"] }, lib: ["\ud800"] },
  scopes: ["\ud800"],
  files: [
    "src/\udfff/ports.ts",
    "src/\udfff/adapters/driven/db.ts",
    "src/\udfff/\ud800/a.ts",
    "src/\ud800/x.ts",
  ],
  folders: ["application", "\ud800"],
  held: ["application"],
});
add("raw-utf16-port-scope", {
  rules: {
    features: {
      "\ud800": ["application", "driving-adapters", "driven-adapters"],
    },
  },
  scopes: ["\ud800"],
});
add("missing-inherited-record-value", {
  scopes: [
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "__defineGetter__",
    "__lookupSetter__",
    "valueOf",
    "toLocaleString",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "__defineSetter__",
    "__lookupGetter__",
  ],
});
add("own-prototype-named-scope", {
  rules: {
    features: Object.fromEntries(
      ["toString", "constructor", "__proto__"].map((scope) => [
        scope,
        ["orders"],
      ]),
    ),
  },
  scopes: ["toString", "constructor", "__proto__"],
});
for (let mask = 0; mask < 8; mask++) {
  const folders = ["application", "driving-adapters", "driven-adapters"].filter(
    (_, index) => (mask & (1 << index)) !== 0,
  );
  add(`port-subset-${mask}`, {
    rules: { features: { app: folders } },
    folders,
    held: ["application", "driving-adapters", "driven-adapters", "lib"],
  });
}
for (const [index, folders] of [
  ["application", "orders"],
  ["orders", "driven-adapters", "another"],
  ["application", "application"],
  ["driving-adapters", "driven-adapters", "application"],
  ["application/driving-ports"],
  ["Application"],
  ["application", "\ud800"],
].entries())
  add(`layout-message-${index}`, {
    folders,
    held: ["application", "driven-adapters"],
  });
for (const scope of [".", "", "apps/api", "apps/", "../outside", "\ud800"])
  add(`location-${JSON.stringify(scope)}`, {
    scopes: [scope],
    files: ["src/a.ts", "", "/absolute.ts", "../other.ts", "\udfff"],
    folders: [],
    held: ["driven-adapters"],
  });
const declarations: Partial<BoundaryRules>[] = [
  { libraryTypes: { pure: { imports: [], pure: true } } },
  { libraries: { "packages/a": "pure" } },
  { libraryRoots: ["packages"] },
  { worldLibraries: ["world/*"] },
  { allowImportNames: { a: { b: ["read"] } } },
  { acrossDeployables: ["worker-call-cycle"] },
  { bindingOwners: { app: { DB: ["src/driven.ts"] } } },
  { applicationShape: ["index-not-exports-only"] },
  { readAllowance: { app: { driven: [] } } },
  { compositionRoots: ["src/worker.ts"] },
];
for (const [index, rules] of declarations.entries())
  add(`declares-${index}`, { rules });
function reference(input: Input) {
  // These helpers consume prepared typed rules. BoundaryRulesSchema validation
  // is a separate contract; this suite also exercises directly authored records.
  const rules: BoundaryRules = { ...defaults, ...input.rules };
  const owners = new Map<object, number>();
  const ruleOwners: (number | null)[][] = [];
  const rows = input.scopes.map((scope) => {
    const located = input.files.map((file) => inScope(scope, file));
    const issue = layoutIssue(scope, input.folders);
    const unlisted = unlistedPortFolderIssue(scope, input.folders, input.held);
    try {
      const zoning = scopeZoning(rules, scope);
      const features = input.files.map((file) => featureFileOf(file, zoning));
      const places = input.files.map((file) => placeOf(file, zoning));
      ruleOwners.push(
        features.map((feature) => {
          if (feature === null) return null;
          const rule = feature.zone.rule;
          const held = owners.get(rule);
          if (held !== undefined) return held;
          const id = owners.size;
          owners.set(rule, id);
          return id;
        }),
      );
      return {
        scope,
        zoning: {
          ...zoning,
          features: [...zoning.features],
          lib: [...zoning.lib],
        },
        features,
        places,
        located,
        layoutIssue: issue,
        unlistedIssue: unlisted,
        error: null,
      };
    } catch (error) {
      assert.ok(error instanceof Error);
      ruleOwners.push([]);
      return {
        scope,
        zoning: null,
        features: [],
        places: [],
        located,
        layoutIssue: issue,
        unlistedIssue: unlisted,
        error: { name: error.name, message: error.message },
      };
    }
  });
  return {
    homes: DRIVEN_HOMES,
    rows,
    ruleOwners,
    declared: [
      declaresLibraries(rules),
      declaresDeployables(rules),
      declaresReadAllowance(rules),
    ],
  };
}
const expected = cases.map((test) => ({
  id: test.id,
  ok: true,
  output: reference(test.input),
}));
assert.equal(
  expected.find((test) => test.id === "per-feature")?.output.rows[0].features[0]
    ?.layout,
  "per-feature",
);
const invalid = [
  "not json",
  JSON.stringify({ id: "missing", operation: "code_graph.zoning", input: {} }),
  JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
  JSON.stringify({
    ...cases[0],
    id: "invalid-fields",
    input: { ...cases[0].input, files: false },
  }),
];
const schema = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  diagnostic: z.string().optional(),
  observedCalls: z.array(z.string()),
});
const run = spawnSync(binary, [], {
  input: `${[...cases.map((test) => JSON.stringify(test)), ...invalid].join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  timeout: 30_000,
});
assert.equal(run.status, 0, run.stderr);
const answers = run.stdout
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
for (const [index, expectedAnswer] of expected.entries()) {
  try {
    const { observedCalls: _calls, ...actual } = answers[index];
    assert.deepEqual(actual, expectedAnswer, cases[index].id);
    assert.ok(answers[index].observedCalls.length > 0);
  } catch (error) {
    failures.push({
      id: cases[index].id,
      message: error instanceof Error ? error.message : String(error),
      reference: expectedAnswer,
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
const proof = {
  reference: { node: process.version, v8: process.versions.v8 },
  passed: cases.length - failures.length,
  attempted: cases.length,
  failures,
  rejectedInvalidInputs: invalid.length,
  nativeApis: [
    ...new Set(answers.flatMap((answer) => answer.observedCalls)),
  ].sort(),
  qualifications: [
    "Prepared typed rules and zoning only; full BoundaryRulesSchema validation remains separate.",
  ],
  cases: answers,
};
if (process.argv[3])
  fs.writeFileSync(process.argv[3], `${JSON.stringify(proof, null, 2)}\n`);
console.log(
  JSON.stringify(
    { ...proof, cases: undefined, failures: failures.slice(0, 3) },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
