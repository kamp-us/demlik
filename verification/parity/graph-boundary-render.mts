import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import { BOUNDARY_KINDS } from "../../packages/code-graph/src/boundaries/ledger.js";
import {
  boundaryRenderReference,
  type Operation,
  type RenderCase,
  renderCase,
  type Scalar,
  violationSchema,
} from "./boundary-render-reference.mjs";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled boundary render driver");
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");

const cases: RenderCase[] = [];
function add(id: string, operation: Operation, input: unknown) {
  const item = renderCase(id, operation, input);
  cases.push(item);
  return item;
}
const scope = "services/api";
const emptyLibrary = { types: {}, undeclared: [], unjudgedImports: 0 };
const emptyDeployable = { workers: [], unresolvedServiceBindings: 0 };
const noCensuses = { libraries: null, deployables: null };
const report = {
  scope,
  features: ["orders", "billing"],
  filesScanned: 7,
  violations: [],
};
const ledger = { entries: [] };
const state = {
  kind: "opaque",
  scopesChecked: 2,
  unrecorded: [],
  pruned: [],
  kept: ledger,
  writes: [],
};
const formats = [
  { json: false, pretty: false },
  { json: false, pretty: true },
  { json: true, pretty: false },
  { json: true, pretty: true },
];
function boundary(id: string, input: unknown) {
  return add(id, "code_graph.boundary-render", input);
}
function gate(id: string, result: unknown, format = formats[0]) {
  return add(id, "code_graph.boundary-ledger-render", { result, ...format });
}
function accepted(
  id: string,
  result: unknown,
  reason = "documented",
  format = formats[0],
) {
  return add(id, "code_graph.boundary-accepted-render", {
    result,
    reason,
    ...format,
  });
}
function migrated(
  id: string,
  ownLedger: unknown,
  scopes: Scalar,
  format = formats[0],
) {
  return add(id, "code_graph.boundary-migrated-render", {
    ledger: ownLedger,
    scopes,
    ...format,
  });
}

const specialFields = {
  "cross-feature": {
    to: "src/billing/private.ts",
    fromFeature: "orders",
    toFeature: "billing",
  },
  impure: { to: null, specifier: "Date.now" },
  "lib-imports-feature": { to: "src/orders/index.ts", toFeature: "orders" },
  "outside-imports-feature-internal": {
    to: "src/orders/private.ts",
    toFeature: "orders",
  },
  "application-imports-adapter": {
    to: "src/orders/adapters/driven/db.ts",
    feature: "orders",
  },
  "driving-reaches-driven": {
    to: "src/orders/adapters/driven/db.ts",
    feature: "orders",
  },
  "index-not-exports-only": {
    to: null,
    typeOnly: false,
    specifier: "declaration",
  },
  "application-import-outside-allowlist": { to: null, specifier: "hono" },
  "unknown-zone": {
    to: null,
    typeOnly: false,
    feature: "orders",
    specifier: "misc",
  },
  "library-undeclared": {
    to: null,
    typeOnly: false,
    specifier: "packages/stray",
  },
  "library-imports-up": { to: "packages/ui/src/index.ts" },
  "adapter-library-imported-outside-driven": {
    to: "packages/adapter/src/index.ts",
  },
  "binding-outside-driven-adapter": {
    to: null,
    typeOnly: false,
    specifier: "DB",
  },
  "worker-call-cycle": {
    to: null,
    typeOnly: false,
    specifier: "api -> jobs -> api",
  },
  "relative-import-crosses-workspace": { to: "services/jobs/src/index.ts" },
  "test-reaches-composition-root": { to: "src/index.ts", typeOnly: false },
};
const violations = BOUNDARY_KINDS.map((kind) =>
  violationSchema.parse({
    from: "src/orders/application/use.ts",
    specifier: "./target",
    typeOnly: true,
    kind,
    ...specialFields[kind],
  }),
);
const entries = violations.map(({ kind, from, to, specifier }) => ({
  scope,
  kind,
  from,
  to,
  specifier,
}));
const first = entries[0];
const b8 = entries.find((entry) => entry.kind === "driving-reaches-driven");
assert.ok(b8);
const write = {
  file: "src/orders/adapters/driven/db.ts",
  line: 3,
  binding: "DB",
};

for (let n = 0; n < formats.length; n++) {
  const format = formats[n];
  for (const [label, censuses] of [
    ["unrequested", noCensuses],
    ["library", { libraries: emptyLibrary, deployables: null }],
    ["deployable", { libraries: null, deployables: emptyDeployable }],
    ["both", { libraries: emptyLibrary, deployables: emptyDeployable }],
  ] as const) {
    boundary(`no-scopes-${label}-${n}`, {
      reports: [],
      under: "services/\ud800",
      censuses,
      ...format,
    });
    boundary(`scoped-${label}-${n}`, {
      reports: [report],
      under: ".",
      censuses,
      ...format,
    });
  }
  for (const [label, ownReport] of [
    ["library", { ...report, features: [] }],
    ["empty-workers", { ...report, workers: [] }],
    ["workers", { ...report, workers: ["api", "jobs"] }],
    [
      "raw-features",
      {
        ...report,
        scope: "services/\udfff",
        features: ["", "orders\ud800", "emoji😀", "line\nfeed"],
      },
    ],
  ] as const) {
    boundary(`scope-header-${label}-${n}`, {
      reports: [ownReport],
      under: ".",
      censuses: noCensuses,
      ...format,
    });
  }
  boundary(`all-kinds-${n}`, {
    reports: [
      { ...report, violations },
      { ...report, scope: "packages/core", features: [], violations: [] },
    ],
    under: ".",
    censuses: noCensuses,
    ...format,
  });
  gate(`gate-pass-${n}`, state, format);
  gate(`gate-fail-all-kinds-${n}`, { ...state, unrecorded: entries }, format);
  gate(
    `gate-pruned-one-${n}`,
    {
      ...state,
      kept: { entries: [first, first] },
      pruned: [{ ...first, reason: "stale" }],
    },
    format,
  );
  gate(
    `gate-pruned-many-${n}`,
    { ...state, unrecorded: [first], pruned: [first, entries[1]] },
    format,
  );
  accepted(`accept-empty-${n}`, state, "", format);
  accepted(
    `accept-existing-reason-${n}`,
    {
      ...state,
      unrecorded: [
        { ...first, reason: "old reason" },
        { ...b8, reason: "" },
      ],
      pruned: [first],
      writes: [{ entry: b8, write }],
    },
    "new reason",
    format,
  );
  migrated(`migrate-empty-${n}`, ledger, 0, format);
  migrated(
    `migrate-duplicates-${n}`,
    { entries: [first, first, ...entries] },
    3,
    format,
  );
}
for (const violation of violations) {
  boundary(`kind-${violation.kind}`, {
    reports: [{ ...report, violations: [violation] }],
    under: ".",
    censuses: noCensuses,
    ...formats[0],
  });
  if (violation.typeOnly)
    boundary(`runtime-kind-${violation.kind}`, {
      reports: [{ ...report, violations: [{ ...violation, typeOnly: false }] }],
      under: ".",
      censuses: noCensuses,
      ...formats[0],
    });
}

// All six optional advice groups, in deliberately reversed entry order and with duplicates.
const adviceKinds = [
  "application-imports-adapter",
  "impure",
  "library-imports-up",
  "worker-call-cycle",
  "index-not-exports-only",
  "test-reaches-composition-root",
];
for (let bits = 0; bits < 64; bits++) {
  const own = entries
    .filter((entry) =>
      adviceKinds.some(
        (kind, bit) => entry.kind === kind && (bits & (1 << bit)) !== 0,
      ),
    )
    .reverse();
  gate(`advice-subset-${bits}`, {
    ...state,
    unrecorded: [first, ...own, ...own],
  });
}

const richLibrary = {
  types: Object.fromEntries([
    ["z", ["packages/z"]],
    ["2", ["packages/two"]],
    ["1", []],
    ["01", ["packages/zero-one"]],
    ["__proto__", ["packages/proto"]],
    ["constructor", []],
    ["raw\ud800", ["packages/\udfff"]],
  ]),
  undeclared: ["packages/stray", "packages/stray", "packages/\udfff"],
  unjudgedImports: 1,
};
const richDeployable = {
  unresolvedServiceBindings: 1,
  workers: [
    {
      worker: "workers/\ud800",
      files: ["src/b.ts", "src/a.ts", "src/a.ts"],
      bindings: Object.fromEntries([
        ["z", 2],
        ["2", 1],
        ["1", 0],
        ["01", 3],
        ["__proto__", 4],
        ["constructor", 1],
        ["raw\udfff", 5],
      ]),
      sites: [
        { ...write, binding: "raw\ud800", file: "src/\udfff", line: "nan" },
        { ...write, line: "-0" },
      ],
    },
  ],
};
for (let n = 0; n < formats.length; n++) {
  boundary(`rich-censuses-${n}`, {
    reports: [report],
    under: ".",
    censuses: { libraries: richLibrary, deployables: richDeployable },
    ...formats[n],
  });
  boundary(`raw-violations-${n}`, {
    reports: [
      {
        ...report,
        scope: "\ud800",
        features: ["\udfff"],
        violations: [
          {
            kind: "driving-reaches-driven",
            from: "from\ud800",
            to: "to\udfff",
            feature: "\ud800",
            specifier: 'raw"\n\udfff',
            typeOnly: true,
            write: {
              file: "file\udfff",
              line: "inf",
              binding: "binding\ud800",
            },
          },
        ],
      },
    ],
    under: "\ud800",
    censuses: noCensuses,
    ...formats[n],
  });
  const raw = {
    ...first,
    scope: "\ud800",
    from: "from\udfff",
    to: "to\ud800",
    specifier: 's"\n\udfff',
    reason: "\udfff\n",
  };
  accepted(
    `raw-accepted-${n}`,
    { ...state, unrecorded: [raw] },
    'because"\n\ud800',
    formats[n],
  );
  gate(
    `raw-gate-${n}`,
    { ...state, unrecorded: [raw], pruned: [{ ...raw, reason: "" }] },
    formats[n],
  );
}

const numeric: Scalar[] = [
  0,
  "-0",
  1,
  -3,
  1.5,
  1e-7,
  1e-6,
  1e20,
  1e21,
  Number(1234567890123456768n),
  "nan",
  "inf",
  "-inf",
];
for (const value of numeric) {
  const label = JSON.stringify(value);
  for (const n of [0, 2, 3]) {
    boundary(`files-number-${label}-${n}`, {
      reports: [{ ...report, filesScanned: value }],
      under: ".",
      censuses: noCensuses,
      ...formats[n],
    });
    boundary(`write-number-${label}-${n}`, {
      reports: [
        {
          ...report,
          violations: [
            {
              kind: "driving-reaches-driven",
              from: b8.from,
              to: b8.to,
              feature: "orders",
              specifier: b8.specifier,
              typeOnly: false,
              write: { ...write, line: value },
            },
          ],
        },
      ],
      under: ".",
      censuses: noCensuses,
      ...formats[n],
    });
    migrated(
      `migrate-number-${label}-${n}`,
      { entries: [first] },
      value,
      formats[n],
    );
  }
  add(`refuse-ceiling-${label}`, "code_graph.boundary-refusal-render", {
    breaches: [{ scope: "services/\ud800", measured: 2, ceiling: value }],
  });
}

const natural: Scalar[] = [
  0,
  "-0",
  1,
  2,
  Number(1234567890123456768n),
  Number(18446744073709549568n),
];
for (const value of natural) {
  for (const n of [0, 2, 3]) {
    boundary(`census-number-${JSON.stringify(value)}-${n}`, {
      reports: [report],
      under: ".",
      censuses: {
        libraries: { ...emptyLibrary, unjudgedImports: value },
        deployables: {
          unresolvedServiceBindings: value,
          workers: [
            { worker: "api", files: [], bindings: { DB: value }, sites: [] },
          ],
        },
      },
      ...formats[n],
    });
    gate(
      `checked-number-${JSON.stringify(value)}-${n}`,
      { ...state, scopesChecked: value },
      formats[n],
    );
  }
  add(
    `refuse-measured-${JSON.stringify(value)}`,
    "code_graph.boundary-refusal-render",
    { breaches: [{ scope, measured: value, ceiling: 1 }] },
  );
}
add("refuse-empty", "code_graph.boundary-refusal-render", { breaches: [] });
add("refuse-multiple-duplicates", "code_graph.boundary-refusal-render", {
  breaches: [
    { scope: "z", measured: 3, ceiling: 2 },
    { scope: "a", measured: 2, ceiling: 0 },
    { scope: "z", measured: 3, ceiling: 2 },
  ],
});

for (let n = 0; n < formats.length; n++) {
  const common = {
    ...state,
    unrecorded: [b8, b8],
    pruned: [{ ...b8, reason: "pruned" }],
  };
  gate(
    `write-last-duplicate-${n}`,
    {
      ...common,
      writes: [
        { entry: b8, write },
        { entry: b8, write: { ...write, binding: "LAST", line: 6 } },
      ],
    },
    formats[n],
  );
  gate(
    `write-alternate-spelling-${n}`,
    {
      ...common,
      writes: [{ entry: { ...b8, specifier: "different" }, write }],
    },
    formats[n],
  );
  gate(
    `write-wrong-key-${n}`,
    {
      ...common,
      writes: [{ entry: { ...b8, to: "different-target.ts" }, write }],
    },
    formats[n],
  );
  accepted(
    `write-accepted-${n}`,
    { ...common, writes: [{ entry: b8, write }] },
    "",
    formats[n],
  );
  const reconciled = {
    kind: "reconciled",
    under: "services",
    ledger: {
      entries: [
        { ...first, reason: "kept" },
        { ...first, scope: "services/old", reason: "gone" },
        { ...first, scope: "packages/core", reason: "out of reach" },
      ],
    },
    reports: [
      {
        ...report,
        violations: [
          violations[0],
          {
            kind: "driving-reaches-driven",
            from: b8.from,
            to: b8.to,
            specifier: b8.specifier,
            feature: "orders",
            typeOnly: true,
            write,
          },
          {
            kind: "driving-reaches-driven",
            from: b8.from,
            to: b8.to,
            specifier: b8.specifier,
            feature: "orders",
            typeOnly: false,
            write: { ...write, binding: "LAST" },
          },
        ],
      },
      { ...report, scope: "services/other", violations: [] },
    ],
  };
  gate(`actual-reconciliation-${n}`, reconciled, formats[n]);
  accepted(`actual-accept-${n}`, reconciled, "needed", formats[n]);
}

// The fixed 35 red witnesses now exercise the full number domain on canonical facts.
const numberDomain: RenderCase[] = [];
for (const value of [
  -1,
  0.5,
  "nan",
  "inf",
  "-inf",
  Number(18446744073709551616n),
  1e21,
]) {
  const label = JSON.stringify(value);
  numberDomain.push(
    renderCase(`number-domain-library-${label}`, "code_graph.boundary-render", {
      reports: [report],
      under: ".",
      censuses: {
        libraries: { ...emptyLibrary, unjudgedImports: value },
        deployables: null,
      },
      ...formats[0],
    }),
  );
  numberDomain.push(
    renderCase(
      `number-domain-deployable-${label}`,
      "code_graph.boundary-render",
      {
        reports: [report],
        under: ".",
        censuses: {
          libraries: null,
          deployables: { ...emptyDeployable, unresolvedServiceBindings: value },
        },
        ...formats[0],
      },
    ),
  );
  numberDomain.push(
    renderCase(`number-domain-binding-${label}`, "code_graph.boundary-render", {
      reports: [report],
      under: ".",
      censuses: {
        libraries: null,
        deployables: {
          ...emptyDeployable,
          workers: [
            { worker: "api", files: [], bindings: { DB: value }, sites: [] },
          ],
        },
      },
      ...formats[0],
    }),
  );
  numberDomain.push(
    renderCase(
      `number-domain-checked-${label}`,
      "code_graph.boundary-ledger-render",
      { result: { ...state, scopesChecked: value }, ...formats[0] },
    ),
  );
  numberDomain.push(
    renderCase(
      `number-domain-measured-${label}`,
      "code_graph.boundary-refusal-render",
      { breaches: [{ scope, measured: value, ceiling: 0 }] },
    ),
  );
}
cases.push(...numberDomain);
for (const item of numberDomain) {
  if (item.operation === "code_graph.boundary-refusal-render") continue;
  for (const pretty of [false, true])
    add(`${item.id}-json-${pretty}`, item.operation, {
      ...item.input,
      json: true,
      pretty,
    });
}

const baseInput = {
  reports: [report],
  under: ".",
  censuses: noCensuses,
  ...formats[0],
};
const invalid = [
  { id: "invalid-operation", operation: "unknown", input: {} },
  {
    id: "invalid-outer",
    operation: "code_graph.boundary-render",
    input: baseInput,
    extra: true,
  },
  {
    id: "invalid-extra",
    operation: "code_graph.boundary-render",
    input: { ...baseInput, extra: true },
  },
  {
    id: "invalid-json-bool",
    operation: "code_graph.boundary-render",
    input: { ...baseInput, json: 1 },
  },
  {
    id: "invalid-pretty-bool",
    operation: "code_graph.boundary-render",
    input: { ...baseInput, pretty: "true" },
  },
  {
    id: "invalid-missing-under",
    operation: "code_graph.boundary-render",
    input: { reports: [], censuses: noCensuses, ...formats[0] },
  },
  {
    id: "invalid-null-workers",
    operation: "code_graph.boundary-render",
    input: { ...baseInput, reports: [{ ...report, workers: null }] },
  },
  {
    id: "invalid-report-extra",
    operation: "code_graph.boundary-render",
    input: { ...baseInput, reports: [{ ...report, extra: true }] },
  },
  {
    id: "invalid-literal-type-only",
    operation: "code_graph.boundary-render",
    input: {
      ...baseInput,
      reports: [
        {
          ...report,
          violations: [
            {
              kind: "index-not-exports-only",
              from: "a",
              to: null,
              specifier: "x",
              typeOnly: true,
            },
          ],
        },
      ],
    },
  },
  {
    id: "invalid-kind",
    operation: "code_graph.boundary-render",
    input: {
      ...baseInput,
      reports: [
        { ...report, violations: [{ ...violations[0], kind: "unknown" }] },
      ],
    },
  },
  {
    id: "invalid-write-null",
    operation: "code_graph.boundary-render",
    input: {
      ...baseInput,
      reports: [
        {
          ...report,
          violations: [
            {
              kind: "driving-reaches-driven",
              from: "a",
              to: "b",
              specifier: "x",
              feature: "f",
              typeOnly: false,
              write: null,
            },
          ],
        },
      ],
    },
  },
  {
    id: "invalid-null-number",
    operation: "code_graph.boundary-render",
    input: { ...baseInput, reports: [{ ...report, filesScanned: null }] },
  },
  {
    id: "invalid-number-token",
    operation: "code_graph.boundary-migrated-render",
    input: { ledger, scopes: "NaN", ...formats[0] },
  },
  {
    id: "invalid-ledger-extra",
    operation: "code_graph.boundary-migrated-render",
    input: { ledger: { ...ledger, extra: 1 }, scopes: 1, ...formats[0] },
  },
  {
    id: "invalid-state-kind",
    operation: "code_graph.boundary-ledger-render",
    input: { result: { ...state, kind: "unknown" }, ...formats[0] },
  },
  {
    id: "invalid-null-entry-reason",
    operation: "code_graph.boundary-ledger-render",
    input: {
      result: { ...state, unrecorded: [{ ...first, reason: null }] },
      ...formats[0],
    },
  },
  {
    id: "invalid-null-reason",
    operation: "code_graph.boundary-accepted-render",
    input: { result: state, reason: null, ...formats[0] },
  },
  {
    id: "invalid-breach-extra",
    operation: "code_graph.boundary-refusal-render",
    input: { breaches: [{ scope, measured: 1, ceiling: 0, extra: true }] },
  },
];

// Fixed expectations make the oracle comparison answer behavior, not merely implementation equality.
function output(id: string): unknown {
  const item = cases.find((item) => item.id === id);
  assert.ok(item, id);
  return boundaryRenderReference(item);
}
assert.equal(
  output("no-scopes-unrequested-0"),
  'boundaries: no feature scope declared at or under "services/\ud800" — nothing to check.',
);
assert.equal(
  output("scope-header-empty-workers-0"),
  "services/api — worker call graph\n  0 worker(s) — 0 violation(s)",
);
assert.equal(
  z
    .object({ stdout: z.string(), exitCode: z.number() })
    .parse(output("gate-pass-0")).stdout,
  "boundary ledger: PASS — 2 scope(s), 0 recorded crossing(s), none new.",
);
assert.equal(
  z.object({ exitCode: z.number() }).parse(output("gate-pruned-one-0"))
    .exitCode,
  0,
);
assert.equal(
  z.object({ exitCode: z.number() }).parse(output("gate-fail-all-kinds-0"))
    .exitCode,
  1,
);
assert.equal(
  z
    .object({ stdout: z.string() })
    .parse(output("write-wrong-key-0"))
    .stdout.includes("[write:"),
  false,
);
assert.ok(
  z
    .object({ stdout: z.string() })
    .parse(output("write-alternate-spelling-0"))
    .stdout.includes("[write: DB"),
);
const largeCountText = z
  .string()
  .parse(output("census-number-1234567890123456800-0"));
assert.ok(largeCountText.includes("1234567890123456800 imports left unjudged"));
assert.ok(largeCountText.includes("DB 1234567890123456800"));
assert.ok(largeCountText.includes("1234567890123456800 service bindings"));
const nestedPretty = z.string().parse(output("rich-censuses-3"));
assert.ok(
  nestedPretty.includes('"raw\\ud800": [\n        "packages/\\udfff"\n      ]'),
);
assert.ok(!nestedPretty.includes('"__proto__"'));
const requested = JSON.parse(z.string().parse(output("no-scopes-both-2")));
assert.deepEqual(Object.keys(requested), [
  "deployables",
  "libraries",
  "scopes",
]);
assert.deepEqual(
  JSON.parse(z.string().parse(output("no-scopes-unrequested-2"))),
  { scopes: [] },
);

const wire = [...cases, ...invalid];
assert.equal(
  new Set(wire.map((item) => item.id)).size,
  wire.length,
  "case ids are unique",
);
const run = spawnSync(binary, [], {
  input: `${wire.map((item) => JSON.stringify(item)).join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
assert.equal(run.status, 0, run.stderr);
assert.equal(run.stderr, "");
const replySchema = z
  .object({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.object({ tag: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  })
  .strict();
const answers = run.stdout
  .trimEnd()
  .split("\n")
  .map((line) => replySchema.parse(JSON.parse(line)));
assert.equal(answers.length, wire.length);
const methods = {
  "code_graph.boundary-render": "render_boundaries",
  "code_graph.boundary-ledger-render": "render_ledger_gate",
  "code_graph.boundary-accepted-render": "render_accepted",
  "code_graph.boundary-migrated-render": "render_migrated",
  "code_graph.boundary-refusal-render": "render_migration_refused",
};
for (let i = 0; i < cases.length; i++) {
  const item = cases[i],
    answer = answers[i];
  assert.equal(answer.id, item.id);
  assert.equal(answer.ok, true, `${item.id}: ${JSON.stringify(answer.error)}`);
  const reference = boundaryRenderReference(item);
  assert.deepEqual(answer.output, reference, item.id);
  assert.equal(answer.error, undefined, item.id);
  assert.ok(answer.observedCalls.includes(methods[item.operation]), item.id);
  if (
    (item.operation === "code_graph.boundary-ledger-render" ||
      item.operation === "code_graph.boundary-accepted-render") &&
    item.input.result.kind === "reconciled"
  )
    assert.ok(answer.observedCalls.includes("reconcile"), item.id);
}
for (let i = 0; i < invalid.length; i++) {
  const item = invalid[i],
    answer = answers[cases.length + i];
  assert.equal(answer.ok, false, item.id);
  assert.equal(answer.error?.tag, "driver-error", item.id);
  assert.deepEqual(answer.observedCalls, [], item.id);
}
const result = {
  passed: cases.length,
  rejectedInvalidInputs: invalid.length,
  reference: {
    node: process.version,
    v8: process.versions.v8,
    source: "boundaries/render.ts and canonical reconciliation/census owners",
    native:
      "actual public render_boundaries/render_ledger_gate/render_accepted/render_migrated/render_migration_refused calls; opaque typed facts and real reconciliation",
  },
  caseCounts: Object.fromEntries(
    Object.keys(methods).map((operation) => [
      operation,
      cases.filter((item) => item.operation === operation).length,
    ]),
  ),
  nativeCalls: Object.fromEntries(
    [...new Set(answers.flatMap((answer) => answer.observedCalls))].map(
      (method) => [
        method,
        answers.filter((answer) => answer.observedCalls.includes(method))
          .length,
      ],
    ),
  ),
  cases: [...cases, ...invalid].map((item, index) => ({
    ...item,
    expected:
      index < cases.length
        ? boundaryRenderReference(cases[index])
        : { rejected: true },
    ...answers[index],
  })),
  numericDomainWitnesses: numberDomain.map((item) => ({
    id: item.id,
    redWitness: item.id.replace("number-domain-", "unsupported-"),
  })),
};
if (process.argv[3])
  fs.writeFileSync(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ passed: result.passed, rejectedInvalidInputs: result.rejectedInvalidInputs, numericDomainWitnesses: numberDomain.length, nativeCalls: result.nativeCalls })}\n`,
);
