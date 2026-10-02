import { SHOP_TSCONFIG } from "./shop-workspace.js";

// The synthetic repo the deployable rules are tested against: six workers and two shared packages,
// every name made up. `api` and `auth` are hexagonal feature scopes; `billing-worker`, `search`,
// `mailer` and `reports` exist only as nodes of the worker call graph.

const lines = (...source: string[]): string => `${source.join("\n")}\n`;
const json = (value: unknown): string => JSON.stringify(value);
const named = (binding: string) => ({ binding });
const service = (binding: string, to: string) => ({ binding, service: to });

const WORKERS = [
  "services/api",
  "services/auth",
  "services/billing-worker",
  "services/search",
  "services/mailer",
  "services/reports",
];

const PACKAGES = ["packages/string-util", "packages/orders-contract"];

const wrangler = (dir: string, config: Record<string, unknown>): [string, string] => [
  `${dir}/wrangler.jsonc`,
  json({ name: dir.slice("services/".length), ...config }),
];

// `api` declares every kind B17 judges, and a service binding (`PARTNER`) to a worker with no
// config in the repo; the other workers declare only the service bindings that make the graph:
// the ring `api -> auth -> billing-worker -> api` with the chord `api -> billing-worker`, the pair
// `search <-> mailer`, and the one-way chain `reports -> api`.
const CONFIGS = Object.fromEntries([
  wrangler("services/api", {
    services: [
      service("AUTH", "auth"),
      service("BILLING", "billing-worker"),
      service("PARTNER", "partner-gateway"),
    ],
    d1_databases: [named("DB")],
    kv_namespaces: [named("CACHE")],
    r2_buckets: [named("ASSETS")],
    queues: { producers: [named("EVENTS")] },
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    vars: { API_URL: "https://api.example.test" },
  }),
  wrangler("services/auth", { services: [service("LEDGER", "billing-worker")] }),
  wrangler("services/billing-worker", { services: [service("API", "api")] }),
  wrangler("services/search", { services: [service("MAILER", "mailer")] }),
  wrangler("services/mailer", { services: [service("SEARCH", "search")] }),
  wrangler("services/reports", { services: [service("API", "api")] }),
]);

const MANIFESTS = Object.fromEntries(
  [...WORKERS, ...PACKAGES].map((dir) => [
    `${dir}/package.json`,
    json({ name: `@shop/${dir.slice(dir.lastIndexOf("/") + 1)}` }),
  ]),
);

const API = "services/api/src";
const ORDERS = `${API}/orders`;
const BILLING = `${API}/billing`;
const AUTH = "services/auth/src/sessions";

// What is clean: a binding used in a driven adapter, a var and a name no config declares, and an
// import inside one workspace through `../`.
const CLEAN: Record<string, string> = {
  [`${ORDERS}/adapters/driven/orders-db.ts`]: lines(
    "export function listOrders(env: Env) {",
    "  const { DB } = env;",
    '  return DB.prepare("select 1");',
    "}",
  ),
  [`${ORDERS}/adapters/driven/auth-client.ts`]: lines(
    "export class AuthClient {",
    "  constructor(private readonly env: Env) {}",
    '  verify() { return this.env.AUTH.verify("token"); }',
    "}",
  ),
  [`${BILLING}/adapters/driven/billing-client.ts`]: lines(
    "export const charge = (env: Env) => env.BILLING.charge();",
  ),
  [`${ORDERS}/application/vars.ts`]: lines(
    "export const read = (env: Env) => [env.API_URL, env.NOT_A_BINDING];",
  ),
  [`${AUTH}/adapters/driven/ledger.ts`]: lines(
    'export const record = (env: Env) => env.LEDGER.record("entry");',
  ),
  [`${API}/shared/format.ts`]: "export const format = (n: number) => String(n);\n",
};

// What B17 flags, seven of them: `place.ts` also imports a file of its own workspace, which is clean.
const BINDING_USES: Record<string, string> = {
  [`${ORDERS}/application/place.ts`]: lines(
    'import { format } from "../../shared/format";',
    "export const place = (c: Ctx) => c.env.DB.prepare(format(1));",
  ),
  [`${ORDERS}/adapters/driving/http.ts`]: lines(
    'export const handle = (env: Env) => env.AUTH.fetch("/verify");',
  ),
  [`${API}/main.ts`]: lines(
    'import { format } from "../../../packages/string-util/src/format";',
    "export async function main(env: Env) {",
    "  const events = env.EVENTS;",
    "  events.send(format(1));",
    '  return import("../../../packages/string-util/src/format");',
    "}",
  ),
  [`${ORDERS}/application/place.test.ts`]: lines(
    'import { format } from "../../../../../packages/string-util/src/format";',
    'export const cached = (env: Env) => [format(1), env.CACHE.get("k")];',
  ),
  [`${BILLING}/application/charge.ts`]: lines(
    'import type { Order } from "../../../../../packages/orders-contract/src/index";',
    "export const charge = (env: Env, order: Order) => {",
    "  env.ASSETS.put(order.id, order.id);",
    "  return env.BILLING.charge(order.id);",
    "};",
  ),
  [`${AUTH}/application/issue.ts`]: lines(
    'export const issue = (env: Env) => env.LEDGER.record("issued");',
  ),
};

// The rest of what B19 flags: the other two files that reach into another workspace by path.
const REACHES: Record<string, string> = {
  "services/api/test/fixtures/seed.ts": lines(
    'import { order } from "../../../../packages/orders-contract/src/index";',
    "export const seed = order;",
  ),
  "services/auth/src/index.ts": 'export * from "../../../packages/string-util/src/format";\n',
  "packages/string-util/src/format.ts": "export const format = (n: number) => String(n);\n",
  "packages/orders-contract/src/index.ts": lines(
    "export type Order = { id: string };",
    'export const order: Order = { id: "1" };',
  ),
};

export const SHOP_WORKER_FILES: Record<string, string> = {
  "tsconfig.json": SHOP_TSCONFIG,
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "services/*"\n',
  ...MANIFESTS,
  ...CONFIGS,
  ...CLEAN,
  ...BINDING_USES,
  ...REACHES,
};

export const SHOP_WORKER_RULES = {
  features: { "services/api": ["orders", "billing"], "services/auth": ["sessions"] },
  layout: { "services/api": "hexagonal", "services/auth": "hexagonal" },
  acrossDeployables: [
    "binding-outside-driven-adapter",
    "worker-call-cycle",
    "relative-import-crosses-workspace",
  ],
};

// `[scope, kind, from, to ?? specifier]` of each crossing a run over the repo root lists: seven
// bindings, two cycles and five relative imports, none of B1-B14.
export const SHOP_WORKER_CROSSINGS: readonly (readonly [string, string, string, string])[] = [
  ["services/api", "binding-outside-driven-adapter", `${ORDERS}/application/place.ts`, "DB"],
  ["services/api", "binding-outside-driven-adapter", `${ORDERS}/adapters/driving/http.ts`, "AUTH"],
  ["services/api", "binding-outside-driven-adapter", `${API}/main.ts`, "EVENTS"],
  [
    "services/api",
    "binding-outside-driven-adapter",
    `${ORDERS}/application/place.test.ts`,
    "CACHE",
  ],
  ["services/api", "binding-outside-driven-adapter", `${BILLING}/application/charge.ts`, "ASSETS"],
  ["services/api", "binding-outside-driven-adapter", `${BILLING}/application/charge.ts`, "BILLING"],
  ["services/auth", "binding-outside-driven-adapter", `${AUTH}/application/issue.ts`, "LEDGER"],
  [
    ".",
    "worker-call-cycle",
    "api, auth, billing-worker",
    "api.AUTH -> auth; api.BILLING -> billing-worker; auth.LEDGER -> billing-worker; billing-worker.API -> api",
  ],
  [".", "worker-call-cycle", "mailer, search", "mailer.SEARCH -> search; search.MAILER -> mailer"],
  ["services/api", "relative-import-crosses-workspace", `${API}/main.ts`, "packages/string-util"],
  [
    "services/api",
    "relative-import-crosses-workspace",
    `${ORDERS}/application/place.test.ts`,
    "packages/string-util",
  ],
  [
    "services/api",
    "relative-import-crosses-workspace",
    "services/api/test/fixtures/seed.ts",
    "packages/orders-contract",
  ],
  [
    "services/api",
    "relative-import-crosses-workspace",
    `${BILLING}/application/charge.ts`,
    "packages/orders-contract",
  ],
  [
    "services/auth",
    "relative-import-crosses-workspace",
    "services/auth/src/index.ts",
    "packages/string-util",
  ],
];
