import fs from "node:fs";
import path from "node:path";
import { put } from "./collapse-gate-cases.mjs";
import { plainFixture } from "./collapse-plain-cases.mjs";

export function reportsFixture(location, o) {
  const f = plainFixture(location, {
    ...o,
    flags: [],
    target: o.target ?? "packages/billing",
  });
  for (const pkg of [f.physical, "packages/second"]) {
    for (const file of fs.readdirSync(path.join(f.root, pkg)))
      if (/\.tsx?$/.test(file)) fs.rmSync(path.join(f.root, pkg, file));
    put(
      f.root,
      `${pkg}/package.json`,
      JSON.stringify({
        name: pkg.endsWith("second") ? "second" : "billing",
        private: true,
        ...(o.width
          ? {
              exports: {
                "./api": "./api.ts",
                "./worker": "./worker.ts",
                "./helpers": "./helpers.ts",
                "./cycle": "./cycle.ts",
              },
            }
          : {}),
      }),
    );
    put(
      f.root,
      `${pkg}/tsconfig.json`,
      '{"compilerOptions":{"strict":true,"types":[],"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext"},"include":["**/*.ts"]}',
    );
    put(
      f.root,
      `${pkg}/helpers.ts`,
      "import {cycle} from './cycle.js';\nexport function unit(n:number){return cycle(n)+1;}\nexport function round(n:number){return Math.round(n);}\n",
    );
    put(
      f.root,
      `${pkg}/cycle.ts`,
      "import {round} from './helpers.js';\nexport function cycle(n:number){return round(n);}\n",
    );
    put(
      f.root,
      `${pkg}/api.ts`,
      `import {unit} from './helpers.js';\n${pkg === f.physical ? "import {round as externalRound} from '../second/helpers.js';\n" : ""}export function invoice(n:number){if(n>0){if(n>9)return unit(n);return n+1;}return 0;}\nexport function idle(){return 0;}\n`,
    );
    put(
      f.root,
      `${pkg}/worker.ts`,
      "import {invoice} from './api.js';\ndeclare const env:{CACHE:{get(key:string):string;put(key:string,value:string):void};PRICING:{fetch(key:string):Promise<unknown>}};\nexport function serve(key:string){invoice(key.length);env.CACHE.put(key,'v');env.PRICING.fetch(key);return env.CACHE.get(key);}\nenv.CACHE.get('startup');\n",
    );
    put(
      f.root,
      `${pkg}/wrangler.json`,
      JSON.stringify({
        name:
          o.rawData && pkg === f.physical
            ? "billing\ud800"
            : pkg.endsWith("second")
              ? "second"
              : "billing",
        main: "worker.ts",
        kv_namespaces: [{ binding: "CACHE", id: "cache" }],
        services: [{ binding: "PRICING", service: "second" }],
      }),
    );
    if (o.noConfig || o.cheap)
      fs.rmSync(path.join(f.root, pkg, "tsconfig.json"));
  }
  if (!o.noConfig && !o.cheap)
    put(
      f.root,
      "tsconfig.json",
      '{"compilerOptions":{"strict":true,"types":[],"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext"},"include":["packages/**/*.ts"]}',
    );
  if (o.parseFailure)
    put(f.root, `${f.physical}/broken.ts`, "export function broken( {\n");
  put(
    f.root,
    "thresholds.json",
    JSON.stringify({
      highComplexity: o.smell ? 1 : 100,
      dependencyCycle: o.coupling ? 1 : 100,
      crossBoundaryImports: o.coupling ? 0 : 100,
    }),
  );
  put(
    f.root,
    "kind-rules.json",
    JSON.stringify({
      entryNames: { "console-entry": ["^serve$"] },
      effectDeclarations: { "console-effect": ["Math\\.round$"] },
    }),
  );
  if (o.preparedSmell)
    put(
      f.root,
      "smell-ledger.json",
      '{"gated":["high-complexity"],"entries":[]}',
    );
  if (o.preparedUnreachable)
    put(f.root, "unreachable-ledger.json", '{"entries":[]}');
  if (o.catalogFailure)
    put(
      f.root,
      "wrangler.json",
      '{"name":"broken","vars":{"constructor":null}}',
    );
  if (o.empty)
    for (const pkg of [f.physical, "packages/second"])
      for (const file of fs.readdirSync(path.join(f.root, pkg)))
        if (/\.tsx?$/.test(file)) fs.rmSync(path.join(f.root, pkg, file));
  if (o.outDirectory) fs.mkdirSync(path.join(f.root, "directory-out"));
  if (o.outMode) {
    put(f.root, o.out, "old-output\n");
    fs.chmodSync(path.join(f.root, o.out), o.outMode);
  }
  f.base = [
    "--thresholds",
    "thresholds.json",
    "--node-kinds",
    "kind-rules.json",
  ];
  f.argv = [
    f.target,
    ...(o.flags ?? []),
    ...(o.edgeFlag ? ["--edges"] : []),
    ...f.base,
    ...(o.out === undefined ? [] : ["--out", o.out]),
  ];
  return f;
}
export const reportSteps = [
  {
    id: "summary-file",
    flags: [],
    out: "report.json",
    mode: "summary",
    files: 4,
    functions: 6,
  },
  {
    id: "repeat-file",
    flags: [],
    out: "report.json",
    mode: "summary",
    files: 4,
    functions: 6,
  },
  { id: "plan", flags: ["--plan", "--json"], mode: "plan", functions: 6 },
  { id: "ordinary-ci", flags: ["--ci"], mode: "ci", exit: 0 },
  {
    id: "whole-graph",
    target: ".",
    flags: ["--graph", "--edges"],
    mode: "graph",
    files: 8,
    functions: 12,
  },
  {
    id: "coupling",
    target: ".",
    flags: ["--smells", "--edges"],
    mode: "smells",
    coupling: true,
  },
  { id: "data", flags: ["--data", "--json"], mode: "data" },
  {
    id: "second-file",
    target: ".",
    flags: ["--file", "packages/second/api.ts"],
    mode: "file",
  },
  {
    id: "second-summary",
    target: "packages/second",
    flags: [],
    mode: "summary",
    files: 4,
    functions: 6,
  },
];
export const reportCases = [
  ["two-package-console-workflow", { workflow: true, coupling: true }],
  [
    "default-cheap-no-compiler",
    {
      cheap: true,
      withoutCompiler: true,
      mode: "summary",
      files: 4,
      functions: 6,
    },
  ],
  [
    "default-pretty",
    {
      cheap: true,
      flags: ["--pretty"],
      mode: "summary",
      files: 4,
      functions: 6,
    },
  ],
  [
    "default-json-has-summary-payload",
    { cheap: true, flags: ["--json"], mode: "summary", files: 4, functions: 6 },
  ],
  [
    "default-bare-ceilings",
    {
      cheap: true,
      flags: ["--write-ceilings"],
      mode: "summary",
      files: 4,
      functions: 6,
    },
  ],
  [
    "default-empty",
    { cheap: true, empty: true, mode: "summary", files: 0, functions: 0 },
  ],
  [
    "summary-out-mode",
    {
      cheap: true,
      out: "existing.json",
      outMode: 0o640,
      mode: "summary",
      files: 4,
      functions: 6,
    },
  ],
  [
    "summary-initial-preserved",
    {
      cheap: true,
      initial: 7,
      mode: "summary",
      files: 4,
      functions: 6,
      exit: 7,
    },
  ],
  [
    "graph-cheap",
    { cheap: true, flags: ["--graph"], mode: "graph", files: 4, functions: 6 },
  ],
  [
    "graph-pretty",
    {
      flags: ["--graph", "--edges", "--pretty"],
      mode: "graph",
      files: 4,
      functions: 6,
    },
  ],
  [
    "graph-wins-plan-axis",
    {
      cheap: true,
      flags: ["--graph", "--plan", "--by", "unknown"],
      mode: "graph",
      files: 4,
      functions: 6,
    },
  ],
  [
    "graph-losing-unguarded-runs-analysis",
    {
      flags: ["--graph", "--unguarded"],
      mode: "graph",
      files: 4,
      functions: 6,
      reach: true,
    },
  ],
  [
    "graph-empty-blast-still-needs-edge-pass",
    {
      flags: ["--graph", "--blast", ""],
      mode: "graph",
      files: 4,
      functions: 6,
    },
  ],
  [
    "graph-empty-find-still-needs-edge-pass",
    { flags: ["--graph", "--find", ""], mode: "graph", files: 4, functions: 6 },
  ],
  ...["rot", "complexity", "size"].map((axis) => [
    `plan-${axis}`,
    {
      cheap: true,
      flags: ["--plan", "--by", axis],
      mode: "plan",
      functions: 6,
    },
  ]),
  [
    "plan-json",
    { cheap: true, flags: ["--plan", "--json"], mode: "plan", functions: 6 },
  ],
  [
    "plan-pretty",
    {
      cheap: true,
      flags: ["--plan", "--json", "--pretty"],
      mode: "plan",
      functions: 6,
    },
  ],
  [
    "plan-unknown-axis",
    {
      cheap: true,
      flags: ["--plan", "--by", "unknown"],
      mode: "plan",
      functions: 6,
      warning: "unknown --by axis",
    },
  ],
  [
    "plan-impact-needs-edges",
    {
      cheap: true,
      flags: ["--plan", "--by", "impact"],
      exit: 2,
      refusal: "--by impact needs the call graph",
    },
  ],
  [
    "plan-impact-real-edges",
    {
      flags: ["--plan", "--by", "impact"],
      mode: "plan",
      functions: 6,
      edgeFlag: true,
    },
  ],
  [
    "unused-by-warning-before-summary",
    {
      cheap: true,
      flags: ["--by", "size"],
      mode: "summary",
      files: 4,
      functions: 6,
      warning: "has no effect without --plan",
    },
  ],
  [
    "smells-human",
    {
      cheap: true,
      smell: true,
      flags: ["--smells"],
      mode: "smells",
      smells: true,
    },
  ],
  [
    "smells-json",
    {
      cheap: true,
      smell: true,
      flags: ["--smells", "--json"],
      mode: "smells",
      smells: true,
    },
  ],
  [
    "smells-pretty",
    {
      cheap: true,
      smell: true,
      flags: ["--smells", "--json", "--pretty"],
      mode: "smells",
      smells: true,
    },
  ],
  [
    "smells-empty",
    { cheap: true, flags: ["--smells"], mode: "smells", smells: false },
  ],
  [
    "smells-real-coupling",
    {
      target: ".",
      flags: ["--smells", "--edges"],
      mode: "smells",
      coupling: true,
    },
  ],
  [
    "ci-pass-cheap",
    {
      cheap: true,
      withoutCompiler: true,
      flags: ["--ci"],
      mode: "ci",
      exit: 0,
    },
  ],
  [
    "ci-high-fails",
    { cheap: true, smell: true, flags: ["--ci"], mode: "ci", exit: 1 },
  ],
  [
    "ci-warn-fails",
    {
      cheap: true,
      smell: true,
      flags: ["--ci", "--fail-on", "warn"],
      mode: "ci",
      exit: 1,
    },
  ],
  [
    "ci-max-zero-fails",
    {
      cheap: true,
      smell: true,
      flags: ["--ci", "--max", "0"],
      mode: "ci",
      exit: 1,
    },
  ],
  [
    "ci-max-infinity",
    {
      cheap: true,
      flags: ["--ci", "--max", "9".repeat(400)],
      mode: "ci",
      exit: 0,
      contains: "max Infinity",
    },
  ],
  [
    "ci-max-whitespace-leading-zero",
    {
      cheap: true,
      flags: ["--ci", "--max", "\u00a0\ufeff0002\n"],
      mode: "ci",
      exit: 0,
      contains: "max 2",
    },
  ],
  [
    "ci-unknown-policy-before-invalid-max",
    {
      cheap: true,
      flags: ["--ci", "--fail-on", "bad", "--max", "-1"],
      mode: "ci-invalid",
      exit: 2,
    },
  ],
  [
    "ci-empty-max",
    { cheap: true, flags: ["--ci", "--max", ""], mode: "ci-invalid", exit: 2 },
  ],
  [
    "ci-ignores-output-destination",
    {
      cheap: true,
      flags: ["--ci"],
      out: "directory-out",
      outDirectory: true,
      mode: "ci",
      exit: 0,
    },
  ],
  [
    "ci-zero-preserves-initial",
    {
      cheap: true,
      flags: ["--ci"],
      initial: 7,
      mode: "ci",
      exit: 7,
      passed: true,
    },
  ],
  [
    "ci-beats-graph-and-html",
    { flags: ["--ci", "--graph", "--html"], mode: "ci", exit: 0 },
  ],
  ...[
    ["unguarded", "unguarded:"],
    ["clusters", "clusters:"],
    ["interface-width", "interface width:"],
    ["cycles", "cycles:"],
    ["kinds", "kinds:"],
    ["cross-runtime", "cross-runtime:"],
  ].flatMap(([flag, head]) => [
    [
      `${flag}-text`,
      {
        flags: [`--${flag}`],
        mode: flag,
        head,
        width: flag === "interface-width",
      },
    ],
    [
      `${flag}-json`,
      {
        flags: [`--${flag}`, "--json"],
        mode: flag,
        width: flag === "interface-width",
      },
    ],
    [
      `${flag}-pretty`,
      {
        flags: [`--${flag}`, "--json", "--pretty"],
        mode: flag,
        width: flag === "interface-width",
      },
    ],
  ]),
  [
    "cycles-whole-workspace",
    { target: ".", flags: ["--cycles", "--json"], mode: "cycles", cycles: 2 },
  ],
  [
    "data-text-cheap",
    {
      cheap: true,
      withoutCompiler: true,
      flags: ["--data"],
      mode: "data",
      head: "data:",
    },
  ],
  [
    "data-json-cheap",
    { cheap: true, flags: ["--data", "--json"], mode: "data" },
  ],
  [
    "data-pretty-cheap",
    { cheap: true, flags: ["--data", "--json", "--pretty"], mode: "data" },
  ],
  [
    "data-raw-json",
    { cheap: true, rawData: true, flags: ["--data", "--json"], mode: "data" },
  ],
  [
    "data-raw-human-encoded",
    {
      cheap: true,
      rawData: true,
      flags: ["--data"],
      mode: "data",
      head: "data:",
      rawPayload: true,
    },
  ],
  [
    "file-cwd-relative",
    { cheap: true, flags: ["--file", "packages/billing/api.ts"], mode: "file" },
  ],
  [
    "file-literal-fallback",
    { cheap: true, flags: ["--file", "api.ts", "--pretty"], mode: "file" },
  ],
  [
    "file-missing-warning",
    {
      cheap: true,
      flags: ["--file", "missing.ts"],
      mode: "file-warning",
      warning: "not in the analyzed graph",
      initial: 7,
      exit: 7,
    },
  ],
  [
    "file-parse-failure-warning",
    {
      cheap: true,
      parseFailure: true,
      flags: ["--file", "broken.ts"],
      mode: "file-warning",
      warning: "failed to parse and was excluded",
    },
  ],
  [
    "missing-config-before-invalid-ci-max",
    {
      noConfig: true,
      flags: ["--ci", "--cycles", "--max", "bad"],
      loadRefused: true,
      exit: 2,
    },
  ],
  [
    "warning-before-edge-load-refusal",
    {
      noConfig: true,
      flags: ["--graph", "--edges", "--by", "size"],
      loadRefused: true,
      exit: 2,
      warning: "has no effect without --plan",
    },
  ],
  [
    "catalog-failure-propagates",
    { cheap: true, catalogFailure: true, flags: ["--data"], exception: true },
  ],
  [
    "output-directory-failure",
    { cheap: true, out: "directory-out", outDirectory: true, exception: true },
  ],
  [
    "bad-stdout-ordinary-ci",
    { cheap: true, flags: ["--ci"], badStdout: true, pending: true },
  ],
  [
    "bad-stderr-invalid-ci",
    {
      cheap: true,
      flags: ["--ci", "--fail-on", "bad", "--max", "-1"],
      badStderr: true,
      pending: true,
    },
  ],
  [
    "prepared-smell-before-ordinary-ci",
    {
      cheap: true,
      smell: true,
      preparedSmell: true,
      flags: ["--ci", "--graph"],
      early: "smell-ledger",
      exit: 1,
    },
  ],
  [
    "prepared-unreachable-before-ordinary-ci",
    {
      preparedUnreachable: true,
      flags: ["--unreachable", "--ci", "--graph"],
      early: "unreachable",
      exit: 1,
    },
  ],
  ["env-before-graph", { flags: ["--env-keys", "--graph"], early: "env-keys" }],
  [
    "comments-before-graph",
    { flags: ["--comments", "--graph"], early: "comments" },
  ],
];
