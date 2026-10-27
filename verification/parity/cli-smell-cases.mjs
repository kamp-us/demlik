import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { put } from "./collapse-gate-cases.mjs";
import { plainFixture } from "./collapse-plain-cases.mjs";

const busy = (extra = false) =>
  `import {unit} from './helpers.js';\nexport function busy(n:number){${extra ? "if(n===0)return 7;" : ""}if(n>0)return unit(n);return 0;}\n`;
export function smellFixture(location, o) {
  const f = plainFixture(location, {
    ...o,
    flags: [],
    target: o.target ?? "packages/billing",
  });
  for (const pkg of [f.physical, "packages/second"]) {
    for (const entry of fs.readdirSync(path.join(f.root, pkg)))
      if (/\.tsx?$/.test(entry)) fs.rmSync(path.join(f.root, pkg, entry));
    put(
      f.root,
      `${pkg}/package.json`,
      JSON.stringify({
        name: pkg.endsWith("second") ? "second" : "billing",
        private: true,
      }),
    );
    put(
      f.root,
      `${pkg}/helpers.ts`,
      "export function unit(n:number){return n+1;}\n",
    );
    put(
      f.root,
      `${pkg}/api.ts`,
      o.empty ? "export function busy(n:number){return n;}\n" : busy(),
    );
    put(
      f.root,
      `${pkg}/worker.ts`,
      "import {unit} from './helpers.js';\nexport function serve(){return unit(1);}\n",
    );
    if (!o.edge)
      fs.rmSync(path.join(f.root, pkg, "tsconfig.json"), { force: true });
  }
  put(f.root, "thresholds.json", '{"highComplexity":1,"highFanIn":1}');
  if (o.badKinds)
    put(f.root, "kind-rules.json", '{"entryNames":{"broken":["("]}}');
  const entries = o.workflow
    ? [
        {
          rule: "high-complexity",
          target: "packages/second/api.ts:busy",
          value: 9,
          reason: "other-scope",
        },
      ]
    : [];
  const ledger = { gated: o.gated ?? ["high-complexity"], entries };
  put(f.root, "smell-ledger.json", o.badLedger ?? JSON.stringify(ledger));
  if (o.ledgerMode)
    fs.chmodSync(path.join(f.root, "smell-ledger.json"), o.ledgerMode);
  if (o.parseFailure)
    put(f.root, `${f.physical}/malformed.ts`, "export function broken( {\n");
  f.argv = [
    f.target,
    ...(o.flags ?? ["--ci"]),
    "--thresholds",
    "thresholds.json",
    ...(o.badKinds ? ["--node-kinds", "kind-rules.json"] : []),
    ...(o.out === undefined ? [] : ["--out", o.out]),
  ];
  return f;
}
export const smellSteps = [
  {
    id: "accept",
    flags: ["--accept-smells", "--reason", "A first"],
    entries: 2,
  },
  {
    id: "repeat",
    flags: ["--accept-smells", "--reason", "ignored repeat"],
    entries: 2,
    unchanged: true,
  },
  { id: "ci", flags: ["--ci"], entries: 2, unchanged: true },
  {
    id: "worsen",
    edit: "worsen",
    flags: ["--ci"],
    entries: 2,
    exit: 1,
    unchanged: true,
  },
  {
    id: "accept-worse",
    flags: ["--accept-smells", "--reason", "worse accepted"],
    entries: 2,
  },
  { id: "lower", edit: "lower", flags: ["--ci"], entries: 2 },
  { id: "remove", edit: "remove", flags: ["--ci"], entries: 1 },
  { id: "second-scope", second: true, flags: ["--ci"], entries: 1 },
  {
    id: "second-repeat",
    second: true,
    flags: ["--ci"],
    entries: 1,
    unchanged: true,
  },
];
export function editSmell(f, step) {
  if (step.edit === "worsen") put(f.root, `${f.physical}/api.ts`, busy(true));
  if (step.edit === "lower") put(f.root, `${f.physical}/api.ts`, busy());
  if (step.edit === "remove")
    put(
      f.root,
      `${f.physical}/api.ts`,
      "export function busy(n:number){return n;}\n",
    );
  if (step.flags)
    f.argv = [
      step.second ? "packages/second" : f.target,
      ...step.flags,
      "--thresholds",
      "thresholds.json",
    ];
}
export const smellCases = [
  ["syntax-two-package-workflow", { workflow: true, withoutCompiler: true }],
  ["cheap-ci-text", { withoutCompiler: true }],
  ["cheap-ci-json", { flags: ["--ci", "--json"], withoutCompiler: true }],
  [
    "cheap-ci-pretty",
    { flags: ["--ci", "--json", "--pretty"], withoutCompiler: true },
  ],
  [
    "cheap-accept-text",
    {
      flags: ["--accept-smells", "--reason", "reviewed"],
      withoutCompiler: true,
    },
  ],
  [
    "cheap-accept-pretty",
    {
      flags: [
        "--accept-smells",
        "--reason",
        " reviewed ",
        "--json",
        "--pretty",
      ],
      withoutCompiler: true,
    },
  ],
  ["cheap-empty", { empty: true, withoutCompiler: true }],
  [
    "accept-ignores-bare-ceiling-write",
    {
      flags: ["--accept-smells", "--reason", "reviewed", "--write-ceilings"],
      withoutCompiler: true,
    },
  ],
  [
    "cheap-parse-failure-keeps-valid-file",
    { parseFailure: true, withoutCompiler: true },
  ],
  ["edge-fanin-ci", { edge: true, gated: ["high-fan-in"] }],
  [
    "edge-fanin-accept",
    {
      edge: true,
      gated: ["high-fan-in"],
      flags: ["--accept-smells", "--reason", "fan-in reviewed"],
    },
  ],
  [
    "edge-only-does-not-read-catalog",
    { edge: true, gated: ["high-fan-in"], catalogFailure: true },
  ],
  [
    "node-rule-refusal-before-smell",
    { edge: true, gated: ["high-fan-in"], badKinds: true },
  ],
  [
    "kinds-catalog-failure",
    { edge: true, catalogFailure: true, flags: ["--ci", "--kinds"] },
  ],
  ["explicit-edges", { edge: true, flags: ["--ci", "--edges"] }],
  ["deep-edges", { edge: true, rootConfig: true, flags: ["--ci", "--deep"] }],
  ["edge-no-config", { gated: ["high-fan-in"] }],
  ...[
    ["blast-empty-still-needs-edges", ["--blast", ""]],
    ["find-empty-still-needs-edges", ["--find", ""]],
    ["cycles-needs-edges", ["--cycles"]],
    ["cross-runtime-needs-edges", ["--cross-runtime"]],
    ["clusters-needs-edges", ["--clusters"]],
    ["interface-width-needs-edges", ["--interface-width"]],
    ["unguarded-needs-edges", ["--unguarded"]],
  ].map(([id, flags]) => [
    id,
    {
      flags: ["--ci", ...flags],
      expectLoadRefused: true,
      withoutCompiler: true,
    },
  ]),
  [
    "warning-before-edge-refusal",
    { gated: ["high-fan-in"], flags: ["--ci", "--by", "loc"] },
  ],
  [
    "graph-does-not-preempt-smell",
    { flags: ["--ci", "--graph"], withoutCompiler: true },
  ],
  ["html-does-not-preempt-smell", { edge: true, flags: ["--ci", "--html"] }],
  [
    "plan-suppresses-warning-without-edges",
    { flags: ["--ci", "--plan", "--by", "impact"], withoutCompiler: true },
  ],
  [
    "data-cheap",
    { flags: ["--ci", "--data"], dataFixture: true, withoutCompiler: true },
  ],
  [
    "data-catalog-failure",
    {
      flags: ["--ci", "--data", "--by", "loc"],
      catalogFailure: true,
      withoutCompiler: true,
    },
  ],
  [
    "fresh-data-stored-ledger-root",
    {
      flags: [
        "--accept-smells",
        "--reason",
        "reviewed",
        "--data",
        "--by",
        "loc",
      ],
      freshDataRoot: true,
      controlled: true,
      withoutCompiler: true,
    },
  ],
  [
    "accept-out",
    {
      flags: ["--accept-smells", "--reason", "reviewed"],
      out: "result.txt",
      withoutCompiler: true,
    },
  ],
  [
    "accept-out-mode",
    {
      flags: ["--accept-smells", "--reason", "reviewed"],
      out: "existing.txt",
      outputMode: 0o640,
      ledgerMode: 0o640,
      withoutCompiler: true,
    },
  ],
  [
    "ledger-write-before-out-failure",
    {
      flags: ["--accept-smells", "--reason", "reviewed"],
      out: ".",
      withoutCompiler: true,
    },
  ],
  [
    "ledger-write-refusal",
    {
      flags: ["--accept-smells", "--reason", "reviewed"],
      ledgerMode: 0o444,
      withoutCompiler: true,
    },
  ],
  [
    "accept-success-preserves-initial",
    {
      flags: ["--accept-smells", "--reason", "reviewed"],
      initial: 7,
      withoutCompiler: true,
    },
  ],
  [
    "zero-ci-preserves-initial",
    { empty: true, initial: 7, withoutCompiler: true },
  ],
  [
    "bad-stderr-warning",
    { flags: ["--ci", "--by", "loc"], badStderr: true, withoutCompiler: true },
  ],
  [
    "bad-stdout-after-ledger-write",
    {
      flags: ["--accept-smells", "--reason", "reviewed"],
      badStdout: true,
      withoutCompiler: true,
    },
  ],
  [
    "schema-refusal-before-load",
    { badLedger: '{"unknown":1}', withoutCompiler: true },
  ],
  [
    "accept-ci-refused",
    {
      flags: ["--accept-smells", "--ci", "--reason", "reviewed"],
      withoutCompiler: true,
    },
  ],
  [
    "accept-other-refused",
    {
      flags: ["--accept-smells", "--comments", "--reason", "reviewed"],
      withoutCompiler: true,
    },
  ],
  [
    "accept-blank-refused",
    {
      flags: ["--accept-smells", "--reason", "\u00a0\ufeff"],
      withoutCompiler: true,
    },
  ],
  ["env-priority", { flags: ["--ci", "--env-keys"], withoutCompiler: true }],
  [
    "comments-priority",
    { flags: ["--ci", "--comments"], withoutCompiler: true },
  ],
  [
    "raw-root",
    {
      rawRoot: true,
      rawArgv: true,
      flags: ["--accept-smells", "--reason", "reviewed"],
      withoutCompiler: true,
    },
  ],
  [
    "replacement-root",
    {
      target: "packages/raw\ufffd",
      flags: ["--accept-smells", "--reason", "reviewed"],
      withoutCompiler: true,
    },
  ],
  [
    "ordinary-smells-remains-continuation",
    { flags: ["--smells"], nativeOnly: true, withoutCompiler: true },
  ],
  [
    "generic-ci-remains-continuation",
    { gated: [], nativeOnly: true, withoutCompiler: true },
  ],
  [
    "explicit-missing-compiler-error",
    {
      edge: true,
      gated: ["high-fan-in"],
      nativeOnly: true,
      withoutCompiler: true,
      missingCompiler: true,
    },
  ],
];
assert.equal(new Set(smellCases.map(([id]) => id)).size, smellCases.length);
