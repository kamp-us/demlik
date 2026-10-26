import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const put = (root, file, body) => {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
};
const sources = {
  "src/alpha/index.ts": "export {run} from './application/run.js';\n",
  "src/alpha/ports.ts": "export interface Clock {now():number}\n",
  "src/alpha/application/run.ts":
    "import {secret} from '../../beta/application/private.js'; export const run=()=>secret;\n",
  "src/beta/index.ts": "export {secret} from './application/private.js';\n",
  "src/beta/ports.ts": "export interface Store {read():number}\n",
  "src/beta/application/private.ts": "export const secret=1;\n",
};
export const boundaryCases = [];
for (const [format, flags] of [
  ["text", []],
  ["pretty-text", ["--pretty"]],
  ["json", ["--json"]],
  ["pretty-json", ["--json", "--pretty"]],
])
  for (const [mode, options] of [
    ["report", { code: 0 }],
    ["ci", { ci: true, code: 1 }],
    ["accept", { accept: true, code: 0 }],
    ["recorded", { ci: true, ledger: true, code: 0 }],
    ["prune", { ci: true, ledger: true, noCrossing: true, code: 0 }],
    ["migrate", { migrate: true, legacy: true, code: 0 }],
  ])
    boundaryCases.push([`${mode}-${format}`, { ...options, flags }]);
boundaryCases.push(
  ["default-rules", { defaultRules: true, flags: ["--json"], code: 0 }],
  ["missing-rules", { rules: "missing", code: 2 }],
  ["malformed-rules", { rules: "malformed", code: 2 }],
  ["schema-type-error", { rules: "constructor", expectedThrow: true }],
  ["pattern-error", { rules: "pattern", code: 2 }],
  ["no-tsconfig", { noTsconfig: true, code: 2 }],
  [
    "retired-before-rules",
    { rules: "missing", flags: ["--write-ceilings"], code: 2 },
  ],
  [
    "conflict-before-rules",
    {
      rules: "missing",
      flags: ["--ci", "--accept-crossings", "--reason=why"],
      code: 2,
    },
  ],
  ["reason-only", { flags: ["--reason=why"], code: 2 }],
  [
    "blank-reason",
    { flags: ["--accept-crossings", "--reason= \ufeff "], code: 2 },
  ],
  [
    "global-config-first",
    {
      flags: ["--thresholds=missing.json", "--write-ceilings"],
      stage: "stopped",
    },
  ],
  [
    "unreachable-first",
    {
      flags: [
        "--unreachable",
        "--accept-dead",
        "--ci",
        "--reason=why",
        "--write-ceilings",
      ],
      stage: "refused",
    },
  ],
  [
    "smell-first",
    {
      flags: ["--accept-smells", "--reason=why", "--write-ceilings"],
      stage: "refused",
    },
  ],
  [
    "layers-first",
    {
      flags: [
        "--layers",
        "--layer-rules=missing-layer.json",
        "--write-ceilings",
      ],
      stage: "layers",
    },
  ],
  ["api-first", { flags: ["--api=missing-api.json"], stage: "api" }],
  ["hexagon-first", { flags: ["--hexagon", "--json"], stage: "hexagon" }],
  [
    "later-flags",
    {
      flags: [
        "--comments",
        "--collapse",
        "--env-keys",
        "--graph",
        "--edges",
        "--deep",
        "--html",
        "--json",
      ],
      code: 0,
    },
  ],
  [
    "prepared-unreachable-unused",
    { flags: ["--unreachable", "--ci", "--json"], ci: true, code: 1 },
  ],
  ["bad-smell-ledger-unused", { ci: true, badSmell: true, code: 1 }],
  [
    "no-compiler",
    { withoutCompiler: true, flags: ["--edges", "--deep", "--json"], code: 0 },
  ],
  ["second-root-read", { removeMarker: true, flags: ["--json"], code: 0 }],
  ["zero-preserves-initial", { initial: 7, flags: ["--json"], code: 0 }],
  ["inactive", { inactive: true, initial: 7, stage: "continue" }],
  ["raw-scope", { rawRoot: true, rawArgv: true, flags: ["--json"], code: 0 }],
  [
    "raw-scope-no-tsconfig",
    { rawRoot: true, rawArgv: true, noTsconfig: true, code: 2 },
  ],
  [
    "raw-self-root",
    {
      rawRoot: true,
      rawArgv: true,
      selfMarker: true,
      flags: ["--json"],
      code: 0,
    },
  ],
  [
    "raw-self-no-tsconfig",
    {
      rawRoot: true,
      rawArgv: true,
      selfMarker: true,
      noTsconfig: true,
      code: 2,
    },
  ],
  [
    "raw-self-invalid-ledger",
    {
      rawRoot: true,
      rawArgv: true,
      selfMarker: true,
      invalidLedger: true,
      ci: true,
      code: 2,
    },
  ],
  [
    "raw-self-malformed-ceilings",
    {
      rawRoot: true,
      rawArgv: true,
      selfMarker: true,
      malformedCeilings: true,
      migrate: true,
      code: 2,
    },
  ],
  [
    "replacement-self-root",
    { replacementRoot: true, selfMarker: true, flags: ["--json"], code: 0 },
  ],
  [
    "supplementary-self-root",
    { supplementaryRoot: true, selfMarker: true, flags: ["--json"], code: 0 },
  ],
  [
    "library-census-requested-empty",
    { libraryCensus: true, flags: ["--json"], code: 0 },
  ],
  [
    "worker-census-requested-empty",
    { workerCensus: true, flags: ["--json"], code: 0 },
  ],
  [
    "both-censuses-requested-empty",
    {
      libraryCensus: true,
      workerCensus: true,
      flags: ["--json", "--pretty"],
      code: 0,
    },
  ],
  [
    "out-ci",
    { ci: true, out: "result.json", flags: ["--json", "--pretty"], code: 1 },
  ],
  [
    "out-accept-raw-reason",
    {
      accept: true,
      reason: " debt \ud800 λ ",
      rawArgv: true,
      out: "result.json",
      flags: ["--json", "--pretty"],
      code: 0,
    },
  ],
  [
    "out-missing-after-accept",
    { accept: true, out: "missing/result.json", expectedThrow: true },
  ],
  [
    "out-directory-initial",
    { ci: true, out: "apps/site", initial: 7, expectedThrow: true },
  ],
  ["out-null", { out: "raw\0\ud800", rawArgv: true, expectedThrow: true }],
  [
    "out-missing-after-migrate",
    {
      migrate: true,
      legacy: true,
      out: "missing/result.json",
      expectedThrow: true,
    },
  ],
  [
    "out-banner-bad",
    { accept: true, out: "result.txt", badStderr: true, code: 0 },
  ],
  [
    "out-banner-bad-initial",
    { out: "result.txt", badStderr: true, initial: 7, code: 0 },
  ],
  ["stdout-bad-report", { badStdout: true, code: 0 }],
  ["stdout-bad-ci", { badStdout: true, ci: true, code: 1 }],
  [
    "refusal-stderr-bad",
    { flags: ["--write-ceilings"], badStderr: true, code: 2 },
  ],
  ["stderr-unused", { badStderr: true, code: 0 }],
  ["stdout-unused-with-out", { badStdout: true, out: "result.txt", code: 0 }],
);

export function boundaryFixture(directory, options) {
  const root = path.join(directory, "repo");
  assert.ok(!fs.existsSync(root));
  fs.mkdirSync(root, { recursive: true });
  const relative = options.rawRoot
    ? "apps/raw\ud800"
    : options.replacementRoot
      ? "apps/raw\ufffd"
      : options.supplementaryRoot
        ? "apps/pair\u{10000}"
        : "apps/site";
  const app = path.join(root, relative);
  for (const [file, text] of Object.entries(sources)) put(app, file, text);
  put(root, "pnpm-workspace.yaml", "packages: []\n");
  put(app, "package.json", '{"name":"site","type":"module"}');
  if (!options.noTsconfig)
    put(
      app,
      "tsconfig.json",
      '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"},"include":["src/**/*.ts"]}',
    );
  if (options.selfMarker) put(app, "pnpm-workspace.yaml", "packages: []\n");
  if (options.noCrossing)
    put(app, "src/alpha/application/run.ts", "export const run=()=>1;\n");
  const scope = options.selfMarker ? "." : relative;
  const rules = {
    features: { [scope]: ["alpha", "beta"] },
    ...(options.libraryCensus ? { worldLibraries: ["not-installed-*"] } : {}),
    ...(options.workerCensus
      ? { acrossDeployables: ["worker-call-cycle"] }
      : {}),
  };
  let body = JSON.stringify(rules);
  if (options.rules === "malformed") body = "{broken";
  if (options.rules === "constructor")
    body = JSON.stringify({
      ...rules,
      bindingOwners: { [scope]: { constructor: null } },
    });
  if (options.rules === "pattern")
    body = JSON.stringify({ ...rules, testFiles: ["{"] });
  if (options.rules !== "missing") put(root, "rules.json", body);
  const ledgerRoot = options.selfMarker ? app : root;
  const entry = {
    from: `${scope}/src/alpha/application/run.ts`,
    kind: "cross-feature",
    scope,
    specifier: "../../beta/application/private.js",
    to: `${scope}/src/beta/application/private.ts`,
    reason: "previous decision",
  };
  if (options.ledger)
    put(
      ledgerRoot,
      "boundary-ledger.json",
      JSON.stringify({ entries: [entry] }),
    );
  if (options.legacy)
    put(ledgerRoot, "boundary-ceilings.json", '{"default":1}');
  if (options.invalidLedger) put(ledgerRoot, "boundary-ledger.json", "{broken");
  if (options.malformedCeilings)
    put(ledgerRoot, "boundary-ceilings.json", "{broken");
  if (options.badSmell) put(root, "smell-ledger.json", "{broken");
  const argv = [
    relative,
    ...(options.inactive ? ["--graph"] : ["--boundaries"]),
    ...(options.defaultRules ? [] : ["--boundary-rules=rules.json"]),
    ...(options.ci ? ["--ci"] : []),
    ...(options.accept
      ? ["--accept-crossings", "--reason", options.reason ?? " temporary debt "]
      : []),
    ...(options.migrate ? ["--migrate-ceilings"] : []),
    ...(options.flags ?? []),
    ...(options.out === undefined ? [] : ["--out", options.out]),
  ];
  return { root, app, relative, scope, ledgerRoot, argv };
}
