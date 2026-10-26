import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const put = (root, file, body) => {
  const p = path.join(root, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const match = {
  default: 40,
  slackPoints: 2,
  scopes: { "packages/api": 50, "packages/billing": 100, "packages/auth": 0 },
};
const sourceFiles = {
  "packages/api/package.json": "{}",
  "packages/api/src/a.ts":
    "// API prose\nexport const a=1;\nexport const b=2;\n",
  "packages/billing/package.json": "{}",
  "packages/billing/src/b.ts": "// billing prose\nexport const b=1;\n",
  "packages/auth/package.json": "{}",
  "packages/auth/src/c.spec.ts":
    "// @vitest-environment happy-dom\nexport const c=1;\n",
  "fixtures/demo/package.json": "{}",
  "fixtures/demo/src/demo.ts":
    "// fixture prose\n// fixture detail\nexport const d=1;\n",
};
export function commentFixture(location, o) {
  const root = path.join(location, "repo");
  assert.ok(!fs.existsSync(root));
  fs.mkdirSync(root, { recursive: true });
  put(root, "pnpm-workspace.yaml", "packages: []\n");
  put(root, "readonly.txt", "");
  let target = o.subpath ? "packages/api" : ".",
    prefix = "";
  if (o.rawRoot || o.replacementRoot || o.supplementaryRoot) {
    target = `apps/raw${o.replacementRoot ? "�" : o.supplementaryRoot ? "😀" : "\ud800"}`;
    prefix = `${target.toWellFormed()}/`;
    if (o.selfMarker)
      put(root, `${prefix}pnpm-workspace.yaml`, "packages: []\n");
  }
  for (const [p, s] of Object.entries(o.empty ? {} : sourceFiles))
    put(root, prefix + p, s);
  const policyRoot = o.selfMarker ? prefix : "";
  if (o.ceilings === "match" || o.ceilings === "readonly")
    put(root, `${policyRoot}comment-ceilings.json`, JSON.stringify(match));
  if (o.ceilings === "exceeded")
    put(
      root,
      `${policyRoot}comment-ceilings.json`,
      JSON.stringify({
        ...match,
        scopes: { ...match.scopes, "packages/api": 49 },
      }),
    );
  if (o.ceilings === "slack")
    put(
      root,
      `${policyRoot}comment-ceilings.json`,
      JSON.stringify({
        ...match,
        scopes: { ...match.scopes, "packages/api": 60 },
      }),
    );
  if (o.ceilings === "custom")
    put(
      root,
      `${policyRoot}comment-ceilings.json`,
      JSON.stringify({
        ...match,
        default: 17,
        slackPoints: 3,
        scopes: { ...match.scopes, obsolete: 90 },
      }),
    );
  if (o.ceilings === "malformed")
    put(root, `${policyRoot}comment-ceilings.json`, "{broken");
  if (o.ceilings === "type-error")
    put(
      root,
      `${policyRoot}comment-ceilings.json`,
      '{"scopes":{"constructor":null}}',
    );
  if (o.ceilings === "readonly")
    fs.chmodSync(path.join(root, `${policyRoot}comment-ceilings.json`), 0o400);
  if (o.badSmell) put(root, "smell-ledger.json", "{broken");
  if (o.badUnreachable) put(root, "unreachable-ledger.json", "{broken");
  if (o.malformedSource)
    put(root, `${prefix}packages/api/src/a.ts`, "export const broken=");
  return {
    root,
    target,
    argv: [
      target,
      ...(o.inactive ? [] : ["--comments"]),
      ...(o.flags ?? []),
      ...(o.out === undefined ? [] : ["--out", o.out]),
    ],
  };
}

export const commentCases = [
  ["census-text", {}],
  ["census-json", { flags: ["--json"] }],
  ["census-pretty-json", { flags: ["--json", "--pretty"] }],
  ["ci-pass-text", { ceilings: "match", flags: ["--ci"] }],
  ["ci-pass-json", { ceilings: "match", flags: ["--ci", "--json"] }],
  ["ci-exceeded", { ceilings: "exceeded", flags: ["--ci", "--json"] }],
  ["ci-slack", { ceilings: "slack", flags: ["--ci"] }],
  ["write-new", { flags: ["--write-ceilings"] }],
  [
    "write-preserves-policy",
    { ceilings: "custom", flags: ["--write-ceilings", "--json", "--pretty"] },
  ],
  [
    "ci-and-write-existing",
    { ceilings: "match", flags: ["--ci", "--write-ceilings"] },
  ],
  ["ci-and-write-missing", { flags: ["--ci", "--write-ceilings"] }],
  ["ci-missing", { flags: ["--ci"] }],
  ["ci-malformed", { ceilings: "malformed", flags: ["--ci"] }],
  ["ci-type-error", { ceilings: "type-error", flags: ["--ci"] }],
  ["report-ignores-malformed", { ceilings: "malformed", flags: ["--json"] }],
  ["write-out", { flags: ["--write-ceilings"], out: "result.txt" }],
  [
    "write-out-missing",
    { flags: ["--write-ceilings"], out: "missing/result.txt" },
  ],
  [
    "write-out-same",
    { flags: ["--write-ceilings"], out: "comment-ceilings.json" },
  ],
  [
    "write-ceiling-readonly",
    { ceilings: "readonly", flags: ["--write-ceilings"] },
  ],
  [
    "write-banner-bad",
    { flags: ["--write-ceilings"], out: "result.txt", badStderr: true },
  ],
  ["ci-stdout-bad", { ceilings: "exceeded", flags: ["--ci"], badStdout: true }],
  ["ci-report-stderr-bad", { flags: ["--ci"], badStderr: true }],
  [
    "zero-preserves-initial",
    { ceilings: "match", flags: ["--ci"], initial: 7 },
  ],
  [
    "one-replaces-initial",
    { ceilings: "exceeded", flags: ["--ci", "--json"], initial: 7 },
  ],
  [
    "global-config-first",
    { flags: ["--thresholds=missing.json", "--write-ceilings"] },
  ],
  [
    "unreachable-first",
    {
      badUnreachable: true,
      flags: ["--unreachable", "--ci", "--write-ceilings"],
    },
  ],
  [
    "unused-smell-ledger-ci",
    { badSmell: true, flags: ["--ci", "--write-ceilings"] },
  ],
  [
    "layers-first",
    { flags: ["--layers", "--layer-rules=missing.json", "--write-ceilings"] },
  ],
  ["boundaries-first", { flags: ["--boundaries", "--write-ceilings"] }],
  ["env-first", { flags: ["--env-keys", "--write-ceilings", "--json"] }],
  ["hexagon-first", { flags: ["--hexagon", "--write-ceilings", "--json"] }],
  ["api-first", { flags: ["--api=missing-api.json", "--write-ceilings"] }],
  [
    "later-flags",
    {
      flags: ["--collapse", "--graph", "--edges", "--deep", "--html", "--json"],
      withoutCompiler: true,
    },
  ],
  ["no-compiler", { flags: ["--json"], withoutCompiler: true }],
  ["subpath-write", { subpath: true, flags: ["--write-ceilings"] }],
  [
    "second-root-write",
    {
      subpath: true,
      ceilings: "custom",
      removeMarker: true,
      flags: ["--write-ceilings"],
    },
  ],
  [
    "raw-self-ci-missing",
    { rawRoot: true, selfMarker: true, rawArgv: true, flags: ["--ci"] },
  ],
  [
    "raw-self-write",
    {
      rawRoot: true,
      selfMarker: true,
      rawArgv: true,
      flags: ["--write-ceilings"],
    },
  ],
  [
    "raw-self-type-error",
    {
      rawRoot: true,
      selfMarker: true,
      rawArgv: true,
      ceilings: "type-error",
      flags: ["--ci"],
    },
  ],
  [
    "replacement-self-ci-missing",
    { replacementRoot: true, selfMarker: true, flags: ["--ci"] },
  ],
  [
    "supplementary-self-ci-missing",
    { supplementaryRoot: true, selfMarker: true, flags: ["--ci"] },
  ],
  ["raw-scope-report", { rawRoot: true, rawArgv: true, flags: ["--json"] }],
  ["malformed-source", { malformedSource: true, flags: ["--json"] }],
  ["empty-project", { empty: true, flags: ["--json"] }],

  [
    "raw-self-write-readonly",
    {
      rawRoot: true,
      selfMarker: true,
      rawArgv: true,
      ceilings: "readonly",
      flags: ["--write-ceilings"],
    },
  ],
  [
    "write-out-missing-initial",
    { flags: ["--write-ceilings"], out: "missing/result.txt", initial: 7 },
  ],
  [
    "write-nul-out",
    { flags: ["--write-ceilings"], out: "raw\0\ud800", rawArgv: true },
  ],
  [
    "write-stdout-bad",
    { flags: ["--write-ceilings"], initial: 7, badStdout: true },
  ],
  [
    "accept-smells-conflict",
    { flags: ["--accept-smells", "--reason=because", "--write-ceilings"] },
  ],
  [
    "ci-out-missing-initial",
    {
      ceilings: "exceeded",
      flags: ["--ci", "--json"],
      out: "missing/result.txt",
      initial: 7,
    },
  ],
];
// Independent Source contracts, not values derived from the Rust result.
const refusals = new Set([
  "ci-and-write-missing",
  "ci-missing",
  "ci-malformed",
  "ci-report-stderr-bad",
  "unused-smell-ledger-ci",
  "raw-self-ci-missing",
  "replacement-self-ci-missing",
  "supplementary-self-ci-missing",
]);
const thrown = new Set([
  "ci-type-error",
  "write-out-missing",
  "write-ceiling-readonly",
  "raw-self-type-error",
  "raw-self-write-readonly",
  "write-out-missing-initial",
  "write-nul-out",
  "ci-out-missing-initial",
]);
const stages = {
  "global-config-first": "stopped",
  "unreachable-first": "refused",
  "accept-smells-conflict": "refused",
  "layers-first": "layers",
  "boundaries-first": "boundaries",
  "env-first": "env-keys",
  "hexagon-first": "hexagon",
  "api-first": "api",
};
for (const [id, o] of commentCases) {
  if (stages[id]) o.stage = stages[id];
  if (thrown.has(id)) o.expectedThrow = true;
  else if (!o.stage)
    o.code = refusals.has(id)
      ? 2
      : [
            "ci-exceeded",
            "ci-slack",
            "ci-stdout-bad",
            "one-replaces-initial",
          ].includes(id)
        ? 1
        : 0;
}
commentCases.push([
  "inactive",
  { inactive: true, initial: 7, stage: "continue", flags: ["--collapse"] },
]);
commentCases.push([
  "record-repeat-ci-out",
  {
    flags: ["--write-ceilings"],
    code: 0,
    followups: [
      { id: "repeat-record", flags: ["--write-ceilings"] },
      {
        id: "ci-out",
        flags: ["--ci", "--json", "--pretty", "--out=report.json"],
      },
    ],
  },
]);
