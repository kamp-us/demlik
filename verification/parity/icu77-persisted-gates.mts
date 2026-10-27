import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ScopeBoundaryReport } from "../../packages/code-graph/src/boundaries/analyze.js";
import type {
  BoundaryLedgerEntry,
  FileMove,
} from "../../packages/code-graph/src/boundaries/ledger.js";
import {
  BOUNDARY_KINDS,
  boundaryLedgerOf,
  LEDGER_FILENAME,
  ledgerKey,
  ledgerTargetOf,
  parseBoundaryLedger,
  readBoundaryLedger,
  rekeyBoundaryLedger,
  rekeyBoundaryLedgerFile,
  serializeBoundaryLedger,
  writeBoundaryLedger,
} from "../../packages/code-graph/src/boundaries/ledger.js";
import { migratedLedger } from "../../packages/code-graph/src/boundaries/migrate.js";
import {
  entryOf,
  measuredEntries,
  reconcile as reconcileBoundary,
  withAccepted,
} from "../../packages/code-graph/src/boundaries/reconcile.js";
import { crossingOf } from "../../packages/code-graph/src/boundaries/violation.js";
import type {
  LayerEdge,
  LayerReport,
} from "../../packages/code-graph/src/layers/analyze.js";
import { reconcile as reconcileLayers } from "../../packages/code-graph/src/layers/reconcile.js";
import type { AllowedEdge } from "../../packages/code-graph/src/layers/rules.js";
import type { ScopeCountCeilings } from "../../packages/code-graph/src/ratchet/scope-count.js";
import type { ScopeCountInput } from "./scope-count-reference.mjs";
import { scopeCountReference } from "./scope-count-reference.mjs";

const [manifestFile, reportFile] = process.argv.slice(2);
assert.ok(manifestFile && reportFile && process.argv.length === 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const binaries = z
  .record(z.string(), z.string().min(1))
  .parse(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-icu77-gates-")),
);
const units = ["\ue000", "\udfff", "\ud800", "𐀀", "�"];
const ordered = ["𐀀", "\ud800", "\udfff", "\ue000", "�"];
// Independent literals catch a changed backend or accidental numeric collation.
assert.deepEqual(
  [...units].sort((a, b) => a.localeCompare(b)),
  ordered,
);
assert.deepEqual(
  ["file2", "file10"].sort((a, b) => a.localeCompare(b)),
  ["file10", "file2"],
);
assert.equal("é".localeCompare("e\u0301"), 0);
type Item = {
  id: string;
  driver: string;
  operation: string;
  input: unknown;
  expected: unknown;
};
const cases: Item[] = [];
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const entry = (
  fields: Partial<BoundaryLedgerEntry> = {},
): BoundaryLedgerEntry => ({
  scope: "app",
  kind: "impure",
  from: "a",
  to: null,
  specifier: "fetch",
  ...fields,
});
function pure(
  id: string,
  entries: BoundaryLedgerEntry[],
  moves: FileMove[] = [],
) {
  const ledger = boundaryLedgerOf(entries);
  const moved = rekeyBoundaryLedger(ledger, moves);
  cases.push({
    id,
    driver: "ledger_driver",
    operation: "code_graph.ledger.pure",
    input: { entries, moves },
    expected: wire({
      kinds: BOUNDARY_KINDS,
      filename: LEDGER_FILENAME,
      keys: entries.map(ledgerKey),
      targets: entries.map(ledgerTargetOf),
      ledger,
      moved,
      json: serializeBoundaryLedger(ledger),
      picked: ledger.entries.map((held) => entries.indexOf(held)),
    }),
  });
}
function parsed(id: string, entries: BoundaryLedgerEntry[]) {
  const text = JSON.stringify({ entries });
  cases.push({
    id,
    driver: "ledger_driver",
    operation: "code_graph.ledger.parse",
    input: { text },
    expected: parseBoundaryLedger(text),
  });
}
function scope(id: string, input: ScopeCountInput) {
  cases.push({
    id,
    driver: "scope_count_driver",
    operation: "code_graph.scope-count",
    input,
    expected: wire(scopeCountReference(input)),
  });
}
function layer(
  id: string,
  violations: LayerEdge[],
  allowed: AllowedEdge[] = [],
) {
  const report: LayerReport = {
    layers: ["domain", "host"],
    filesScanned: violations.length,
    census: {
      up: violations.length,
      down: 0,
      sideways: 0,
      unlayered: 0,
      external: 0,
      unresolved: 0,
    },
    violations,
    unresolved: [],
  };
  cases.push({
    id,
    driver: "layer_driver",
    operation: "code_graph.layer_reconcile",
    input: { report, allowed },
    expected: reconcileLayers(report, allowed),
  });
}
const edge = (from: string, to = "target", fromLine = 2): LayerEdge => ({
  from,
  fromLine,
  fromLayer: "domain",
  to,
  toLine: 1,
  toLayer: "host",
  specifier: "./target",
  typeOnly: false,
});
const allow = (from: string, to = "target", sites = 2): AllowedEdge => ({
  from,
  to,
  sites,
  reason: "reviewed",
});
const violation = (
  from: string,
): ScopeBoundaryReport["violations"][number] => ({
  kind: "impure",
  from,
  to: null,
  specifier: "fetch",
  typeOnly: false,
});
const report = (scope: string, from: string[]): ScopeBoundaryReport => ({
  scope,
  features: ["api"],
  filesScanned: from.length,
  violations: from.map(violation),
});
type BoundaryInput = {
  ledger: readonly BoundaryLedgerEntry[];
  reports: readonly ScopeBoundaryReport[];
  accepted: readonly BoundaryLedgerEntry[];
  under: string;
  reason: string;
  ceilings: ScopeCountCeilings;
};
function boundary(id: string, partial: Partial<BoundaryInput>) {
  const input: BoundaryInput = {
    ledger: [],
    reports: [],
    accepted: [],
    under: ".",
    reason: "reviewed",
    ceilings: { default: 99, scopes: {} },
    ...partial,
  };
  const ledger = { entries: input.ledger };
  const result = reconcileBoundary(ledger, input.reports, input.under);
  const writes = input.reports.flatMap((r) =>
    r.violations.flatMap((v) =>
      v.kind === "driving-reaches-driven" && v.write ? [v.write] : [],
    ),
  );
  cases.push({
    id,
    driver: "reconcile_driver",
    operation: "code_graph.reconcile",
    input,
    expected: wire({
      entries: input.reports.flatMap((r) =>
        r.violations.map((v) => entryOf(r.scope, v)),
      ),
      measured: measuredEntries(input.reports),
      reconciliation: { ...result, writes: Object.fromEntries(result.writes) },
      accepted: withAccepted(ledger, input.accepted, input.reason),
      migration: migratedLedger(input.reports, input.ceilings),
      crossings: input.reports.flatMap((r) => r.violations.map(crossingOf)),
      keptOwners: result.kept.entries.map((e) => input.ledger.indexOf(e)),
      prunedOwners: result.pruned.map((e) => input.ledger.indexOf(e)),
      writeOwners: [...result.writes.values()].map((w) => writes.indexOf(w)),
    }),
  });
}
const responseSchema = z
  .object({
    id: z.string(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    observedCalls: z.array(z.string()),
  })
  .strict();
type Answer = z.infer<typeof responseSchema>;
type Row = Item & {
  actual?: Answer;
  passed: boolean;
  failure?: string;
  qualifications: [];
  nativeTrace: { observedCalls: string[] };
  process: {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  };
};
const rows: Row[] = [],
  failures: { id: string; failure: string }[] = [];
function run(item: Item) {
  const child = spawnSync(binaries[item.driver], [], {
    input: `${JSON.stringify({ id: item.id, operation: item.operation, input: item.input })}\n`,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });
  let actual: Answer | undefined;
  let failure: string | undefined;
  try {
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    const lines = child.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 1);
    actual = responseSchema.parse(JSON.parse(lines[0]));
    assert.equal(actual.id, item.id);
    assert.equal(actual.ok, true, JSON.stringify(actual));
    assert.ok(actual.observedCalls.length > 0);
    assert.deepEqual(actual.output, wire(item.expected));
  } catch (error) {
    failure = String(error);
    failures.push({ id: item.id, failure });
  }
  rows.push({
    ...item,
    actual,
    passed: !failure,
    failure,
    qualifications: [],
    nativeTrace: { observedCalls: actual?.observedCalls ?? [] },
    process: {
      status: child.status,
      signal: child.signal,
      stdout: child.stdout,
      stderr: child.stderr,
    },
  });
  return actual?.output;
}
try {
  for (const field of ["scope", "from", "specifier", "to"]) {
    const entries = units.map((text) => entry({ [field]: text }));
    pure(`icu77-b.ledger.mixed-${field}`, entries);
    parsed(`icu77-b.parse.mixed-${field}`, entries);
  }
  pure("icu77-b.ledger.numeric-off", [
    entry({ from: "file2" }),
    entry({ from: "file10" }),
  ]);
  pure("icu77-b.ledger.canonical-stable", [
    entry({ from: "é" }),
    entry({ from: "e\u0301" }),
  ]);
  pure("icu77-b.ledger.first-reason", [
    entry(),
    entry({ reason: "first" }),
    entry({ reason: "later" }),
  ]);
  pure(
    "icu77-b.ledger.move-collision",
    [
      entry({ from: "z", reason: "first" }),
      entry({ from: "a", reason: "second" }),
      entry({ from: "unmoved" }),
    ],
    [{ from: "z", to: "a" }],
  );
  for (const [id, scopes] of [
    ["mixed", units],
    ["numeric-off", ["file2", "file10"]],
    ["canonical-stable", ["é", "e\u0301"]],
  ] as const) {
    scope(`icu77-b.scope.${id}`, {
      action: "paths",
      repoRoot: directory,
      absolute: directory,
      scopes: [...scopes],
      under: ".",
    });
    scope(`icu77-b.verdict.${id}`, {
      action: "evaluate",
      measurements: scopes.map((scope) => ({ scope, count: 1 })),
      ceilings: { default: 0, scopes: [] },
      title: "Gate",
    });
  }
  scope("icu77-b.scope.slash-membership", {
    action: "paths",
    repoRoot: directory,
    absolute: directory,
    scopes: ["app/2", "apps", "app/10", "app", "app/é", "app/e\u0301"],
    under: "app",
  });
  scope("icu77-b.verdict.v8-nan-schedule", {
    action: "evaluate",
    measurements: Array.from({ length: 79 }, (_, i) => ({
      scope: `${units[i % units.length]}-${i % 11}`,
      count: i % 7 === 0 ? "NaN" : i % 13,
    })),
    ceilings: { default: 2, scopes: [["\ue000-1", "NaN"]] },
    title: "Gate",
  });
  layer(
    "icu77-b.layers.undeclared-mixed",
    units.map((from) => edge(from)),
  );
  layer("icu77-b.layers.numeric-off", [edge("file2"), edge("file10")]);
  layer("icu77-b.layers.canonical-stable", [edge("é"), edge("e\u0301")]);
  layer(
    "icu77-b.layers.miscounted-mixed",
    units.map((from) => edge(from)),
    units.map((from) => allow(from)),
  );
  layer(
    "icu77-b.layers.stale-mixed",
    [],
    units.map((from) => allow(from)),
  );
  layer(
    "icu77-b.layers.last-declaration",
    [edge("a b", "c"), edge("a", "b c")],
    [allow("a b", "c", 1), allow("a", "b c", 2)],
  );
  for (const [id, input] of [
    [
      "mixed-scopes",
      { reports: units.map((s) => report(s, ["a"])), ledger: [] },
    ],
    ["mixed-from", { reports: [report("app", units)], ledger: [] }],
    [
      "kept-pruned-slash",
      {
        reports: [report("app", ["new"])],
        ledger: [
          entry({ scope: "apps", reason: "outside" }),
          entry({ from: "gone" }),
        ],
      },
    ],
    [
      "first-reason-accept",
      {
        reports: [],
        ledger: [entry({ reason: "first" })],
        accepted: [entry({ reason: "later" }), entry({ from: "new" })],
      },
    ],
  ] as const)
    boundary(`icu77-b.reconcile.${id}`, input);
  for (const item of cases) run(item);
  // One real multi-scope parse -> reconcile -> accept -> persist -> read/rekey lifecycle.
  const reports = [
    report("app/a", units),
    report("app/b", ["file2", "file10"]),
  ];
  const initial = boundaryLedgerOf([
    entry({ scope: "other", from: "keep", reason: "outside" }),
    entry({ scope: "app/a", from: "gone" }),
  ]);
  const reconciled = reconcileBoundary(initial, reports, "app");
  const accepted = withAccepted(
    reconciled.kept,
    reconciled.unrecorded,
    "reviewed\ud800",
  );
  const file = path.join(directory, "boundary-ledger.json");
  const fileInput = {
    path: file,
    initial: null,
    moves: [],
    writeEntries: accepted.entries,
  };
  writeBoundaryLedger(file, accepted);
  const before = readBoundaryLedger(file);
  const rekey = rekeyBoundaryLedgerFile(file, []);
  const after = readBoundaryLedger(file);
  const expected = {
    before,
    rekey,
    after,
    text: fs.readFileSync(file, "utf8"),
    exists: true,
  };
  fs.rmSync(file);
  run({
    id: "icu77-b.workflow.accept-write-two-scopes",
    driver: "ledger_driver",
    operation: "code_graph.ledger.file",
    input: fileInput,
    expected,
  });
  assert.equal(expected.after.kind, "read");
  assert.equal(
    expected.after.kind === "read" ? expected.after.ledger.entries.length : -1,
    8,
  );
  const out = {
    attempted: rows.length,
    passed: rows.length - failures.length,
    strict: rows.length - failures.length,
    qualified: 0,
    rejectedInvalidInputs: 0,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      icu: process.versions.icu,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    },
    anchors: {
      mixed: ordered,
      numericOff: ["file10", "file2"],
      canonicalEquivalentStable: ["é", "e\u0301"],
      workflowEntries: 8,
    },
    binaryHashes: Object.fromEntries(
      Object.entries(binaries).map(([name, value]) => [
        name,
        hash(fs.readFileSync(value as string)),
      ]),
    ),
    failures,
    cases: rows,
    nativeEvidence: Object.fromEntries(
      rows
        .filter((row) => row.passed)
        .map((row) => [row.id, row.nativeTrace.observedCalls]),
    ),
    qualifiedNativeEvidence: {},
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    JSON.stringify({ attempted: out.attempted, passed: out.passed, failures }),
  );
  assert.deepEqual(failures, []);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
