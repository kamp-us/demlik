import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
  sorted,
} from "../../test-helpers/library-report.js";
import { SHOP_TSCONFIG } from "../../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "../ledger.js";
import type { DeployableCensus } from "./census.js";

// One worker, `services/api`, with a binding of every kind the catalog holds, a var, a `main` that
// none of the places below is, and a feature `orders` laid out in hexagonal zones. A second worker
// owns a binding of its own.
const apiConfig = (main?: string): string =>
  JSON.stringify({
    name: "api",
    ...(main === undefined ? {} : { main }),
    services: [{ binding: "SVC", service: "other" }],
    d1_databases: [{ binding: "DB" }],
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    kv_namespaces: [{ binding: "CACHE" }],
    r2_buckets: [{ binding: "ASSETS" }],
    queues: { producers: [{ binding: "EVENTS" }] },
    workflows: [{ binding: "FLOW", class_name: "Flow" }],
    vars: { MODE: "fast" },
  });

const WORKER = {
  "tsconfig.json": SHOP_TSCONFIG,
  "services/api/package.json": JSON.stringify({ name: "@shop/api" }),
  "services/api/wrangler.jsonc": apiConfig("./src/index.ts"),
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

const MAIN = `${API}/src/index.ts`;

const reading = (name: string, call: string): string =>
  `export const use = (env: Env) => env.${name}.${call};\n`;

const MAIN_PLACES = [
  ["outside every feature", "src/index.ts"],
  ["inside a feature", "src/orders/application/start.ts"],
] as const;

describe("B17 and the main file of a worker", () => {
  it.each(
    MAIN_PLACES.flatMap(([where, main]) =>
      KINDS.map(([kind, name, call]) => [kind, where, main, name, call] as const),
    ),
  )("is clean for a %s binding in a main %s, and a file beside it that reads it is not", (_kind, _where, main, name, call) => {
    const beside = `${main.slice(0, main.lastIndexOf("/"))}/beside.ts`;
    const files = {
      [`${API}/wrangler.jsonc`]: apiConfig(main),
      [`${API}/${main}`]: reading(name, call),
      [`${API}/${beside}`]: reading(name, call),
    };
    expect(bindingsOf(open(files).run({ json: true }))).toEqual([[`${API}/${beside}`, name]]);
  });

  it("is clean for a binding bindingOwners narrows to a driven adapter, and a loose file is not", () => {
    const files = {
      [`${ORDERS}/adapters/driven/orders-db.ts`]: reading("DB", 'prepare("a")'),
      [MAIN]: reading("DB", 'prepare("m")'),
      [`${API}/src/loose.ts`]: reading("DB", 'prepare("c")'),
    };
    const rules = {
      ...RULES,
      bindingOwners: { [API]: { DB: ["src/orders/adapters/driven/orders-db.ts"] } },
    };
    expect(bindingsOf(open(files, rules).run({ json: true }))).toEqual([
      [`${API}/src/loose.ts`, "DB"],
    ]);
  });

  it.each([
    "./src/index.ts",
    "src/index.ts",
    "./src/../src/index.ts",
    "../api/src/index.ts",
  ])("reads a main spelled %s as the one file src/index.ts", (main) => {
    const files = {
      [`${API}/wrangler.jsonc`]: apiConfig(main),
      [MAIN]: reading("DB", 'prepare("m")'),
      [`${API}/src/loose.ts`]: reading("DB", 'prepare("c")'),
    };
    expect(bindingsOf(open(files).run({ json: true }))).toEqual([[`${API}/src/loose.ts`, "DB"]]);
  });

  it("holds a worker whose config has no main to have no clean file", () => {
    const files = {
      [`${API}/wrangler.jsonc`]: apiConfig(),
      [MAIN]: reading("DB", 'prepare("m")'),
    };
    expect(bindingsOf(open(files).run({ json: true }))).toEqual([[MAIN, "DB"]]);
  });

  it("is no error when main names no file the scope loads, and cleans nothing", () => {
    const files = {
      [`${API}/wrangler.jsonc`]: apiConfig("dist/index.js"),
      [MAIN]: reading("DB", 'prepare("m")'),
    };
    const run = open(files).run({ json: true });
    expect(run.code).toBe(0);
    expect(bindingsOf(run)).toEqual([[MAIN, "DB"]]);
  });

  it("judges a file a worker names as main against the nearer worker it sits under", () => {
    const echo = `${API}/test/echo`;
    const files = {
      [`${API}/wrangler.jsonc`]: apiConfig("test/echo/index.ts"),
      [`${echo}/wrangler.jsonc`]: JSON.stringify({
        name: "echo",
        kv_namespaces: [{ binding: "ECHO_KV" }],
      }),
      [`${echo}/index.ts`]:
        'export const use = (env: Env) => [env.DB.prepare("a"), env.ECHO_KV.get("k")];\n',
    };
    expect(bindingsOf(open(files).run({ json: true }))).toEqual([[`${echo}/index.ts`, "ECHO_KV"]]);
  });

  it("still counts the sites of a main in the census", () => {
    const run = open({ [MAIN]: reading("DB", 'prepare("m")') });
    const { deployables } = reportOf(run.run({ json: true })) as unknown as {
      deployables: DeployableCensus;
    };
    expect(deployables.workers.flatMap((worker) => worker.sites)).toEqual([
      { file: MAIN, line: 1, binding: "DB" },
    ]);
    expect(run.run().stdout).toContain("api: 1 site in 1 file over 1 binding (DB 1)");
  });
});

// Three workers laid out as hexagonal features, each wiring its bindings in the file its config
// names as `main`, and a test worker in a directory of its own under the first. Beside every main
// sit the files that must stay flagged: a binding read outside every driven adapter.
const B17 = "binding-outside-driven-adapter";

const named = (binding: string) => ({ binding });
const workerFiles = (dir: string, config: Record<string, unknown>): Record<string, string> => ({
  [`${dir}/package.json`]: JSON.stringify({ name: `@shop/${dir.slice(dir.lastIndexOf("/") + 1)}` }),
  [`${dir}/wrangler.jsonc`]: JSON.stringify(config),
});

const readingAll = (...bindings: string[]): string =>
  `export const wire = (env: Env) => [${bindings.map((b) => `env.${b}`).join(", ")}];\n`;

const WIRING_MAINS = [
  "services/api/src/index.ts",
  "services/auth/src/index.ts",
  "services/billing/src/index.ts",
  "services/api/test/echo/index.ts",
];

const STILL_FLAGGED: readonly (readonly [string, string])[] = [
  ["services/api/src/loose.ts", "CACHE"],
  ["services/api/src/loose.ts", "DB"],
  ["services/api/src/orders/application/use.ts", "DB"],
  ["services/auth/src/sessions/adapters/driving/http.ts", "SESSIONS"],
  ["services/billing/src/loose.ts", "INVOICES"],
  ["services/api/test/echo/helper.ts", "ECHO"],
];

const SEVERAL_WORKERS: Record<string, string> = {
  "tsconfig.json": SHOP_TSCONFIG,
  ...workerFiles("services/api", {
    name: "api",
    main: "src/index.ts",
    d1_databases: [named("DB")],
    kv_namespaces: [named("CACHE")],
  }),
  ...workerFiles("services/auth", {
    name: "auth",
    main: "./src/index.ts",
    kv_namespaces: [named("SESSIONS")],
    queues: { producers: [named("EVENTS")] },
  }),
  ...workerFiles("services/billing", {
    name: "billing",
    main: "src/index.ts",
    r2_buckets: [named("INVOICES")],
    d1_databases: [named("LEDGER")],
  }),
  "services/api/test/echo/wrangler.jsonc": JSON.stringify({
    name: "echo",
    main: "./index.ts",
    kv_namespaces: [named("ECHO")],
  }),
  "services/api/src/index.ts": readingAll("DB", "CACHE"),
  "services/auth/src/index.ts": readingAll("SESSIONS", "EVENTS"),
  "services/billing/src/index.ts": readingAll("INVOICES", "LEDGER"),
  "services/api/test/echo/index.ts": readingAll("ECHO"),
  "services/api/src/orders/adapters/driven/orders-db.ts": readingAll("DB"),
  "services/auth/src/sessions/adapters/driven/sessions-kv.ts": readingAll("SESSIONS"),
  "services/billing/src/invoices/adapters/driven/invoices-r2.ts": readingAll("INVOICES"),
  "services/api/src/loose.ts": readingAll("DB", "CACHE"),
  "services/api/src/orders/application/use.ts": readingAll("DB"),
  "services/auth/src/sessions/adapters/driving/http.ts": readingAll("SESSIONS"),
  "services/billing/src/loose.ts": readingAll("INVOICES"),
  "services/api/test/echo/helper.ts": readingAll("ECHO"),
};

const SEVERAL_RULES = {
  features: {
    "services/api": ["orders"],
    "services/auth": ["sessions"],
    "services/billing": ["invoices"],
  },
  acrossDeployables: [B17],
};

describe("a repo of several workers lists B17 without an accepted exception per worker's main", () => {
  it("flags every other binding read outside a driven adapter, in each worker, and no main", () => {
    repo = boundaryRepo(".", SEVERAL_WORKERS, SEVERAL_RULES);
    const rows = reportOf(repo.run({ json: true })).scopes.flatMap((s) => s.violations);
    expect(sorted(rows.map((v) => [v.kind, v.from, ledgerTargetOf(v)]))).toEqual(
      sorted(STILL_FLAGGED.map(([from, binding]) => [B17, from, binding])),
    );
    expect(rows.filter((v) => WIRING_MAINS.includes(v.from))).toEqual([]);
  });

  it("fails an empty ledger on exactly those, records them, and gates the same bytes twice", () => {
    repo = boundaryRepo(".", SEVERAL_WORKERS, SEVERAL_RULES);
    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    const lines = entryLines(failed.stdout);
    expect(lines).toHaveLength(STILL_FLAGGED.length);
    for (const [from, binding] of STILL_FLAGGED) {
      expect(lines.filter((line) => line.includes(`${from} -> ${binding}`))).toHaveLength(1);
    }
    expect(lines.filter((line) => WIRING_MAINS.some((main) => line.includes(main)))).toEqual([]);

    expect(repo.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const seeded = ledgerText(repo);
    expect([repo.run({ ci: true }).code, repo.run({ ci: true }).code]).toEqual([0, 0]);
    expect(ledgerText(repo)).toBe(seeded);
  });

  it("prunes a ledger entry that names a main's binding on the next run, and still exits 0", () => {
    repo = boundaryRepo(".", SEVERAL_WORKERS, SEVERAL_RULES);
    expect(repo.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const entries = ledgerOf(repo).entries;
    const stale = {
      scope: "services/auth",
      kind: B17,
      from: "services/auth/src/index.ts",
      to: null,
      specifier: "EVENTS",
      reason: "legacy",
    };
    fs.writeFileSync(
      repo.ledgerFile,
      `${JSON.stringify({ entries: [...entries, stale] }, null, 2)}\n`,
    );

    const pruned = repo.run({ ci: true });
    expect(pruned.code).toBe(0);
    expect(entryLines(pruned.stdout)).toEqual([
      expect.stringContaining("services/auth/src/index.ts -> EVENTS"),
    ]);
    expect(ledgerOf(repo).entries).toEqual(entries);
  });
});
