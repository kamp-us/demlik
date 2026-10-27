import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const retryDir = fileURLToPath(
  new URL("./fixtures/collapse-partial/", import.meta.url),
);
export const third =
  "\nexport function settleTransientStep(state:{attempts:number}) {\n  const count=noteAttempt(state);\n  const decision=decide(count,MAX_ATTEMPTS);\n  logAttempt(count);\n  if(decision==='give_up') {\n    return settlePending(decision);\n  }\n  return String(armTimer(BACKOFF));\n}\n";
export function put(root, file, bytes) {
  const p = path.join(root, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
}
export function collapseFixture(location, o) {
  const root = path.join(location, "repo");
  assert.ok(!fs.existsSync(root));
  fs.mkdirSync(root, { recursive: true });
  put(root, "pnpm-workspace.yaml", "packages: []\n");
  put(root, "readonly.txt", "");
  let target = o.target ?? "packages/retry";
  if (o.rawRoot) target = "packages/raw\ud800";
  const physical = target === "." ? "packages/retry" : target.toWellFormed();
  for (const pkg of [physical, "packages/second"]) {
    put(root, `${pkg}/package.json`, "{}");
    for (const f of ["tsconfig.json", "limits.ts", "helpers.ts", "retry.ts"])
      put(root, `${pkg}/${f}`, fs.readFileSync(path.join(retryDir, f)));
  }
  if (o.empty) {
    for (const f of ["limits.ts", "helpers.ts", "retry.ts"])
      fs.rmSync(path.join(root, physical, f));
    put(root, `${physical}/empty.ts`, "export const empty=1;\n");
  }
  if (o.noConfig) fs.rmSync(path.join(root, physical, "tsconfig.json"));
  if (o.selfMarker)
    put(root, `${physical}/pnpm-workspace.yaml`, "packages: []\n");
  const policyDir = o.selfMarker ? physical : "";
  let policy = o.policy;
  if (policy === undefined && o.match)
    policy = JSON.stringify({ default: 0, scopes: { [target]: 1 } });
  if (policy !== undefined)
    put(root, path.join(policyDir, "collapse-ceilings.json"), policy);
  if (o.policyDirectory)
    fs.mkdirSync(path.join(root, policyDir, "collapse-ceilings.json"));
  if (o.policyMode)
    fs.chmodSync(
      path.join(root, policyDir, "collapse-ceilings.json"),
      o.policyMode,
    );
  if (o.badUnreachable) put(root, "unreachable-ledger.json", "{broken");
  if (o.badSmell) put(root, "smell-ledger.json", "{broken");
  if (o.config !== undefined) put(root, "collapse.json", o.config);
  if (o.warning) {
    put(
      root,
      `${physical}/escaped.ts`,
      "export interface \\u0055 { value:number }\nexport const \\u0056=1;\nexport function run(){return 1;}\n",
    );
  }
  if (o.catalogFailure)
    put(root, "wrangler.json", '{"name":"worker","vars":{"constructor":null}}');
  if (o.outReadonly) {
    put(root, o.out, "old-output\n");
    fs.chmodSync(path.join(root, o.out), 0o400);
  }
  if (o.rootConfig)
    put(
      root,
      "tsconfig.json",
      '{"compilerOptions":{"strict":true,"types":[]},"include":["packages/**/*.ts"]}',
    );
  if (o.secondMarker) {
    put(root, `${physical}/pnpm-workspace.yaml`, "packages: []\n");
    put(
      root,
      `${physical}/collapse-ceilings.json`,
      '{"default":17,"scopes":{".":9}}',
    );
  }
  return {
    root,
    target,
    physical,
    argv: [
      target,
      ...(o.inactive ? [] : ["--collapse"]),
      ...(o.flags ?? ["--ci"]),
      ...(o.config === undefined ? [] : ["--collapse-config", "collapse.json"]),
      ...(o.out === undefined ? [] : ["--out", o.out]),
    ],
  };
}
export const collapseCases = [
  ["retry-workflow", { workflow: true, flags: ["--write-ceilings"] }],
  ["ci-pass-text", { match: true }],
  ["ci-pass-json", { match: true, flags: ["--ci", "--json"] }],
  ["ci-pass-pretty", { match: true, flags: ["--ci", "--json", "--pretty"] }],
  ["ci-exceeded", { policy: '{"scopes":{"packages/retry":0}}' }],
  ["ci-slack", { policy: '{"scopes":{"packages/retry":2}}' }],
  [
    "ci-mixed-advice",
    {
      target: ".",
      rootConfig: true,
      policy: '{"scopes":{"packages/retry":0,"packages/second":2}}',
    },
  ],
  [
    "ci-two-scopes",
    {
      target: ".",
      rootConfig: true,
      policy: '{"scopes":{"packages/second":1,"packages/retry":1}}',
    },
  ],
  [
    "ci-excludes-sibling",
    {
      match: true,
      policy: '{"scopes":{"packages/retry":1,"packages/second":99}}',
    },
  ],
  [
    "ci-own-scope-and-child",
    {
      target: ".",
      rootConfig: true,
      policy: '{"scopes":{".":6,"packages/retry":1}}',
    },
  ],
  ["ci-missing-policy", { withoutCompiler: true }],
  [
    "ci-no-recorded-scope",
    { policy: '{"default":7,"scopes":{"other":7}}', withoutCompiler: true },
  ],
  ["ci-policy-directory", { policyDirectory: true, withoutCompiler: true }],
  [
    "ci-number-overflow",
    { policy: '{"default":1e309}', withoutCompiler: true },
  ],
  ["ci-malformed", { policy: "{broken", withoutCompiler: true }],
  ["ci-schema-null", { policy: "null", withoutCompiler: true }],
  ["ci-schema-negative", { policy: '{"default":-1}', withoutCompiler: true }],
  [
    "ci-schema-fraction",
    { policy: '{"scopes":{"packages/retry":0.5}}', withoutCompiler: true },
  ],
  ["ci-schema-unknown", { policy: '{"unknown":true}', withoutCompiler: true }],
  [
    "ci-schema-unsafe",
    { policy: '{"default":9007199254740992}', withoutCompiler: true },
  ],
  [
    "ci-record-constructor-null",
    { policy: '{"scopes":{"constructor":null}}', withoutCompiler: true },
  ],
  ["write-new", { flags: ["--write-ceilings"] }],
  [
    "write-repeat-existing",
    {
      policy: '{"default":17,"scopes":{"obsolete":8,"packages/second":4}}',
      flags: ["--write-ceilings"],
    },
  ],
  [
    "write-preserves-mode",
    { match: true, policyMode: 0o640, flags: ["--write-ceilings"] },
  ],
  [
    "write-wins-ci-existing",
    {
      policy: '{"scopes":{"packages/retry":9}}',
      flags: ["--ci", "--write-ceilings"],
    },
  ],
  ["write-wins-ci-missing", { flags: ["--ci", "--write-ceilings"] }],
  ["write-out", { flags: ["--write-ceilings"], out: "result.txt" }],
  [
    "write-out-same",
    { flags: ["--write-ceilings"], out: "collapse-ceilings.json" },
  ],
  [
    "write-out-missing",
    { flags: ["--write-ceilings"], out: "missing/result.txt" },
  ],
  ["write-out-directory", { flags: ["--write-ceilings"], out: "." }],
  [
    "write-out-nul",
    { flags: ["--write-ceilings"], out: "bad\0result.txt", rawArgv: true },
  ],
  [
    "write-out-readonly",
    { flags: ["--write-ceilings"], out: "old.txt", outReadonly: true },
  ],
  [
    "write-policy-readonly",
    { match: true, policyMode: 0o400, flags: ["--write-ceilings"] },
  ],
  [
    "ci-out-missing-initial",
    {
      policy: '{"scopes":{"packages/retry":0}}',
      out: "missing/result.txt",
      initial: 7,
    },
  ],
  ["zero-preserves-initial", { match: true, initial: 7 }],
  [
    "one-replaces-initial",
    { policy: '{"scopes":{"packages/retry":0}}', initial: 7 },
  ],
  ["write-preserves-initial", { flags: ["--write-ceilings"], initial: 7 }],
  ["refusal-replaces-initial", { withoutCompiler: true, initial: 7 }],
  [
    "config-changes-count",
    { flags: ["--write-ceilings"], config: '{"partialMinPrefix":4}' },
  ],
  [
    "config-zero-min-loc",
    { flags: ["--write-ceilings"], config: '{"minLoc":0,"minComplexity":0}' },
  ],
  [
    "config-refused-before-policy",
    {
      config: '{"partialMinPrefix":1}',
      policy: "{broken",
      withoutCompiler: true,
    },
  ],
  [
    "thresholds-first",
    {
      flags: [
        "--ci",
        "--thresholds",
        "missing.json",
        "--collapse-config",
        "missing-collapse.json",
      ],
      withoutCompiler: true,
    },
  ],
  [
    "unreachable-before-collapse",
    {
      flags: ["--ci", "--unreachable", "--write-ceilings"],
      badUnreachable: true,
      withoutCompiler: true,
    },
  ],
  [
    "smell-before-collapse",
    { flags: ["--ci", "--smells"], badSmell: true, withoutCompiler: true },
  ],
  [
    "api-priority",
    { flags: ["--ci", "--api", "missing-api.json"], withoutCompiler: true },
  ],
  ["layers-priority", { flags: ["--ci", "--layers"], withoutCompiler: true }],
  [
    "boundaries-priority",
    { flags: ["--ci", "--boundaries"], withoutCompiler: true },
  ],
  [
    "env-keys-priority",
    { flags: ["--ci", "--env-keys", "--json"], withoutCompiler: true },
  ],
  [
    "comments-priority",
    { flags: ["--ci", "--comments"], withoutCompiler: true },
  ],
  [
    "ignore-later-flags",
    {
      flags: [
        "--ci",
        "--deep",
        "--data",
        "--headers",
        "--by",
        "bad",
        "--html",
        "--cycles",
        "--find",
        "symbol",
      ],
      match: true,
    },
  ],
  ["missing-tsconfig", { flags: ["--write-ceilings"], noConfig: true }],
  [
    "ci-first-sorted-load-failure",
    {
      target: ".",
      policy: '{"scopes":{"packages/zmissing":0,"packages/amissing":0}}',
    },
  ],
  ["empty-project-record", { empty: true, flags: ["--write-ceilings"] }],
  [
    "historical-proto-record",
    { target: "__proto__", flags: ["--write-ceilings"] },
  ],
  [
    "historical-constructor-record",
    { target: "constructor", flags: ["--write-ceilings"] },
  ],
  [
    "raw-policy-refusal",
    {
      rawRoot: true,
      selfMarker: true,
      policy: "{broken",
      rawArgv: true,
      withoutCompiler: true,
    },
  ],
  [
    "raw-loader-error",
    {
      rawRoot: true,
      flags: ["--write-ceilings"],
      noConfig: true,
      rawArgv: true,
    },
  ],
  [
    "raw-record",
    {
      rawRoot: true,
      selfMarker: true,
      flags: ["--write-ceilings"],
      rawArgv: true,
    },
  ],
  ["second-root-record", { flags: ["--write-ceilings"], secondMarker: true }],
  ["warning-before-output", { warning: true, flags: ["--write-ceilings"] }],
  [
    "warning-before-later-failure",
    {
      warning: true,
      drift: true,
      catalogFailure: true,
      flags: ["--write-ceilings"],
    },
  ],
  ["write-stdout-bad", { flags: ["--write-ceilings"], badStdout: true }],
  [
    "write-banner-bad",
    { flags: ["--write-ceilings"], out: "result.txt", badStderr: true },
  ],
  ["ci-stderr-bad", { withoutCompiler: true, badStderr: true }],
  [
    "warning-then-stdout-bad",
    { warning: true, flags: ["--write-ceilings"], badStdout: true },
  ],
  [
    "warning-and-banner-stderr-bad",
    {
      warning: true,
      flags: ["--write-ceilings"],
      out: "result.txt",
      badStderr: true,
    },
  ],
  ["bare-collapse-continues", { flags: [] }],
  ["ci-without-collapse-continues", { inactive: true }],
];
assert.equal(
  new Set(collapseCases.map(([id]) => id)).size,
  collapseCases.length,
);
