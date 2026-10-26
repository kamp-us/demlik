import fs from "node:fs";
import path from "node:path";

const put = (root, file, body) => {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
};
const workers = {
  "workers/api/wrangler.jsonc": '{"name":"api","vars":{"API_KEY":"x"}}',
  "workers/api/src/index.ts": "export const read=(env: Env)=>env.API_KEY;\n",
  "workers/billing/wrangler.toml":
    'name="billing"\n[vars]\nSTRIPE_KEY="x"\nLEGACY_FLAG="x"\n',
  "workers/billing/src/index.ts":
    "export const read=(env: Env)=>env.STRIPE_KEY;\n",
  "workers/auth/wrangler.jsonc":
    '{"name":"auth","vars":{"SESSION_SECRET":"x","JWT_ISSUER":"x"},"d1_databases":[{"binding":"DB"],"services":[]}',
  "workers/auth/src/index.ts":
    "export const read=(env: Env)=>[env.SESSION_SECRET,env.JWT_ISSUER];\n",
  "workers/api/edge/wrangler.jsonc":
    '{"name":"edge" "vars":{"EDGE_TOKEN":"x"}}',
  "workers/api/edge/src/index.ts":
    "export const read=(env: Env)=>env.EDGE_TOKEN;\n",
};
const scanner = `export const read=(env: Env, ctx: any)=>[env.KEY,process.env.KEY,ctx.env.BAG,ctx.process.env.PROC,env['LITERAL'],env[dynamic],env?.OPTIONAL,process?.env.ODD];
const {DESTRUCT: renamed,...rest}=env;
function typed({DEFAULT=1}: Env = {}) {}
function ignored({DYNAMIC}: SomeEnv) {}
const note='ONLY_TEXT';
`;
// The eight ownership layouts are literal filesystem realizations of Source query.test.ts.
export const ownershipLayouts = [
  {
    configs: [["workers/billing", "billing"]],
    unparsed: ["workers/auth/wrangler.jsonc"],
    reads: [["workers/auth/src/index.ts", "SESSION_SECRET"]],
    findings: [],
    withheld: [["SESSION_SECRET", "read-site-owner-unparsed"]],
  },
  {
    configs: [["workers/api", "api"]],
    unparsed: ["workers/api/edge/wrangler.jsonc"],
    reads: [
      ["workers/api/edge/src/index.ts", "EDGE_TOKEN"],
      ["workers/api/src/index.ts", "STRAY"],
    ],
    findings: [["STRAY", "api"]],
    withheld: [["EDGE_TOKEN", "read-site-owner-unparsed"]],
  },
  {
    configs: [["workers/api", "api"]],
    unparsed: ["wrangler.jsonc"],
    reads: [
      ["tools/seed.ts", "SEED_KEY"],
      ["workers/api/src/index.ts", "STRAY"],
    ],
    findings: [["STRAY", "api"]],
    withheld: [["SEED_KEY", "read-site-owner-unparsed"]],
  },
  {
    configs: [["workers/api/edge", "edge"]],
    unparsed: ["workers/api/wrangler.jsonc"],
    reads: [
      ["workers/api/edge/src/index.ts", "STRAY"],
      ["workers/api/src/index.ts", "API_KEY"],
    ],
    findings: [["STRAY", "edge"]],
    withheld: [["API_KEY", "read-site-owner-unparsed"]],
  },
  {
    configs: [["workers/api", "api"]],
    unparsed: ["workers/api/wrangler.toml"],
    reads: [["workers/api/src/index.ts", "STRAY"]],
    findings: [["STRAY", "api"]],
    withheld: [],
  },
  {
    configs: [["workers/api", "api"]],
    unparsed: ["workers/auth/wrangler.jsonc"],
    reads: [["scripts/seed.ts", "SEED_KEY"]],
    findings: [],
    withheld: [["SEED_KEY", "read-site-owner-unknown"]],
  },
  {
    configs: [],
    unparsed: ["workers/auth/wrangler.jsonc"],
    reads: [
      ["workers/auth/src/index.ts", "SHARED"],
      ["scripts/seed.ts", "SHARED"],
    ],
    findings: [],
    withheld: [
      ["SHARED", "read-site-owner-unknown"],
      ["SHARED", "read-site-owner-unparsed"],
    ],
  },
  {
    configs: [["workers/api", "api", ["API_KEY"]]],
    unparsed: ["workers/api/edge/wrangler.jsonc"],
    reads: [["workers/api/edge/src/index.ts", "API_KEY"]],
    findings: [],
    withheld: [],
  },
];
export const envKeyCases = [];
for (const [format, flags] of [
  ["text", []],
  ["pretty-text", ["--pretty"]],
  ["json", ["--json"]],
  ["pretty-json", ["--json", "--pretty"]],
]) {
  envKeyCases.push([`workers-${format}`, { flags, code: 0 }]);
  envKeyCases.push([`out-${format}`, { flags, out: "result.txt", code: 0 }]);
}
for (let i = 0; i < 8; i++)
  envKeyCases.push([
    `ownership-${i + 1}`,
    { layout: i, flags: ["--json"], code: 0 },
  ]);
const scans = [
  [
    "destructure",
    scanner,
    { KEY: 1, LITERAL: 1, DESTRUCT: 1, DEFAULT: 1, ONLY_TEXT: 1, DYNAMIC: 1 },
  ],
  ["duplicate-lines", "env.A; env.A;\nenv.A;\nprocess.env.A; env.A;", {}],
  [
    "destructure-keys",
    `const {'QUOTED': renamed,[dynamic]: picked,...rest}=env; function f({ONE,TWO: alias}: Env | Other){}; const {PROC}=ctx.process.env;`,
    {},
  ],
  [
    "env-type-boundary",
    `function f({A}: Env){} function g({B}: SomeEnv){} function h({C}: Env2){} function i({D}: NS.Env){} function j({E}: 'Env'){} function k({F}: 'ÉEnv'){};`,
    {},
  ],
  [
    "literal-occurrences",
    `const jsx=<A title="JSX_TEXT"/>; class C { #secret=1; } const x='TEXT'; const re=/REGEX/; /* COMMENT */ env[dynamic];`,
    { JSX_TEXT: 1, "#secret": 1, TEXT: 1, REGEX: 1, COMMENT: 1 },
  ],
  [
    "process-read-settles",
    `process.env.USED;ctx.process.env.UNKNOWN;`,
    { USED: 1 },
  ],
  [
    "receiver-spelling",
    `environment.A;thing.env.A;thing.process.env.B;process?.env.C;(env).D;env?.E;env[0];env[\`F\`];env['G'];`,
    {},
  ],
  [
    "raw-keys",
    `env['\\ud800']; env['\\udc00']; env['😀']; env.é; const note='\\ud800';`,
    { "\ud800": 1, "\udc00": 1, "😀": 1, é: 1, "NOT\ud800READ": 1 },
  ],
  ["locale-keys", `env.Éclair;env.éclair;env.Z;env.a;env._;env['éclair'];`, {}],
];
for (const [scan, code, vars] of scans)
  envKeyCases.push([
    `scan-${scan}`,
    { scan: { code, vars }, flags: ["--json"], code: 0 },
  ]);
const [, rawCode, rawVars] = scans.find(([name]) => name === "raw-keys");
envKeyCases.push(
  ["tab-read-collision", { readTabs: true, flags: ["--json"], code: 0 }],
  [
    "raw-key-text",
    {
      scan: { code: rawCode, vars: rawVars },
      code: 0,
    },
  ],
  ["tab-declaration-collision", { tabs: true, flags: ["--json"], code: 0 }],
  ["dev-vars-bindings", { devVars: true, flags: ["--json"], code: 0 }],
  ["empty-project", { empty: true, flags: ["--json"], code: 0 }],
  ["malformed-source", { malformedSource: true, flags: ["--json"], code: 0 }],
  ["catalog-type-error", { catalogThrow: true, expectedThrow: true }],
  [
    "catalog-constructor-unparsed",
    { catalogUnparsed: true, flags: ["--json"], code: 0 },
  ],
  ["subpath", { subpath: true, flags: ["--json"], code: 0 }],
  [
    "second-root-read",
    { subpath: true, removeMarker: true, flags: ["--json"], code: 0 },
  ],
  ["zero-preserves-initial", { initial: 7, flags: ["--json"], code: 0 }],
  [
    "ci-prepared-unused",
    { gatedSmell: true, flags: ["--ci", "--json"], code: 0 },
  ],
  [
    "accept-smells-unused",
    {
      gatedSmell: true,
      flags: ["--accept-smells", "--reason=because", "--json"],
      code: 0,
    },
  ],
  [
    "ci-smell-refusal-first",
    { badSmell: true, flags: ["--ci"], stage: "refused" },
  ],
  [
    "unreachable-refusal-first",
    {
      badUnreachable: true,
      flags: ["--unreachable", "--ci"],
      stage: "refused",
    },
  ],
  [
    "global-config-first",
    { flags: ["--thresholds=missing.json"], stage: "stopped" },
  ],
  [
    "layers-first",
    { flags: ["--layers", "--layer-rules=missing.json"], stage: "layers" },
  ],
  [
    "boundaries-first",
    { flags: ["--boundaries", "--write-ceilings"], stage: "boundaries" },
  ],
  ["api-first", { flags: ["--api=missing-api.json"], stage: "api" }],
  ["hexagon-first", { flags: ["--hexagon", "--json"], stage: "hexagon" }],
  [
    "later-flags",
    {
      flags: [
        "--comments",
        "--collapse",
        "--graph",
        "--edges",
        "--deep",
        "--html",
        "--json",
      ],
      withoutCompiler: true,
      code: 0,
    },
  ],
  ["no-compiler", { withoutCompiler: true, flags: ["--json"], code: 0 }],
  ["inactive", { inactive: true, initial: 7, stage: "continue" }],
  ["out-missing", { out: "missing/result.txt", expectedThrow: true }],
  ["out-directory", { out: "workers", expectedThrow: true, initial: 7 }],
  ["out-nul", { out: "raw\0\ud800", rawArgv: true, expectedThrow: true }],
  ["stdout-bad", { badStdout: true, code: 0 }],
  ["banner-bad", { out: "result.txt", badStderr: true, code: 0 }],
  ["raw-root", { rawRoot: true, rawArgv: true, flags: ["--json"], code: 0 }],
  [
    "raw-self-root",
    {
      rawRoot: true,
      selfMarker: true,
      rawArgv: true,
      flags: ["--json"],
      code: 0,
    },
  ],
  [
    "raw-ancestor",
    { ancestorRaw: true, rawArgv: true, flags: ["--json"], code: 0 },
  ],
  [
    "replacement-root",
    { replacementRoot: true, selfMarker: true, flags: ["--json"], code: 0 },
  ],
  [
    "supplementary-root",
    { supplementaryRoot: true, selfMarker: true, flags: ["--json"], code: 0 },
  ],
);
export function envKeyFixture(location, options) {
  const root = path.join(location, "repo");
  fs.mkdirSync(root, { recursive: true });
  put(root, "pnpm-workspace.yaml", "packages: []\n");
  put(root, "readonly.txt", "");
  let files = { ...workers },
    target = options.subpath ? "workers/api" : ".";
  if (options.layout !== undefined) {
    files = {};
    const layout = ownershipLayouts[options.layout];
    for (const [dir, name, keys = []] of layout.configs)
      files[`${dir}/wrangler.jsonc`] = JSON.stringify({
        name,
        vars: Object.fromEntries(keys.map((key) => [key, 1])),
      });
    for (const file of layout.unparsed) files[file] = "{broken";
    for (const [file, key] of layout.reads)
      files[file] = `env[${JSON.stringify(key)}];\n`;
  }
  if (options.scan)
    files = {
      "wrangler.jsonc": JSON.stringify({
        name: "scan",
        vars: options.scan.vars,
      }),
      "src/index.tsx": options.scan.code,
    };
  if (options.readTabs)
    files = { "x.ts": `env["A\tfile"];`, "file\tx.ts": "env.A;" };
  if (options.tabs)
    files = {
      "a/wrangler.jsonc": JSON.stringify({ name: "a\tb", vars: { c: 1 } }),
      "b/wrangler.jsonc": JSON.stringify({ name: "a", vars: { "b\tc": 1 } }),
    };
  if (options.devVars)
    files = {
      "wrangler.jsonc":
        '{"name":"vars","vars":{"TOP":1},"r2_buckets":[{"binding":"BUCKET","bucket_name":"bucket"}]}',
      ".dev.vars": "LOCAL=x\n#comment\n TOP =x\n",
      ".dev.vars.example": "EXAMPLE=x\n",
      "src/index.ts": "env.LOCAL;env.BUCKET;env.UNKNOWN;",
    };
  if (options.empty) files = {};
  if (options.malformedSource)
    files["workers/api/src/index.ts"] = "export const broken=env.";
  if (options.catalogThrow)
    files["workers/api/wrangler.jsonc"] =
      '{"name":"api","vars":{"constructor":null}}';
  if (options.catalogUnparsed)
    files["workers/api/wrangler.jsonc"] =
      '{"name":"api","vars":{"constructor":3}}';
  if (
    options.rawRoot ||
    options.ancestorRaw ||
    options.replacementRoot ||
    options.supplementaryRoot
  ) {
    const suffix = options.supplementaryRoot
      ? "😀"
      : options.replacementRoot
        ? "�"
        : "\ud800";
    target = options.ancestorRaw
      ? `workers/api/nested${suffix}`
      : `workers/raw${suffix}`;
    const actual = target.toWellFormed(),
      owner = options.ancestorRaw ? "workers/api" : actual;
    files = {
      [`${owner}/wrangler.jsonc`]: '{"name":"raw","vars":{"USED":1}}',
      [`${actual}/src/index.ts`]: "env.USED;env.UNKNOWN;",
    };
    if (options.selfMarker)
      files[`${actual}/pnpm-workspace.yaml`] = "packages: []\n";
  }
  if (options.badSmell) files["smell-ledger.json"] = "{broken";
  if (options.gatedSmell)
    files["smell-ledger.json"] = '{"gated":["long-function"],"entries":[]}';
  if (options.badUnreachable) files["unreachable-ledger.json"] = "{broken";
  for (const [file, body] of Object.entries(files)) put(root, file, body);
  return {
    root,
    argv: [
      target,
      ...(options.inactive ? [] : ["--env-keys"]),
      ...(options.flags ?? []),
      ...(options.out === undefined ? [] : ["--out", options.out]),
    ],
  };
}
