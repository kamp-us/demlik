import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { put } from "./collapse-gate-cases.mjs";
import { plainFixture } from "./collapse-plain-cases.mjs";

export function unreachableFixture(location, o) {
  const f = plainFixture(location, o);
  if (!o.collapse && !o.retry) {
    for (const pkg of [f.physical, "packages/second"]) {
      for (const file of [
        "helpers.ts",
        "api.ts",
        "worker.ts",
        "limits.ts",
        "retry.ts",
      ])
        fs.rmSync(path.join(f.root, pkg, file), { force: true });
      put(
        f.root,
        `${pkg}/package.json`,
        JSON.stringify({
          name: pkg.endsWith("second") ? "fixture-b" : "fixture-a",
          private: true,
        }),
      );
      put(f.root, `${pkg}/dead.ts`, "export function unused(){return 1;}\n");
      put(f.root, `${pkg}/tested.ts`, "export function tested(){return 2;}\n");
      put(f.root, `${pkg}/helper.ts`, "export function helper(){return 3;}\n");
      put(
        f.root,
        `${pkg}/main.ts`,
        "import {helper} from './helper';helper();\n",
      );
      put(
        f.root,
        `${pkg}/a.test.ts`,
        "import {tested} from './tested';tested();\n",
      );
      if (o.empty)
        for (const file of [
          "dead.ts",
          "tested.ts",
          "helper.ts",
          "main.ts",
          "a.test.ts",
        ])
          fs.rmSync(path.join(f.root, pkg, file));
    }
  }
  if (!o.collapse) f.argv = f.argv.filter((x) => x !== "--collapse");
  if (!o.inactive) f.argv.push("--unreachable");
  if (o.seedLedger)
    put(
      f.root,
      "unreachable-ledger.json",
      JSON.stringify({
        entries: [
          {
            scope: f.target,
            kind: "dead",
            id: "dead.ts:unused",
            reason: "first",
          },
          {
            scope: f.target,
            kind: "only-called-from-tests",
            id: "tested.ts:tested",
            reason: "first",
          },
        ],
      }),
    );
  if (o.ledgerDirectory)
    fs.mkdirSync(path.join(f.root, "unreachable-ledger.json"));
  if (o.ledgerReadonly)
    fs.chmodSync(path.join(f.root, "unreachable-ledger.json"), 0o444);
  return f;
}
export const unreachableCases = [
  ["two-package-workflow", { workflow: true }],
  ["report-text", {}],
  ["report-json", { flags: ["--json"] }],
  ["report-pretty", { flags: ["--json", "--pretty"] }],
  ["bare-write-ceilings-still-reports", { flags: ["--write-ceilings"] }],
  ["report-empty", { empty: true }],
  ["report-out", { out: "result.txt" }],
  ["report-out-mode", { out: "existing.txt", outputMode: 0o640 }],
  ["report-initial-preserved", { initial: 7 }],
  ["gate-before-graph", { flags: ["--ci", "--graph"] }],
  ["gate-before-html", { flags: ["--ci", "--html"] }],
  ["gate-json", { flags: ["--ci", "--json", "--pretty"] }],
  ["ci-zero-initial", { flags: ["--ci"], seedLedger: true, initial: 7 }],
  [
    "accept-before-collapse",
    { collapse: true, flags: ["--accept-dead", "--reason", "reviewed"] },
  ],
  [
    "accept-json",
    {
      flags: ["--accept-dead", "--reason", " reviewed ", "--json", "--pretty"],
    },
  ],
  [
    "accept-zero-initial",
    {
      flags: ["--accept-dead", "--reason", "reviewed"],
      seedLedger: true,
      initial: 7,
    },
  ],
  ["collapse-before-report", { collapse: true }],
  ["graph-before-report", { flags: ["--graph", "--headers", "--pretty"] }],
  [
    "lower-flags-dont-preempt",
    {
      flags: [
        "--unguarded",
        "--clusters",
        "--interface-width",
        "--kinds",
        "--hotspots",
        "--hotspots-days",
        "bad",
        "--tree",
      ],
    },
  ],
  [
    "dead-only-refused-before-load",
    { flags: ["--dead-only"], noConfig: true, withoutCompiler: true },
  ],
  [
    "reason-refused-before-load",
    { flags: ["--reason", "unearned"], noConfig: true, withoutCompiler: true },
  ],
  [
    "invalid-ledger-before-load",
    {
      flags: ["--ci"],
      badUnreachable: true,
      noConfig: true,
      withoutCompiler: true,
    },
  ],
  [
    "ledger-directory-refused",
    { flags: ["--ci"], ledgerDirectory: true, withoutCompiler: true },
  ],
  ["missing-tsconfig", { noConfig: true }],
  ["malformed-tsconfig", { badTsConfig: true }],
  [
    "warning-before-load-refusal",
    { noConfig: true, flags: ["--by", "loc"], initial: 7 },
  ],
  ["deep-missing-root-config", { flags: ["--deep"] }],
  ["deep-root-config", { flags: ["--deep", "--json"], rootConfig: true }],
  ["data-in-graph", { flags: ["--data", "--graph"], dataFixture: true }],
  [
    "fresh-data-root-after-warning",
    { flags: ["--data", "--graph", "--by", "loc"], freshDataRoot: true },
  ],
  [
    "warning-before-assembly-failure",
    { retry: true, warning: true, drift: true, catalogFailure: true },
  ],
  ["out-missing-parent", { out: "missing/result.txt" }],
  ["out-directory", { out: "." }],
  ["out-nul", { out: "bad\0result.txt", rawArgv: true }],
  ["stdout-failure", { badStdout: true }],
  [
    "warning-stdio-failure",
    { flags: ["--by", "loc"], out: "result.txt", badStderr: true },
  ],
  ["acknowledgement-stdio-failure", { out: "result.txt", badStderr: true }],
  [
    "thresholds-first",
    { flags: ["--thresholds", "missing.json"], withoutCompiler: true },
  ],
  ["api-first", { flags: ["--api", "missing.json"], withoutCompiler: true }],
  ["layers-first", { flags: ["--layers"], withoutCompiler: true }],
  ["boundaries-first", { flags: ["--boundaries"], withoutCompiler: true }],
  ["env-first", { flags: ["--env-keys", "--json"], withoutCompiler: true }],
  ["comments-first", { flags: ["--comments"], withoutCompiler: true }],
  ["early-collapse-ci", { collapse: true, retry: true, flags: ["--ci"] }],
  [
    "early-collapse-write",
    { collapse: true, retry: true, flags: ["--write-ceilings"] },
  ],
  ["missing-native-compiler", { withoutCompiler: true, nativeOnly: true }],
  ["inactive-continuation", { inactive: true, nativeOnly: true }],
  ["html-continuation", { flags: ["--html"], nativeOnly: true }],
];
assert.equal(
  new Set(unreachableCases.map(([id]) => id)).size,
  unreachableCases.length,
);

export const unreachableSteps = [
  {
    id: "record-b",
    package: "packages/second",
    flags: ["--accept-dead", "--reason", "B first", "--json"],
    entries: 2,
  },
  {
    id: "record-a",
    flags: ["--accept-dead", "--reason", "A first", "--json", "--pretty"],
    entries: 4,
  },
  {
    id: "repeat-a-readonly",
    flags: ["--accept-dead", "--reason", "replacement"],
    readonly: true,
    unchanged: true,
    entries: 4,
  },
  {
    id: "ci-pass",
    flags: ["--ci", "--json"],
    writable: true,
    unchanged: true,
    entries: 4,
  },
  {
    id: "change-ci-prunes-fails",
    edit: "change-dead",
    flags: ["--ci"],
    exit: 1,
    entries: 3,
  },
  {
    id: "accept-changed",
    flags: ["--accept-dead", "--reason", "changed accepted"],
    entries: 4,
  },
  {
    id: "repeat-changed",
    flags: ["--accept-dead", "--reason", "ignored", "--json"],
    unchanged: true,
    entries: 4,
  },
  {
    id: "dead-only-keeps-ungated",
    edit: "rename-tested",
    flags: ["--ci", "--dead-only", "--json", "--pretty"],
    unchanged: true,
    entries: 4,
  },
  {
    id: "second-scope-prunes-only-b",
    package: "packages/second",
    edit: "remove-b-dead",
    flags: ["--ci"],
    entries: 3,
  },
];
export function editUnreachable(f, step) {
  if (step.edit === "change-dead")
    put(
      f.root,
      `${f.physical}/dead.ts`,
      "export function changed(){return 4;}\n",
    );
  if (step.edit === "rename-tested") {
    put(
      f.root,
      `${f.physical}/tested.ts`,
      "export function renamedTested(){return 5;}\n",
    );
    put(
      f.root,
      `${f.physical}/a.test.ts`,
      "import {renamedTested} from './tested';renamedTested();\n",
    );
  }
  if (step.edit === "remove-b-dead")
    put(f.root, "packages/second/dead.ts", "// removed\n");
  const file = path.join(f.root, "unreachable-ledger.json");
  if (step.readonly) fs.chmodSync(file, 0o444);
  if (step.writable) fs.chmodSync(file, 0o644);
  if (step.flags)
    f.argv = [step.package ?? f.target, "--unreachable", ...step.flags];
}
