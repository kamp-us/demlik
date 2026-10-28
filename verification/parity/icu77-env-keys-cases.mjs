const q = JSON.stringify;
const unit = (file, text) => ({ file, text });
const reads = (names) => names.map((name) => `env[${q(name)}];`).join("\n");
const config = (dir, name, keys = [], extra = {}) => [
  `${dir ? `${dir}/` : ""}wrangler.jsonc`,
  q({
    name,
    vars: Object.fromEntries(keys.map((key) => [key, "x"])),
    ...extra,
  }),
];
const raw = [
  "\ud800",
  "\udc00",
  "\ufffd",
  "a",
  "A",
  "é",
  "e\u0301",
  "10",
  "2",
  "\ue000",
  "\u{10000}",
];
const workspace = {
  "pnpm-workspace.yaml": "packages: []\n",
  ...Object.fromEntries([
    config("workers/z", "z", ["USED", "Z_ONLY", "SHARED"]),
    config("workers/a", "a", ["A_ONLY", "SHARED"]),
    config("workers/m", "m", ["M_ONLY"]),
  ]),
  "workers/z/src/one.ts":
    "export const read = (env: Env) => [env.USED, env.UNKNOWN];\n",
  "workers/z/src/two.ts":
    "const note='Z_ONLY'; export const other=(env: Env)=>env.USED;\n",
  "workers/a/src/one.ts": "export const read=(env: Env)=>env.SHARED;\n",
  "workers/m/src/one.ts": "export const note='M_ONLY';\n",
};
export const cases = [
  { id: "scan-empty", mode: "scan", units: [], candidates: [], files: {} },
  {
    id: "scan-singleton",
    mode: "scan",
    units: [unit("z.ts", "env.ONE;")],
    candidates: ["ONE"],
    files: {},
  },
  {
    id: "scan-forms",
    mode: "scan",
    units: [
      unit(
        "forms.ts",
        "env.KEY;process.env.KEY;ctx.env.BAG;ctx.process.env.PROC;env['LITERAL'];env[dynamic];env?.OPTIONAL;process?.env.ODD;\nconst {DESTRUCT: renamed,...rest}=env;\nfunction typed({DEFAULT=1}: Env = {}) {}\nfunction ignored({DYNAMIC}: SomeEnv) {}\nconst note='ONLY_TEXT';",
      ),
    ],
    candidates: ["KEY", "ONLY_TEXT", "DYNAMIC"],
    files: {},
  },
  {
    id: "scan-raw-name-order",
    mode: "scan",
    units: [unit("raw.ts", reads(raw))],
    candidates: raw,
    files: {},
  },
  {
    id: "scan-name-file-order",
    mode: "scan",
    units: ["z.ts", "a.ts", "10.ts", "2.ts", "\ue000.ts", "\u{10000}.ts"].map(
      (file) => unit(file, "env.SAME;"),
    ),
    candidates: ["SAME"],
    files: {},
  },
  {
    id: "scan-lines-and-via",
    mode: "scan",
    units: [
      unit("same.ts", "process.env.SAME;env.SAME;\n\nenv.SAME;"),
      unit("same.ts", "env.SAME;process.env.SAME;"),
      { alias: 0 },
    ],
    candidates: ["SAME"],
    files: {},
  },
  {
    id: "scan-occurrence-entries",
    mode: "scan",
    units: ["z.ts", "a.ts", "m.ts"].map((file) =>
      unit(file, raw.slice().reverse().map(q).join(";")),
    ),
    candidates: raw,
    files: {},
  },
  {
    id: "scan-tab-collision-first",
    mode: "scan",
    units: [unit("C.ts", `env[${q("A\tB")}];`), unit("B\tC.ts", "env.A;")],
    candidates: ["A\tB", "A"],
    files: {},
  },
  {
    id: "query-declared-union",
    mode: "query",
    units: [],
    candidates: [],
    files: {
      ...Object.fromEntries([
        config("worker", "worker", ["Z", "a", "10", "2"], {
          bindings: { EXTRA: { type: "plain_text", value: "x" } },
        }),
      ]),
      "worker/.dev.vars": "a=one\nDEV=two\n",
    },
  },
  {
    id: "query-service-raw-order",
    mode: "query",
    units: [],
    candidates: [],
    files: Object.fromEntries(
      raw.map((service, i) => config(`worker${i}`, service, ["ONLY"])),
    ),
  },
  {
    id: "query-withheld-merge",
    mode: "query",
    units: [
      unit("tools/z.ts", "env.Z;env.SHARED;const a='A';"),
      unit("unknown/src/a.ts", "env.SHARED;env.B;"),
    ],
    candidates: ["A"],
    files: {
      ...Object.fromEntries([config("worker", "worker", ["A", "Z_DECLARED"])]),
      "unknown/wrangler.jsonc": "{broken",
    },
  },
  {
    id: "query-owner-precedence",
    mode: "query",
    units: [
      unit("worker/src/a.ts", "env.OUTER;"),
      unit("worker/nested/src/a.ts", "env.INNER;"),
      unit("loose/a.ts", "env.LOOSE;"),
    ],
    candidates: [],
    files: {
      ...Object.fromEntries([config("worker", "worker")]),
      "worker/nested/wrangler.jsonc": "{broken",
    },
  },
  {
    id: "query-known-process-bindings",
    mode: "query",
    units: [
      unit(
        "worker/a.ts",
        "process.env.PROCESS_ONLY;env.KNOWN_BINDING;env.UNKNOWN;",
      ),
    ],
    candidates: [],
    files: Object.fromEntries([
      config("worker", "worker", [], {
        services: [{ binding: "KNOWN_BINDING", service: "other" }],
      }),
    ]),
  },
  {
    id: "query-equal-and-alias",
    mode: "query",
    units: [
      unit("worker/z.ts", reads(["é", "e\u0301", "A", "a"])),
      { alias: 0 },
      unit("worker/a.ts", reads(["é", "e\u0301", "A", "a"])),
    ],
    candidates: [],
    files: Object.fromEntries([config("worker", "worker")]),
  },
  {
    id: "load-empty",
    mode: "load",
    units: [],
    candidates: [],
    files: { "pnpm-workspace.yaml": "packages: []\n" },
  },
  {
    id: "load-three-workers",
    mode: "load",
    units: [],
    candidates: [],
    files: workspace,
  },
  {
    id: "load-catalog-type-error",
    mode: "load",
    units: [],
    candidates: [],
    files: {
      "pnpm-workspace.yaml": "packages: []\n",
      "wrangler.jsonc": '{"name":"bad","vars":{"constructor":null}}',
      "src/index.ts": "env.UNKNOWN;",
    },
  },
  {
    id: "cli-nine-actions",
    mode: "cli",
    units: [],
    candidates: [],
    files: workspace,
    actions: [
      { id: "text", flags: [] },
      { id: "json", flags: ["--json"] },
      { id: "pretty-text", flags: ["--pretty"] },
      { id: "pretty-json", flags: ["--json", "--pretty"] },
      { id: "file-text", flags: ["--out", "result.txt"] },
      { id: "overwrite-json", flags: ["--json", "--out", "result.txt"] },
      { id: "initial-seven", flags: ["--json"], initial: 7 },
      { id: "later-smells-loses", flags: ["--json", "--smells"] },
      { id: "earlier-hexagon", flags: ["--hexagon", "--json"], code: 2 },
    ],
  },
];
