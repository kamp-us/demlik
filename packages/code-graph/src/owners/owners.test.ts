import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeployableCensus } from "../boundaries/deployables/census.js";
import { ledgerTargetOf } from "../boundaries/ledger.js";
import { BoundaryRulesSchema } from "../boundaries/rules.js";
import { runHexagon } from "../hexagon/cli.js";
import { type BoundaryRepo, boundaryRepo, type GateRun } from "../test-helpers/boundary-repo.js";
import { reportOf } from "../test-helpers/library-report.js";
import { shopManifests } from "../test-helpers/shop-workspace.js";
import type { OwnersReport } from "./render.js";
import { API, at, OWNERS_FILES, OWNERS_RULES } from "./shop.fixture.js";

let repos: BoundaryRepo[] = [];
const open = (
  files: Record<string, string> = OWNERS_FILES,
  rules: unknown = OWNERS_RULES,
): BoundaryRepo => {
  const repo = boundaryRepo(".", files, rules);
  repos.push(repo);
  return repo;
};
afterEach(() => {
  for (const repo of repos) repo.dispose();
  repos = [];
});

const reportFrom = (run: GateRun): OwnersReport => JSON.parse(run.stdout);

// Where a file sits, as the view prints it.
const feature = (name: string, zone: string) => ({ kind: "feature", feature: name, zone });
const driven = (name: string) => feature(name, "driven");
const LIB = { kind: "lib" };
const ELSEWHERE = { kind: "elsewhere" };
const INTERPRETER = { kind: "interpreter", technology: "queue" };

const PORT = "(id: string) => Promise<void>";
const command = (name: string, type: string) => ({ name, type, signature: PORT });

const ORDER_STORE = at("src/orders/adapters/driven/order-store.ts");

// The whole result for the shop fixture, in `--json`. Each row is one way a file reaches a table
// another feature owns; a file that uses its own table, imports a type or an enum, spreads a
// namespace, rebinds the name, re-exports it or is a test file has no row.
const SHOP_SCOPE = {
  scope: API,
  features: [
    {
      feature: "audit",
      tables: ["entries"],
      reach: [
        { table: "entries", access: "write", file: at("src/lib/seed.ts"), place: LIB },
        { table: "entries", access: "read", file: at("src/main.ts"), place: ELSEWHERE },
      ],
      commands: [],
      externalSystems: [],
    },
    {
      feature: "billing",
      tables: ["invoices"],
      reach: [{ table: "invoices", access: "write", file: at("src/main.ts"), place: ELSEWHERE }],
      commands: [command("charge", "ForPlacingBilling")],
      externalSystems: [command("ledger", "ForStoringBilling")],
    },
    {
      feature: "orders",
      tables: ["orderLines", "orders"],
      reach: [
        {
          table: "orderLines",
          access: "read",
          file: at("src/audit/adapters/driven/audit-reads.ts"),
          place: driven("audit"),
        },
        {
          table: "orderLines",
          access: "write",
          file: at("src/audit/adapters/driven/via-barrel.ts"),
          place: driven("audit"),
        },
        {
          table: "orderLines",
          access: "read",
          file: at("src/interpreters/queue/outbox.ts"),
          place: INTERPRETER,
        },
        {
          table: "orders",
          access: "write",
          file: at("src/audit/adapters/driven/audit-store.ts"),
          place: driven("audit"),
        },
        {
          table: "orders",
          access: "write",
          file: at("src/billing/adapters/driven/invoice-store.ts"),
          place: driven("billing"),
        },
        { table: "orders", access: "read", file: at("src/lib/seed.ts"), place: LIB },
        {
          table: "orders",
          access: "read",
          file: at("src/shipping/adapters/driven/shipment-reads.ts"),
          place: driven("shipping"),
        },
        {
          table: "orders",
          access: "write",
          file: at("src/shipping/adapters/driven/shipment-store.ts"),
          place: driven("shipping"),
        },
        {
          table: "orders",
          access: "foreign-key",
          file: at("src/shipping/adapters/driven/tables.ts"),
          place: feature("shipping", "tables"),
        },
      ],
      commands: [command("place", "ForPlacingOrders")],
      externalSystems: [command("store", "ForStoringOrders")],
    },
    {
      feature: "shipping",
      tables: ["shipments"],
      reach: [],
      commands: [command("ship", "ForPlacingShipping")],
      externalSystems: [command("carrier", "ForStoringShipping")],
    },
  ],
  workers: [
    {
      worker: "api",
      bindings: [
        {
          binding: "DB",
          kind: "d1",
          owners: [ORDER_STORE],
          sites: [
            { file: at("src/main.ts"), line: 4, place: { kind: "main" } },
            { file: ORDER_STORE, line: 3, place: driven("orders") },
            {
              file: at("src/orders/application/place.ts"),
              line: 1,
              place: feature("orders", "application"),
            },
          ],
        },
      ],
    },
  ],
  technologies: [
    {
      technology: "queue",
      root: at("src/interpreters/queue"),
      modules: ["@shop/queue-sdk"],
      reach: [
        { file: at("src/audit/adapters/driven/queue-reexport.ts"), place: driven("audit") },
        { file: at("src/billing/adapters/driven/enqueue.ts"), place: driven("billing") },
        { file: at("src/orders/adapters/driven/queue-shape.ts"), place: driven("orders") },
        { file: at("src/shipping/adapters/driven/carrier.ts"), place: driven("shipping") },
      ],
    },
  ],
  // `rebound.ts` writes a parameter that shares the name of a table it imports, so the write is to
  // whatever the caller passed: the view says it could not follow it.
  notFollowed: [{ file: at("src/billing/adapters/driven/rebound.ts"), kind: "untraced-write" }],
};

const SHOP_REPORT = { scopes: [SHOP_SCOPE], notRead: [] };

const SHOP_HUMAN = [
  "services/api",
  "  Feature audit",
  "    Tables",
  "      entries",
  "    Reach into its tables",
  "      entries  write        services/api/src/lib/seed.ts  lib",
  "      entries  read         services/api/src/main.ts  elsewhere",
  "    Commands",
  "      none",
  "    External systems",
  "      none",
  "  Feature billing",
  "    Tables",
  "      invoices",
  "    Reach into its tables",
  "      invoices  write        services/api/src/main.ts  elsewhere",
  "    Commands",
  "      charge: ForPlacingBilling = (id: string) => Promise<void>",
  "    External systems",
  "      ledger: ForStoringBilling = (id: string) => Promise<void>",
  "  Feature orders",
  "    Tables",
  "      orderLines, orders",
  "    Reach into its tables",
  "      orderLines  read         services/api/src/audit/adapters/driven/audit-reads.ts  feature audit (driven)",
  "      orderLines  write        services/api/src/audit/adapters/driven/via-barrel.ts  feature audit (driven)",
  "      orderLines  read         services/api/src/interpreters/queue/outbox.ts  interpreter queue",
  "      orders  write        services/api/src/audit/adapters/driven/audit-store.ts  feature audit (driven)",
  "      orders  write        services/api/src/billing/adapters/driven/invoice-store.ts  feature billing (driven)",
  "      orders  read         services/api/src/lib/seed.ts  lib",
  "      orders  read         services/api/src/shipping/adapters/driven/shipment-reads.ts  feature shipping (driven)",
  "      orders  write        services/api/src/shipping/adapters/driven/shipment-store.ts  feature shipping (driven)",
  "      orders  foreign-key  services/api/src/shipping/adapters/driven/tables.ts  feature shipping (tables)",
  "    Commands",
  "      place: ForPlacingOrders = (id: string) => Promise<void>",
  "    External systems",
  "      store: ForStoringOrders = (id: string) => Promise<void>",
  "  Feature shipping",
  "    Tables",
  "      shipments",
  "    Reach into its tables",
  "      none",
  "    Commands",
  "      ship: ForPlacingShipping = (id: string) => Promise<void>",
  "    External systems",
  "      carrier: ForStoringShipping = (id: string) => Promise<void>",
  "  Workers",
  "    api",
  "      DB (d1), narrowed to services/api/src/orders/adapters/driven/order-store.ts",
  "        services/api/src/main.ts:4  worker main",
  "        services/api/src/orders/adapters/driven/order-store.ts:3  feature orders (driven)",
  "        services/api/src/orders/application/place.ts:1  feature orders (application)",
  "  Technologies",
  "    queue",
  "      root: services/api/src/interpreters/queue",
  "      modules: @shop/queue-sdk",
  "      Imported from",
  "        services/api/src/audit/adapters/driven/queue-reexport.ts  feature audit (driven)",
  "        services/api/src/billing/adapters/driven/enqueue.ts  feature billing (driven)",
  "        services/api/src/orders/adapters/driven/queue-shape.ts  feature orders (driven)",
  "        services/api/src/shipping/adapters/driven/carrier.ts  feature shipping (driven)",
  "  Not followed",
  "    services/api/src/billing/adapters/driven/rebound.ts  untraced-write  write whose table is not an import",
  "",
  "Not read",
  "  none",
  "",
].join("\n");

describe("a team asks who owns a table, a binding or a technology, and who reaches into it", () => {
  it("prints the whole result as data", () => {
    const run = open().owners({ json: true });
    expect(run.code).toBe(0);
    expect(run.errors).toEqual([]);
    expect(JSON.parse(run.stdout)).toEqual(SHOP_REPORT);
  });

  it("prints the same facts for a person to read", () => {
    const run = open().owners();
    expect(run.code).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.stdout).toBe(SHOP_HUMAN);
  });

  it("lists nothing for a table used by its own feature, a type, an enum, a spread, a rebinding, a re-export or a test", () => {
    const silent = [
      "src/orders/adapters/driven/order-store.ts",
      "src/billing/adapters/driven/order-shape.ts",
      "src/billing/adapters/driven/order-status.ts",
      "src/audit/adapters/driven/spread.ts",
      "src/billing/adapters/driven/rebound.ts",
      "src/billing/adapters/driven/reexport.ts",
      "src/billing/adapters/driven/member.ts",
      "src/billing/adapters/driven/invoice-store.test.ts",
    ].map(at);
    for (const file of silent) expect(Object.keys(OWNERS_FILES), file).toContain(file);
    const listed = reportFrom(open().owners({ json: true })).scopes.flatMap((scope) =>
      scope.features.flatMap((owned) => owned.reach.map((row) => row.file)),
    );
    for (const file of silent) expect(listed, file).not.toContain(file);
  });
});

describe("the view and the gate cannot disagree", () => {
  it("lists as a write exactly what B23 lists, table by table and file by file", () => {
    const repo = open();
    const gate = reportOf(repo.run({ json: true })).scopes.flatMap((scope) => scope.violations);
    const flagged = gate
      .filter((violation) => violation.kind === "table-written-outside-owner")
      .map((violation) => [
        violation.from,
        ledgerTargetOf(violation) ?? "",
        "owner" in violation ? violation.owner : "",
      ])
      .sort();
    const written = reportFrom(repo.owners({ json: true }))
      .scopes.flatMap((scope) => scope.features)
      .flatMap((owned) =>
        owned.reach
          .filter((row) => row.access === "write")
          .map((row) => [row.file, row.table, owned.feature]),
      )
      .sort();
    expect(flagged).toHaveLength(6);
    expect(written).toEqual(flagged);
  });

  it("lists the binding sites of the boundaries census, minus the files testFiles lists", () => {
    const repo = open();
    const census = (
      reportOf(repo.run({ json: true })) as unknown as { deployables: DeployableCensus }
    ).deployables;
    const testSite = at("src/orders/adapters/driven/order-store.test.ts");
    const sites = census.workers.flatMap((worker) =>
      worker.sites.map((site) => [worker.worker, site.binding, site.file, site.line]),
    );
    expect(sites.map((site) => site[2])).toContain(testSite);

    const viewed = reportFrom(repo.owners({ json: true })).scopes.flatMap((scope) =>
      scope.workers.flatMap((worker) =>
        worker.bindings.flatMap((binding) =>
          binding.sites.map((site) => [worker.worker, binding.binding, site.file, site.line]),
        ),
      ),
    );
    expect(viewed).toEqual(sites.filter((site) => site[2] !== testSite));
  });

  it("lists the ports --hexagon lists, and none for a feature with no ports.ts", () => {
    const repo = open();
    const owned = reportFrom(repo.owners({ json: true })).scopes.flatMap((scope) => scope.features);
    expect(owned.map((row) => row.feature)).toEqual(["audit", "billing", "orders", "shipping"]);
    for (const row of owned) {
      const out: string[] = [];
      const errors: string[] = [];
      runHexagon(path.join(repo.root, API, "src", row.feature), {
        json: true,
        pretty: false,
        emit: (text) => out.push(text),
        report: (error) => errors.push(error),
      });
      if (row.feature === "audit") {
        expect(errors, "the hexagon view refuses a feature with no ports.ts").toHaveLength(1);
        expect([row.commands, row.externalSystems]).toEqual([[], []]);
        continue;
      }
      const hexagon = JSON.parse(out.join(""));
      expect(row.commands).toEqual(hexagon.commands);
      expect(row.externalSystems).toEqual(hexagon.externalSystems);
      expect(row.commands.length + row.externalSystems.length).toBeGreaterThan(0);
    }
  });
});

describe("a view is read-only, deterministic and local to the path it is given", () => {
  it("prints the same bytes twice, with no absolute path", () => {
    const repo = open();
    for (const options of [{ json: true }, {}]) {
      const first = repo.owners(options).stdout;
      expect(repo.owners(options).stdout).toBe(first);
      expect(first).not.toContain(repo.root);
    }
  });

  it("reads no ledger and writes no file", () => {
    const repo = open();
    const before = fs.readdirSync(repo.root, { recursive: true }).sort();
    expect(repo.owners().code).toBe(0);
    expect(fs.readdirSync(repo.root, { recursive: true }).sort()).toEqual(before);
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    expect(fs.existsSync(repo.legacyFile)).toBe(false);
    fs.writeFileSync(repo.ledgerFile, "not json");
    const junk = repo.owners({ json: true });
    expect(junk.code).toBe(0);
    expect(JSON.parse(junk.stdout)).toEqual(SHOP_REPORT);
    expect(fs.readFileSync(repo.ledgerFile, "utf8")).toBe("not json");
  });

  it("picks the declared scopes beneath the analyzed path, as --boundaries does", () => {
    const other = "services/stock";
    const repo = open(
      {
        ...OWNERS_FILES,
        ...shopManifests([other]),
        [`${other}/src/stock/adapters/driven/tables.ts`]:
          'import { pgTable, text } from "drizzle-orm/pg-core";\nexport const stock = pgTable("stock", { id: text("id").primaryKey() });\n',
      },
      { ...OWNERS_RULES, features: { ...OWNERS_RULES.features, [other]: ["stock"] } },
    );
    const scopesAt = (at?: string): string[] =>
      reportFrom(repo.owners({ json: true, at })).scopes.map((scope) => scope.scope);
    expect(scopesAt()).toEqual([API, other]);
    expect(scopesAt(".")).toEqual([API, other]);
    expect(scopesAt(API)).toEqual([API]);
    expect(scopesAt(other)).toEqual([other]);
    expect(scopesAt("services")).toEqual([API, other]);
    expect(reportOf(repo.run({ json: true, at: API })).scopes.map((scope) => scope.scope)).toEqual([
      API,
    ]);
    const only = reportFrom(repo.owners({ json: true, at: other }));
    expect(only.scopes[0]?.features).toEqual([
      { feature: "stock", tables: ["stock"], reach: [], commands: [], externalSystems: [] },
    ]);
  });
});

describe("--owners is a view and never a gate", () => {
  it("exits 0 in a repo the gate fails", () => {
    const repo = open();
    expect(repo.run({ ci: true }).code).toBe(1);
    expect(repo.owners().code).toBe(0);
  });

  it("exits 0 and prints the empty answer for a rules file with no scope", () => {
    const run = open(OWNERS_FILES, { features: {} }).owners({ json: true });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ scopes: [], notRead: [] });
    expect(open(OWNERS_FILES, { features: {} }).owners().stdout).toBe("none\n\nNot read\n  none\n");
  });

  it("lists a port-layout scope with no feature to own a table", () => {
    const ports = "services/ports";
    const folders = ["application", "driving-adapters", "driven-adapters"];
    const repo = open(
      {
        ...shopManifests([ports]),
        [`${ports}/src/driven-adapters/tables.ts`]:
          'import { pgTable, text } from "drizzle-orm/pg-core";\nexport const orders = pgTable("orders", { id: text("id").primaryKey() });\n',
      },
      { features: { [ports]: folders } },
    );
    const run = repo.owners({ json: true });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      scopes: [{ scope: ports, features: [], workers: [], technologies: [], notFollowed: [] }],
      notRead: [],
    });
    expect(repo.owners().stdout).toBe(
      `${ports}\n  Features\n    none\n  Workers\n    none\n  Technologies\n    none\n  Not followed\n    none\n\nNot read\n  none\n`,
    );
  });

  it("reads the table and binding facts whether or not the rules file gates them", () => {
    const gated = ["tableOwnership", "acrossDeployables", "bindingOwners"];
    const bare = Object.fromEntries(
      Object.entries(OWNERS_RULES).filter(([key]) => !gated.includes(key)),
    );
    const run = open(OWNERS_FILES, bare).owners({ json: true });
    expect(run.code).toBe(0);
    const [scope] = reportFrom(run).scopes;
    expect(scope?.features).toEqual(SHOP_SCOPE.features);
    expect(scope?.technologies).toEqual(SHOP_SCOPE.technologies);
    expect(scope?.workers).toEqual([
      {
        worker: "api",
        bindings: [
          {
            ...SHOP_SCOPE.workers[0]?.bindings[0],
            owners: [],
          },
        ],
      },
    ]);
  });

  it("names a wrangler config it cannot parse and keeps the rest of the report", () => {
    const { bindingOwners: _narrowed, ...rules } = OWNERS_RULES;
    const repo = open(OWNERS_FILES, rules);
    repo.put(at("wrangler.jsonc"), "{ not json");
    expect(repo.run().code, "the gate refuses to read the same repo").toBe(2);
    const run = repo.owners({ json: true });
    expect(run.code).toBe(0);
    expect(run.errors).toEqual([]);
    expect(reportFrom(run)).toEqual({
      scopes: [{ ...SHOP_SCOPE, workers: [] }],
      notRead: [{ file: at("wrangler.jsonc"), reason: "wrangler config cannot be parsed" }],
    });
    expect(repo.owners().stdout).toContain(
      `Not read\n  ${at("wrangler.jsonc")}: wrangler config cannot be parsed\n`,
    );
  });
});

describe("--owners exits 2 with one line and no report where the gate would not start", () => {
  const refused = (run: GateRun): string => {
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.errors).toHaveLength(1);
    return run.errors[0] ?? "";
  };

  it("refuses a rules file it cannot read", () => {
    const repo = open();
    const missing = path.join(repo.root, "missing.json");
    expect(refused(repo.owners({ rules: missing }))).toBe(refused(repo.run({ rules: missing })));
  });

  it("refuses a rules file with a kind it does not know, naming the word", () => {
    const repo = open();
    const bad = path.join(repo.root, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ ...OWNERS_RULES, tableOwnership: ["table-writen"] }));
    const message = refused(repo.owners({ rules: bad }));
    expect(message).toContain("tableOwnership");
    expect(message).toBe(refused(repo.run({ rules: bad })));
  });

  it("refuses a table kind where no scope is laid out per feature, as the gate does", () => {
    const repo = open();
    const bad = path.join(repo.root, "ports.json");
    const ports = { "services/ports": ["application", "driving-adapters", "driven-adapters"] };
    fs.writeFileSync(
      bad,
      JSON.stringify({ features: ports, tableOwnership: ["table-written-outside-owner"] }),
    );
    expect(refused(repo.owners({ rules: bad }))).toBe(refused(repo.run({ rules: bad })));
  });

  it("refuses an owner of a binding whose worker config it cannot parse, as the gate refuses the config", () => {
    const repo = open();
    repo.put(at("wrangler.jsonc"), "{ not json");
    expect(refused(repo.run())).toContain("a wrangler config cannot be parsed");
    expect(refused(repo.owners())).toContain("order-store.ts");
  });

  it("refuses a scope the gate refuses at the edge", () => {
    const rules = {
      ...OWNERS_RULES,
      bindingOwners: { [API]: { DB: ["src/orders/adapters/driven/missing.ts"] } },
    };
    const repo = open(OWNERS_FILES, rules);
    const message = refused(repo.owners());
    expect(message).toContain("missing.ts");
    expect(message).toBe(refused(repo.run()));
  });
});

describe("the rules file gains no key", () => {
  it("lists the keys it listed before --owners", () => {
    expect(Object.keys(BoundaryRulesSchema.shape).sort()).toEqual([
      "acrossDeployables",
      "allowImportNames",
      "applicationMayImport",
      "applicationShape",
      "bindingOwners",
      "compositionRoots",
      "features",
      "interpreters",
      "lib",
      "libraries",
      "libraryRoots",
      "libraryTypes",
      "pureDependencies",
      "readAllowance",
      "tableOwnership",
      "testFiles",
      "worldLibraries",
    ]);
  });
});
