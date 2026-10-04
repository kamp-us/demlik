import { afterEach, describe, expect, it } from "vitest";
import { API, apiRepo, at } from "../../test-helpers/api-repo.js";
import type { BoundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  crossingsOf,
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
  sorted,
} from "../../test-helpers/library-report.js";
import { shopManifests } from "../../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "../ledger.js";
import type { BoundaryViolation } from "../violation.js";

// A team that keeps decision-free read handlers in its features' driving folders: four features of
// `services/api`, one listed read file each, six handlers that parse, call that file and return,
// and three crossings the allowance must still refuse.

const B8 = "driving-reaches-driven";
const lines = (...source: string[]): string => `${source.join("\n")}\n`;

const select = (table: string): string =>
  lines(`export const read = (env: Env) => env.DB.prepare("SELECT * FROM ${table}");`);
const UPDATE = lines(
  "export const read = (env: Env) =>",
  '  env.DB.prepare("UPDATE shipments SET shipped = 1");',
);

const handler = (reads: string, ...imports: string[]): string =>
  lines(
    'import { z } from "zod";',
    'import { rpc } from "../../../lib/rpc";',
    ...imports,
    `import { read } from "../driven/${reads}";`,
    "export const handle = rpc(z.object({}), read);",
  );

const CLEAN = {
  "src/orders/adapters/driving/list-orders-http.ts": "order-reads",
  "src/orders/adapters/driving/get-order-http.ts": "order-reads",
  "src/billing/adapters/driving/get-invoice-http.ts": "invoice-reads",
  "src/billing/adapters/driving/list-invoices-http.ts": "invoice-reads",
  "src/catalog/adapters/driving/list-products-http.ts": "product-reads",
  "src/catalog/adapters/driving/get-product-http.ts": "product-reads",
};

const LEDGER_HTTP = "src/billing/adapters/driving/ledger-http.ts";
const LEDGER_READS = "src/billing/adapters/driven/ledger-reads.ts";
const PLACE_HTTP = "src/orders/adapters/driving/place-http.ts";
const PLACE = "src/orders/application/place.ts";
const SHIP_HTTP = "src/shipping/adapters/driving/ship-http.ts";
const SHIPMENT_READS = "src/shipping/adapters/driven/shipment-reads.ts";

const CROSSINGS = [
  [B8, at(LEDGER_HTTP), at(LEDGER_READS)],
  [B8, at(PLACE_HTTP), at(PLACE)],
  [B8, at(SHIP_HTTP), at(SHIPMENT_READS)],
];

const LISTED = [
  "src/orders/adapters/driven/order-reads.ts",
  "src/billing/adapters/driven/invoice-reads.ts",
  "src/catalog/adapters/driven/product-reads.ts",
  SHIPMENT_READS,
];

// The scope's files, with `shipment-reads.ts` as given: a read, or a write.
const files = (shipmentReads: string): Record<string, string> => ({
  "src/lib/rpc.ts": "export const rpc = (schema: unknown, read: unknown) => [schema, read];\n",
  "src/orders/adapters/driven/order-reads.ts": select("orders"),
  "src/billing/adapters/driven/invoice-reads.ts": select("invoices"),
  [LEDGER_READS]: select("ledger"),
  "src/catalog/adapters/driven/product-reads.ts": select("products"),
  [SHIPMENT_READS]: shipmentReads,
  [PLACE]: "export const place = 1;\n",
  ...Object.fromEntries(Object.entries(CLEAN).map(([file, reads]) => [file, handler(reads)])),
  [LEDGER_HTTP]: handler("ledger-reads"),
  [SHIP_HTTP]: handler("shipment-reads"),
  [PLACE_HTTP]: lines(
    'import { z } from "zod";',
    'import { rpc } from "../../../lib/rpc";',
    'import { place } from "../../application/place";',
    "export const handle = rpc(z.object({}), place);",
  ),
});

const FEATURES = { features: { [API]: ["orders", "billing", "shipping", "catalog"] } };
const WORKSPACE = {
  "pnpm-workspace.yaml": 'packages:\n  - "services/*"\n',
  [`${API}/wrangler.jsonc`]: JSON.stringify({ name: "api", d1_databases: [{ binding: "DB" }] }),
};
const KERNEL = {
  libraryTypes: { kernel: { imports: ["kernel"], pure: true } },
  libraries: { "packages/domain-kernel": "kernel" },
};

let repo: BoundaryRepo | null = null;
afterEach(() => repo?.dispose());

type Row = BoundaryViolation & { write?: { file: string; line: number; binding: string } };

const open = (rules: Record<string, unknown>, shipmentReads: string = UPDATE): BoundaryRepo => {
  repo = apiRepo(
    files(shipmentReads),
    { ...FEATURES, ...rules },
    {
      ...WORKSPACE,
      ...shopManifests(["packages/domain-kernel"]),
    },
  );
  return repo;
};

const b8From = (run: BoundaryRepo): string[] =>
  reportOf(run.run({ json: true }))
    .scopes.flatMap((scope) => scope.violations)
    .filter((v) => v.kind === B8)
    .map((v) => v.from)
    .sort();

describe("a read allowance that omits decidedBy lets a decision-free read handler pass B8", () => {
  const OMITTED = { readAllowance: { [API]: { driven: LISTED } } };

  it("lists exactly the three crossings in every view, and none of the six handlers", () => {
    const run = open(OMITTED);
    const failed = run.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(entryLines(failed.stdout)).toHaveLength(3);
    const site = `[write: DB at ${at(SHIPMENT_READS)}:2]`;
    expect(entryLines(failed.stdout).filter((line) => line.includes(site))).toHaveLength(1);

    const json = run.run({ json: true });
    expect(json.code).toBe(0);
    expect(crossingsOf(json)).toEqual(sorted(CROSSINGS));
    const row = reportOf(json)
      .scopes.flatMap((scope) => scope.violations as Row[])
      .find((v) => v.from === at(SHIP_HTTP));
    expect(row?.write).toEqual({ file: at(SHIPMENT_READS), line: 2, binding: "DB" });

    const plain = run.run();
    expect(plain.code).toBe(0);
    expect(plain.stdout.match(/^ {2}B\d+ /gm)).toHaveLength(3);
    expect(plain.stdout).toContain(site);
  });

  it("records the three, gates green byte for byte, and prunes the shipping entry once the write is gone", () => {
    const run = open(OMITTED);
    expect(run.run({ ci: true }).code).toBe(1);

    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const entries = ledgerOf(run).entries;
    expect(sorted(entries.map((e) => [e.kind, e.from, ledgerTargetOf(e)]))).toEqual(
      sorted(CROSSINGS),
    );
    expect(entries.some((entry) => "write" in entry)).toBe(false);
    const seeded = ledgerText(run);
    const first = run.run({ ci: true });
    const second = run.run({ ci: true });
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toContain("3 recorded crossing(s), none new");
    expect(ledgerText(run)).toBe(seeded);

    run.put(at(SHIPMENT_READS), select("shipments"));
    const fixed = run.run({ ci: true });
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone:");
    expect(fixed.stdout).toContain(`${at(SHIP_HTTP)} -> ${at(SHIPMENT_READS)}`);
    expect(ledgerOf(run).entries.map((entry) => entry.from)).toEqual([
      at(LEDGER_HTTP),
      at(PLACE_HTTP),
    ]);
    const settled = ledgerText(run);
    expect(run.run({ ci: true }).code).toBe(0);
    expect(ledgerText(run)).toBe(settled);
  });
});

describe("a read allowance that names decidedBy is judged as it was", () => {
  const NAMED = {
    ...KERNEL,
    readAllowance: { [API]: { driven: LISTED, decidedBy: ["kernel"] } },
  };

  it("keeps B8 on the six handlers that run no kernel import, and clears the one that does", () => {
    const run = open(NAMED);
    const six = Object.keys(CLEAN).map(at);
    const crossing = CROSSINGS.map(([, from]) => from ?? "");
    expect(b8From(run)).toEqual([...six, ...crossing].sort());

    const [first = ""] = Object.keys(CLEAN);
    run.put(at(first), handler("order-reads", 'import { total } from "@shop/domain-kernel";'));
    expect(b8From(run)).toEqual([...six.slice(1), ...crossing].sort());
  });
});
