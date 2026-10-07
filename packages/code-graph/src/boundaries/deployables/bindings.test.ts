import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { reportOf, sorted } from "../../test-helpers/library-report.js";
import { SHOP_TSCONFIG } from "../../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "../ledger.js";

// One worker, `services/api`, with a binding of every kind the catalog holds, a var, and a feature
// `orders` laid out in hexagonal zones. A second worker owns a binding of its own.
const WORKER = {
  "tsconfig.json": SHOP_TSCONFIG,
  "services/api/package.json": JSON.stringify({ name: "@shop/api" }),
  "services/api/wrangler.jsonc": JSON.stringify({
    name: "api",
    services: [{ binding: "SVC", service: "other" }],
    d1_databases: [{ binding: "DB" }],
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    kv_namespaces: [{ binding: "CACHE" }],
    r2_buckets: [{ binding: "ASSETS" }],
    queues: { producers: [{ binding: "EVENTS" }] },
    workflows: [{ binding: "FLOW", class_name: "Flow" }],
    vars: { MODE: "fast" },
  }),
  "services/other/package.json": JSON.stringify({ name: "@shop/other" }),
  "services/other/wrangler.jsonc": JSON.stringify({
    name: "other",
    d1_databases: [{ binding: "OTHERS_DB" }],
  }),
};

const RULES = {
  features: { "services/api": ["orders"] },
  layout: { "services/api": "hexagonal" },
  acrossDeployables: ["binding-outside-driven-adapter"],
};

const API = "services/api";
const ORDERS = `${API}/src/orders`;

// Where a binding is used, each place one file: everything but a driven adapter.
const PLACES = [
  `${ORDERS}/application/use.ts`,
  `${ORDERS}/adapters/driving/use.ts`,
  `${ORDERS}/index.ts`,
  `${ORDERS}/ports.ts`,
  `${API}/src/loose.ts`,
  `${API}/tools/use.ts`,
  `${ORDERS}/application/use.test.ts`,
];

// What each binding kind is read as, and how a use of it is called.
const KINDS = [
  ["service", "SVC", "fetch()"],
  ["D1", "DB", 'prepare("select 1")'],
  ["Durable Object", "COUNTER", 'get("id")'],
  ["KV", "CACHE", 'get("k")'],
  ["R2", "ASSETS", 'put("k", "v")'],
  ["queue", "EVENTS", 'send("e")'],
] as const;

type Run = ReturnType<BoundaryRepo["run"]>;

// `[from, binding]` of every B17 a `--json` run lists, sorted.
function bindingsOf(run: Run): string[][] {
  const rows = reportOf(run).scopes.flatMap((s) => s.violations);
  return sorted(
    rows
      .filter((v) => v.kind === "binding-outside-driven-adapter")
      .map((v) => [v.from, ledgerTargetOf(v)]),
  );
}

let repo: BoundaryRepo | null = null;
const open = (files: Record<string, string>, rules: unknown = RULES): BoundaryRepo => {
  repo = boundaryRepo(".", { ...WORKER, ...files }, rules);
  return repo;
};
afterEach(() => repo?.dispose());

describe("B17 binding-outside-driven-adapter", () => {
  it.each(KINDS)("flags a %s binding outside a driven adapter, once per file", (_, name, call) => {
    const files: Record<string, string> = {
      [`${ORDERS}/adapters/driven/use.ts`]: `export const use = (env: Env) => env.${name}.${call};\n`,
    };
    for (const place of PLACES) {
      files[place] =
        `export const use = (env: Env) => [env.${name}.${call}, env.${name}.${call}];\n`;
    }
    const found = bindingsOf(open(files).run({ json: true }));
    expect(found).toEqual(sorted(PLACES.map((place) => [place, name])));
  });

  const FORMS: readonly [string, string][] = [
    ["env.X", "export const use = (env: Env) => env.DB.prepare('a');"],
    ["this.env.X", "export class C { env!: Env; use() { return this.env.DB.prepare('a'); } }"],
    ["c.env.X", "export const use = (c: Ctx) => c.env.DB.prepare('a');"],
    ['env["X"]', 'export const use = (env: Env) => env["DB"].prepare("a");'],
    [
      "one level of alias",
      "export const use = (env: Env) => { const db = env.DB; return db.prepare('a'); };",
    ],
    [
      "a destructure off env",
      "export const use = (env: Env) => { const { DB } = env; return DB.prepare('a'); };",
    ],
    ["a binding handed on whole", "export const use = (env: Env) => register(env.DB);"],
  ];

  it("reads every form the finder reads, and is clean in a driven adapter for each", () => {
    const files: Record<string, string> = {};
    FORMS.forEach(([, body], index) => {
      files[`${ORDERS}/application/form${index}.ts`] = `${body}\n`;
      files[`${ORDERS}/adapters/driven/form${index}.ts`] = `${body}\n`;
    });
    const found = bindingsOf(open(files).run({ json: true }));
    expect(found).toEqual(
      sorted(FORMS.map((_, index) => [`${ORDERS}/application/form${index}.ts`, "DB"])),
    );
  });

  it("does not judge a Workflow binding, a var, an undeclared name, or a binding of another worker", () => {
    const files = {
      [`${ORDERS}/application/other.ts`]: [
        "export const use = (env: Env) => [",
        '  env.FLOW.create({}), env.MODE, env.NOPE.run(), env.OTHERS_DB.prepare("a"),',
        "];",
        "",
      ].join("\n"),
    };
    expect(bindingsOf(open(files).run({ json: true }))).toEqual([]);
  });

  it("is one entry per binding when a file uses two, and none for a file that uses none", () => {
    const files = {
      [`${ORDERS}/application/two.ts`]:
        'export const use = (env: Env) => [env.DB.prepare("a"), env.CACHE.get("k"), env.DB.prepare("b")];\n',
      [`${ORDERS}/application/none.ts`]: "export const use = (env: Env) => env;\n",
    };
    expect(bindingsOf(open(files).run({ json: true }))).toEqual([
      [`${ORDERS}/application/two.ts`, "CACHE"],
      [`${ORDERS}/application/two.ts`, "DB"],
    ]);
  });

  it("narrows a binding to the files bindingOwners lists, among the driven adapters", () => {
    const owned = `${ORDERS}/adapters/driven/orders-db.ts`;
    const files = {
      [owned]: 'export const a = (env: Env) => env.DB.prepare("a");\n',
      [`${ORDERS}/adapters/driven/other-db.ts`]:
        'export const b = (env: Env) => [env.DB.prepare("b"), env.CACHE.get("k")];\n',
      [`${API}/src/loose.ts`]: 'export const c = (env: Env) => env.DB.prepare("c");\n',
    };
    const rules = {
      ...RULES,
      bindingOwners: { [API]: { DB: ["src/orders/adapters/driven/orders-db.ts"] } },
    };
    expect(bindingsOf(open(files, rules).run({ json: true }))).toEqual(
      sorted([
        [`${ORDERS}/adapters/driven/other-db.ts`, "DB"],
        [`${API}/src/loose.ts`, "DB"],
      ]),
    );
  });

  it("judges a feature of a scope that lays out `rules/` as outside every driven adapter", () => {
    const rules = { ...RULES, layout: { [API]: "rules" } };
    const files = {
      [`${ORDERS}/adapters/driven/use.ts`]: "export const u = (env: Env) => env.DB.prepare('a');\n",
    };
    expect(bindingsOf(open(files, rules).run({ json: true }))).toEqual([
      [`${ORDERS}/adapters/driven/use.ts`, "DB"],
    ]);
  });

  it("holds a file under no worker config to have no binding", () => {
    const rules = { ...RULES, features: { tools: ["x"] }, layout: { tools: "hexagonal" } };
    const files = {
      "tools/src/x/application/use.ts": 'export const u = (env: Env) => env.DB.prepare("a");\n',
    };
    expect(bindingsOf(open(files, rules).run({ json: true }))).toEqual([]);
  });
});
