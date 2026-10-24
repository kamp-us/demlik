import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import type { ScopeBoundaryReport } from "../../packages/code-graph/src/boundaries/analyze.js";
import {
  BOUNDARY_KINDS,
  type BoundaryLedgerEntry,
} from "../../packages/code-graph/src/boundaries/ledger.js";
import { migratedLedger } from "../../packages/code-graph/src/boundaries/migrate.js";
import {
  entryOf,
  measuredEntries,
  reconcile,
  withAccepted,
} from "../../packages/code-graph/src/boundaries/reconcile.js";
import {
  type BoundaryKind,
  type BoundaryViolation,
  crossingOf,
} from "../../packages/code-graph/src/boundaries/violation.js";
import type { ScopeCountCeilings } from "../../packages/code-graph/src/ratchet/scope-count.js";

type Input = {
  ledger: BoundaryLedgerEntry[];
  reports: ScopeBoundaryReport[];
  under: string;
  accepted: BoundaryLedgerEntry[];
  reason: string;
  ceilings: ScopeCountCeilings;
};
type Case = { id: string; operation: "code_graph.reconcile"; input: Input };
const cases: Case[] = [];
const binary = process.argv[2];
assert.ok(binary, "provide the native reconciliation driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const base = { from: "src/a.ts", specifier: "./b", typeOnly: false };
function violation(kind: BoundaryKind): BoundaryViolation {
  switch (kind) {
    case "cross-feature":
      return {
        ...base,
        kind,
        to: "src/b.ts",
        fromFeature: "first",
        toFeature: "second",
      };
    case "lib-imports-feature":
    case "outside-imports-feature-internal":
      return { ...base, kind, to: "src/b.ts", toFeature: "second" };
    case "application-imports-adapter":
    case "driving-reaches-driven":
      return { ...base, kind, to: "src/b.ts", feature: "first" };
    case "impure":
    case "application-import-outside-allowlist":
      return { ...base, kind, to: null };
    case "index-not-exports-only":
    case "library-undeclared":
    case "binding-outside-driven-adapter":
    case "worker-call-cycle":
      return { ...base, kind, to: null, typeOnly: false };
    case "unknown-zone":
      return { ...base, kind, to: null, typeOnly: false, feature: "first" };
    case "adapter-library-imported-outside-driven":
    case "library-imports-up":
    case "relative-import-crosses-workspace":
      return { ...base, kind, to: "src/b.ts" };
    case "test-reaches-composition-root":
      return { ...base, kind, to: "src/b.ts", typeOnly: false };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
function report(
  scope: string,
  violations: BoundaryViolation[],
): ScopeBoundaryReport {
  return { scope, features: ["first", "second"], filesScanned: 3, violations };
}
const crossing = {
  ...base,
  kind: "cross-feature",
  to: "src/b.ts",
  fromFeature: "first",
  toFeature: "second",
} satisfies BoundaryViolation;
const entry = entryOf("app", crossing);
function add(id: string, input: Partial<Input> = {}) {
  cases.push({
    id,
    operation: "code_graph.reconcile",
    input: {
      ledger: [],
      reports: [],
      under: ".",
      accepted: [],
      reason: "intentional crossing",
      ceilings: { default: 0, scopes: {} },
      ...input,
    },
  });
}
function reference(input: Input) {
  const ledger = { entries: input.ledger };
  const result = reconcile(ledger, input.reports, input.under);
  const writes = input.reports.flatMap((report) =>
    report.violations.flatMap((violation) =>
      violation.kind === "driving-reaches-driven" && violation.write
        ? [violation.write]
        : [],
    ),
  );
  return {
    entries: input.reports.flatMap((report) =>
      report.violations.map((violation) => entryOf(report.scope, violation)),
    ),
    measured: measuredEntries(input.reports),
    reconciliation: { ...result, writes: Object.fromEntries(result.writes) },
    accepted: withAccepted(ledger, input.accepted, input.reason),
    migration: migratedLedger(input.reports, input.ceilings),
    crossings: input.reports.flatMap((report) =>
      report.violations.map(crossingOf),
    ),
    keptOwners: result.kept.entries.map((entry) => input.ledger.indexOf(entry)),
    prunedOwners: result.pruned.map((entry) => input.ledger.indexOf(entry)),
    writeOwners: [...result.writes.values()].map((write) =>
      writes.indexOf(write),
    ),
  };
}
add("empty");
for (const kind of BOUNDARY_KINDS) {
  add(`kind-${kind}`, { reports: [report("app", [violation(kind)])] });
  add(`kind-${kind}-at-ceiling`, {
    reports: [report("app", [violation(kind)])],
    ceilings: { default: 1, scopes: {} },
  });
}
add("count-duplicates-before-dedup", {
  reports: [report("app", [crossing, crossing])],
  ceilings: { default: 1, scopes: {} },
});
add("measured-collision-ignores-specifier", {
  reports: [
    report("app", [crossing, { ...crossing, specifier: "another alias" }]),
  ],
  ceilings: { default: 2, scopes: {} },
});
add("original-reason-survives-accept", {
  ledger: [{ ...entry, reason: "first reason" }],
  accepted: [entry],
  reason: "later reason",
});
add("accept-creates-reason", { ledger: [entry], accepted: [entry] });
add("accept-empty-reason", { accepted: [entry], reason: "" });
add("accept-lone-reason", { accepted: [entry], reason: "\ud800" });
add("accept-order-and-dedup", {
  accepted: [entry, { ...entry, from: "z" }, { ...entry, from: "a" }, entry],
});
add("new-crossing-keeps-old-alias", {
  ledger: [{ ...entry, reason: "kept", specifier: "old alias" }],
  reports: [report("app", [{ ...crossing, specifier: "new alias" }])],
});
for (const under of [".", "app", "app/child", "a", "app/", "", "\ud800"]) {
  add(`scope-${JSON.stringify(under)}`, {
    ledger: [
      "app",
      "app/child",
      "app/child/grand",
      "apps",
      "app/",
      "a",
      "",
      "\ud800",
      "\ud800/x",
    ].map((scope) => ({ ...entry, scope, reason: "recorded" })),
    under,
  });
}
for (const scope of [
  "app",
  "toString",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "__defineGetter__",
  "__lookupSetter__",
  "toLocaleString",
  "valueOf",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineSetter__",
  "__lookupGetter__",
  "\ud800",
]) {
  add(`default-${JSON.stringify(scope)}`, {
    reports: [report(scope, [crossing])],
  });
  add(`own-${JSON.stringify(scope)}`, {
    reports: [report(scope, [crossing])],
    ceilings: { default: 9, scopes: { [scope]: 0 } },
  });
}
add("reports-preserve-refusal-order", {
  reports: [
    report("z", [crossing]),
    report("a", [crossing]),
    report("é", [crossing]),
  ],
});
add("same-scope-reports-count-separately", {
  reports: [report("app", [crossing]), report("app", [crossing])],
  ceilings: { default: 1, scopes: {} },
});
add("unmeasured-scope-pruned-under-root", { ledger: [entry], reports: [] });
add("checked-scope-does-not-imply-report-filter", {
  ledger: [entry],
  reports: [report("outside", [crossing])],
  under: "app",
});
add("unicode-in-source-identity", {
  reports: [
    report("\ud800", [
      { ...crossing, from: "\udfff", to: "\ud800", specifier: "\udfff" },
    ]),
  ],
  accepted: [{ ...entry, from: "\ud800", specifier: "\udfff" }],
});
add("unicode-sort-and-dedup", {
  reports: [
    report(
      "app",
      ["z", "Z", "ä", "a", "é", "e", "😀", "\ud800"].map((from) => ({
        ...crossing,
        from,
      })),
    ),
  ],
  ceilings: { default: 8, scopes: {} },
});
const firstWrite = { file: "driven.ts", line: 7, binding: "DB" };
const laterWrite = { file: "other.ts", line: 11, binding: "API" };
const driving: BoundaryViolation = {
  kind: "driving-reaches-driven",
  ...base,
  to: "driven.ts",
  feature: "first",
  write: firstWrite,
};
add("latest-write-owner-wins", {
  reports: [report("app", [driving, { ...driving, write: laterWrite }])],
  ceilings: { default: 2, scopes: {} },
});
add("missing-write-does-not-clear-owner", {
  reports: [report("app", [driving, { ...driving, write: undefined }])],
  ceilings: { default: 2, scopes: {} },
});
add("two-keys-write-order", {
  reports: [
    report("app", [
      driving,
      { ...driving, from: "z", write: laterWrite },
      { ...driving, write: { ...laterWrite } },
    ]),
  ],
  ceilings: { default: 3, scopes: {} },
});
add("workers-report", {
  reports: [
    {
      ...report(".", [violation("worker-call-cycle")]),
      workers: ["api", "queue"],
    },
  ],
});
add("all-kinds", {
  reports: [report("app", BOUNDARY_KINDS.map(violation))],
  ceilings: { default: 5, scopes: {} },
});
const expected = cases.map((test) => ({
  id: test.id,
  ok: true,
  output: reference(test.input),
}));
assert.equal(
  expected.find((test) => test.id === "count-duplicates-before-dedup")?.output
    .migration.kind,
  "refused",
);
assert.equal(
  expected.find((test) => test.id === 'default-"toString"')?.output.migration
    .kind,
  "migrated",
);
assert.deepEqual(
  expected.find((test) => test.id === "latest-write-owner-wins")?.output
    .writeOwners,
  [1],
);
const invalid = [
  "not json",
  JSON.stringify({ id: "unsupported", operation: "invented", input: {} }),
  JSON.stringify({
    id: "missing",
    operation: "code_graph.reconcile",
    input: {},
  }),
  JSON.stringify({
    ...cases[0],
    id: "invalid-literal",
    input: {
      ...cases[0].input,
      reports: [report("app", [violation("unknown-zone")])].map((report) => ({
        ...report,
        violations: report.violations.map((violation) => ({
          ...violation,
          typeOnly: true,
        })),
      })),
    },
  }),
];
const response = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  diagnostic: z.string().optional(),
  observedCalls: z.array(z.string()),
});
const result = spawnSync(binary, [], {
  input: `${[...cases.map((test) => JSON.stringify(test)), ...invalid].join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  timeout: 30_000,
});
assert.equal(result.status, 0, result.stderr);
const answers = result.stdout
  .trim()
  .split("\n")
  .map((line) => response.parse(JSON.parse(line)));
assert.equal(answers.length, cases.length + invalid.length);
const failures: {
  id: string;
  message: string;
  reference: unknown;
  native: unknown;
}[] = [];
for (const [index, test] of expected.entries()) {
  try {
    const { observedCalls: _calls, ...actual } = answers[index];
    assert.deepEqual(actual, test, test.id);
    const writeMap = z
      .object({
        reconciliation: z.object({ writes: z.record(z.string(), z.unknown()) }),
      })
      .parse(answers[index].output);
    assert.deepEqual(
      Object.keys(writeMap.reconciliation.writes),
      Object.keys(test.output.reconciliation.writes),
      `${test.id}: diagnostic insertion order`,
    );
    assert.ok(answers[index].observedCalls.length > 0);
  } catch (error) {
    failures.push({
      id: test.id,
      message: error instanceof Error ? error.message : String(error),
      reference: test,
      native: answers[index],
    });
  }
}
for (const answer of answers.slice(cases.length)) {
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "driver_error");
  assert.ok(answer.diagnostic?.length);
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
  cases: answers,
  qualifications: [
    "Ceiling numeric records preserve standard Object.prototype properties. Mutating global prototypes is outside the pristine-builtins profile.",
  ],
};
if (process.argv[3])
  fs.writeFileSync(process.argv[3], `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify({ ...proof, cases: undefined }, null, 2));
if (failures.length) process.exitCode = 1;
