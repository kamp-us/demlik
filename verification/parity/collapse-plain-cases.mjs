import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collapseFixture, put } from "./collapse-gate-cases.mjs";

export function invoice(name, fallback) {
  return `import {normalizeId,selectRole} from './helpers.js';\nexport function ${name}(input:{id:string;role:string}){\n const id=normalizeId(input.id);\n const role=selectRole(input.role);\n if(role===''){\n  return {id,role:'${fallback}'};\n }\n return {id,role};\n}\n`;
}
export function plainFixture(location, options) {
  const f = collapseFixture(location, {
    ...options,
    flags: options.flags ?? [],
  });
  if (!options.retry) {
    for (const file of ["limits.ts", "retry.ts"])
      fs.rmSync(path.join(f.root, f.physical, file), { force: true });
    put(
      f.root,
      `${f.physical}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["**/*.ts"],
      }),
    );
    put(
      f.root,
      `${f.physical}/helpers.ts`,
      "export function normalizeId(value:string){return value.trim();}\nexport function selectRole(value:string){return value.toLowerCase();}\n",
    );
    put(f.root, `${f.physical}/api.ts`, invoice("normalizeInvoice", "guest"));
    put(
      f.root,
      `${f.physical}/worker.ts`,
      invoice("canonicalInvoice", "member"),
    );
    if (options.empty)
      for (const file of ["helpers.ts", "api.ts", "worker.ts"])
        fs.rmSync(path.join(f.root, f.physical, file));
    if (options.noConfig)
      fs.rmSync(path.join(f.root, f.physical, "tsconfig.json"));
  }
  if (options.badTsConfig)
    put(f.root, `${f.physical}/tsconfig.json`, "{broken");
  if (options.kindFailure)
    put(f.root, "kind-rules.json", '{"kinds":{"constructor":null}}');
  if (options.dataFixture) {
    put(
      f.root,
      `${f.physical}/wrangler.json`,
      JSON.stringify({
        name: "invoices",
        main: "api.ts",
        kv_namespaces: [{ binding: "CACHE", id: "invoice-cache" }],
      }),
    );
    put(
      f.root,
      `${f.physical}/cache.ts`,
      "declare const env:{CACHE:{get(key:string):string}};\nexport function readInvoice(key:string){return env.CACHE.get(key);}\n",
    );
  }
  if (options.freshDataRoot) {
    put(
      f.root,
      "outside/wrangler.json",
      JSON.stringify({
        name: "outside",
        kv_namespaces: [{ binding: "OLD", id: "old" }],
      }),
    );
    put(
      f.root,
      `${f.physical}/wrangler.json`,
      JSON.stringify({
        name: "inside",
        kv_namespaces: [{ binding: "CACHE", id: "new" }],
      }),
    );
  }
  if (options.preparedUnreachable)
    put(f.root, "unreachable-ledger.json", '{"entries":[]}');
  const git = spawnSync("git", ["init", "--quiet", "--template=", f.root], {
    encoding: "utf8",
  });
  assert.ifError(git.error);
  assert.equal(git.status, 0, git.stderr);
  return f;
}
export const plainSteps = [
  { id: "base", expectedClusters: 1, expectedPairs: 1, expectedPartials: 0 },
  { id: "repeat", expectedClusters: 1, expectedPairs: 1, expectedPartials: 0 },
  {
    id: "add-third",
    edit: "third",
    expectedClusters: 1,
    expectedPairs: 3,
    expectedPartials: 0,
  },
  {
    id: "remove-third",
    edit: "remove-third",
    expectedClusters: 1,
    expectedPairs: 1,
    expectedPartials: 0,
  },
  { id: "add-decision-pair", edit: "decision", expectedPartials: 1 },
  {
    id: "remove-decision-pair",
    edit: "remove-decision",
    expectedClusters: 1,
    expectedPairs: 1,
    expectedPartials: 0,
  },
  {
    id: "return-base",
    expectedClusters: 1,
    expectedPairs: 1,
    expectedPartials: 0,
  },
];
export function editPlain(f, step) {
  if (step.edit === "third")
    put(f.root, `${f.physical}/third.ts`, invoice("settleInvoice", "fallback"));
  if (step.edit === "remove-third")
    fs.rmSync(path.join(f.root, f.physical, "third.ts"));
  if (step.edit === "decision") {
    const source = new URL("./fixtures/collapse-partial/", import.meta.url);
    for (const file of ["limits.ts", "helpers.ts", "retry.ts"])
      put(
        f.root,
        `${f.physical}/decision/${file}`,
        fs.readFileSync(new URL(file, source)),
      );
  }
  if (step.edit === "remove-decision")
    fs.rmSync(path.join(f.root, f.physical, "decision"), { recursive: true });
}
export const plainCases = [
  ["invoice-workflow", { workflow: true }],
  ["json-compact", { flags: ["--json"] }],
  ["json-pretty", { flags: ["--json", "--pretty"] }],
  ["pretty-human", { flags: ["--pretty"] }],
  ["out-file", { out: "result.txt" }],
  ["out-existing-mode", { out: "old.txt", outReadonly: true }],
  ["out-json-pretty", { flags: ["--json", "--pretty"], out: "result.json" }],
  ["initial-exit-preserved", { initial: 7 }],
  ["by-warning", { flags: ["--by", "loc"] }],
  ["by-rot-silent", { flags: ["--by", "rot"] }],
  ["plan-suppresses-by-warning", { flags: ["--plan", "--by", "loc"] }],
  ["deep-scope", { flags: ["--deep", "--json"], rootConfig: true }],
  ["deep-missing-root-config", { flags: ["--deep"] }],
  ["headers-graph-priority", { flags: ["--graph", "--headers"] }],
  ["graph-pretty-ignores-json", { flags: ["--graph", "--pretty"] }],
  [
    "analysis-flags",
    { flags: ["--unguarded", "--clusters", "--interface-width", "--json"] },
  ],
  ["unreachable-lower-priority", { flags: ["--unreachable"] }],
  [
    "later-flags-not-interpreted",
    {
      flags: [
        "--hotspots",
        "--hotspots-days",
        "bad",
        "--blast",
        "missing",
        "--find",
        "missing",
        "--file",
        "missing",
        "--tree",
        "--smells",
      ],
    },
  ],
  ["custom-settings", { config: '{"minSignals":3,"nameOverlap":0.75}' }],
  ["empty-loaded-graph", { empty: true }],
  ["data-in-graph", { flags: ["--data", "--graph"], dataFixture: true }],
  [
    "fresh-data-root-after-warning",
    { flags: ["--data", "--graph", "--by", "loc"], freshDataRoot: true },
  ],
  ["missing-tsconfig", { noConfig: true }],
  ["malformed-tsconfig", { badTsConfig: true }],
  [
    "warning-before-load-refusal",
    { noConfig: true, flags: ["--by", "loc"], initial: 7 },
  ],
  ["raw-root-load-refusal", { rawRoot: true, noConfig: true, rawArgv: true }],
  [
    "missing-compiler-is-not-load-refusal",
    { withoutCompiler: true, nativeOnly: true },
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
  ["warning-before-output", { retry: true, warning: true }],
  [
    "warning-before-later-failure",
    { retry: true, warning: true, drift: true, catalogFailure: true },
  ],
  [
    "data-catalog-failure",
    { retry: true, catalogFailure: true, flags: ["--data"] },
  ],
  [
    "config-refused-before-load",
    { config: '{"partialMinPrefix":1}', noConfig: true, withoutCompiler: true },
  ],
  [
    "thresholds-before-collapse",
    { flags: ["--thresholds", "missing.json"], withoutCompiler: true },
  ],
  [
    "api-before-collapse",
    { flags: ["--api", "missing-api.json"], withoutCompiler: true },
  ],
  ["layers-before-collapse", { flags: ["--layers"], withoutCompiler: true }],
  [
    "boundaries-before-collapse",
    { flags: ["--boundaries"], withoutCompiler: true },
  ],
  [
    "env-before-collapse",
    { flags: ["--env-keys", "--json"], withoutCompiler: true },
  ],
  [
    "comments-before-collapse",
    { flags: ["--comments"], withoutCompiler: true },
  ],
  ["early-collapse-ci", { retry: true, match: true, flags: ["--ci"] }],
  ["early-collapse-write", { retry: true, flags: ["--write-ceilings"] }],
  ["inactive-continuation", { inactive: true, nativeOnly: true }],
  ["html-continuation", { flags: ["--html"], nativeOnly: true }],
  [
    "prepared-unreachable-continuation",
    {
      flags: ["--unreachable", "--accept-dead", "--reason", "reviewed"],
      preparedUnreachable: true,
      nativeOnly: true,
    },
  ],
];
assert.equal(new Set(plainCases.map(([id]) => id)).size, plainCases.length);
