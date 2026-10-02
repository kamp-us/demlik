import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOUNDARY_KINDS,
  type BoundaryLedger,
  type BoundaryLedgerEntry,
  boundaryLedgerOf,
  ledgerKey,
  parseBoundaryLedger,
  readBoundaryLedger,
  rekeyBoundaryLedger,
  rekeyBoundaryLedgerFile,
  serializeBoundaryLedger,
  writeBoundaryLedger,
} from "./ledger.js";
import { crossingOf } from "./violation.js";

const S = "apps/web";

const crossing: BoundaryLedgerEntry = {
  scope: S,
  kind: "cross-feature",
  from: "apps/web/src/billing/flows/charge.ts",
  to: "apps/web/src/users/store/db.ts",
  specifier: "../../users/store/db.js",
  reason: "until users exports a reader",
};
const bare: BoundaryLedgerEntry = {
  scope: S,
  kind: "impure-rules",
  from: "apps/web/src/billing/rules/price.ts",
  to: null,
  specifier: "zod",
};
const untouched: BoundaryLedgerEntry = {
  scope: S,
  kind: "outside-imports-feature-internal",
  from: "apps/web/src/main.ts",
  to: "apps/web/src/billing/store/ledger.ts",
  specifier: "./billing/store/ledger.js",
};

const LEDGER: BoundaryLedger = boundaryLedgerOf([untouched, crossing, bare]);

describe("rekeyBoundaryLedger follows moved files", () => {
  it("re-keys an entry whose importer moved, keeping its target, specifier and reason", () => {
    const moved = rekeyBoundaryLedger(LEDGER, [
      { from: crossing.from, to: "apps/web/src/billing/charge.ts" },
    ]);
    expect(moved.entries).toContainEqual({ ...crossing, from: "apps/web/src/billing/charge.ts" });
    expect(moved.entries.map((e) => e.from)).not.toContain(crossing.from);
  });

  it("re-keys an entry whose target moved", () => {
    const moved = rekeyBoundaryLedger(LEDGER, [
      { from: "apps/web/src/users/store/db.ts", to: "apps/web/src/users/db.ts" },
    ]);
    expect(moved.entries).toContainEqual({ ...crossing, to: "apps/web/src/users/db.ts" });
  });

  it("leaves every entry the move list does not name, and a bare target, as it was", () => {
    const moved = rekeyBoundaryLedger(LEDGER, [
      { from: "apps/web/src/unrelated.ts", to: "apps/web/src/elsewhere.ts" },
      { from: "zod", to: "apps/web/src/zod.ts" },
    ]);
    expect(moved).toEqual(LEDGER);
  });

  it("stays sorted after a move reorders the entries", () => {
    const moved = rekeyBoundaryLedger(LEDGER, [{ from: untouched.from, to: "apps/web/a.ts" }]);
    expect(moved).toEqual(boundaryLedgerOf(moved.entries));
    expect(moved).toEqual(boundaryLedgerOf([...moved.entries].reverse()));
  });
});

describe("the ledger file", () => {
  let dir = "";
  let file = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ledger-"));
    file = path.join(dir, "boundary-ledger.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips through the writer and reader, serialized sorted and stable", () => {
    writeBoundaryLedger(file, { entries: [bare, crossing, untouched] });
    expect(readBoundaryLedger(file)).toEqual({ kind: "read", ledger: LEDGER });
    expect(fs.readFileSync(file, "utf8")).toBe(serializeBoundaryLedger(LEDGER));
    expect(serializeBoundaryLedger({ entries: [untouched, bare, crossing] })).toBe(
      serializeBoundaryLedger(LEDGER),
    );
  });

  it("reads an absent file as absent, and refuses a malformed one", () => {
    expect(readBoundaryLedger(file)).toEqual({ kind: "absent" });
    expect(parseBoundaryLedger("{").kind).toBe("invalid");
    expect(parseBoundaryLedger(JSON.stringify({ entries: [{ ...crossing, to: null }] }))).toEqual({
      kind: "invalid",
      message:
        "entries.0.to: only a bare-specifier import, a world door or a feature's entry may have " +
        "a null `to` (kinds application-import-outside-allowlist, binding-outside-driven-adapter, " +
        "door-outside-driven-adapter, door-outside-owner, impure-application, impure-library, " +
        "impure-rules, index-not-exports-only, library-undeclared, unknown-zone, worker-call-cycle)",
    });
    expect(parseBoundaryLedger(JSON.stringify({ entries: [crossing], extra: 1 })).kind).toBe(
      "invalid",
    );
  });

  it("keys an entry by its target, not the specifier as written", () => {
    const rewritten = { ...crossing, specifier: "#users/store/db", reason: undefined };
    expect(boundaryLedgerOf([rewritten, crossing]).entries).toEqual([crossing]);
  });

  it("re-keys the file in place and reports how many entries moved", () => {
    writeBoundaryLedger(file, LEDGER);
    const result = rekeyBoundaryLedgerFile(file, [
      { from: crossing.from, to: "apps/web/src/billing/charge.ts" },
      { from: untouched.to ?? "", to: "apps/web/src/billing/ledger.ts" },
    ]);
    expect(result).toEqual({ kind: "rekeyed", entries: 2 });
    const read = readBoundaryLedger(file);
    expect(read.kind === "read" ? read.ledger.entries.map((e) => e.to ?? e.specifier) : []).toEqual(
      ["apps/web/src/users/store/db.ts", "zod", "apps/web/src/billing/ledger.ts"],
    );
  });

  it("leaves an absent ledger absent", () => {
    expect(rekeyBoundaryLedgerFile(file, [{ from: "a.ts", to: "b.ts" }])).toEqual({
      kind: "absent",
    });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("a world door is a ledger entry with no target file", () => {
  const door: BoundaryLedgerEntry = {
    scope: S,
    kind: "door-outside-owner",
    from: "apps/web/src/billing/flows/charge.ts",
    to: null,
    specifier: "process.env",
  };
  const imported: BoundaryLedgerEntry = {
    scope: S,
    kind: "impure-rules",
    from: "apps/web/src/billing/rules/price.ts",
    to: null,
    specifier: "fetch",
  };
  const read: BoundaryLedgerEntry = { ...imported, global: true };

  it("lists the kind, accepts a null `to` on it, and refuses one on every kind naming a file", () => {
    expect(BOUNDARY_KINDS).toContain("door-outside-owner");
    expect(parseBoundaryLedger(JSON.stringify({ entries: [door] })).kind).toBe("read");
    const mayHaveNoFile: readonly string[] = [
      "application-import-outside-allowlist",
      "binding-outside-driven-adapter",
      "door-outside-driven-adapter",
      "door-outside-owner",
      "impure-application",
      "impure-library",
      "impure-rules",
      "index-not-exports-only",
      "library-undeclared",
      "unknown-zone",
      "worker-call-cycle",
    ];
    const namesAFile = BOUNDARY_KINDS.filter((kind) => !mayHaveNoFile.includes(kind));
    expect(namesAFile).toHaveLength(8);
    for (const kind of namesAFile) {
      const entry = { ...crossing, kind, to: null };
      expect(parseBoundaryLedger(JSON.stringify({ entries: [entry] })).kind).toBe("invalid");
    }
  });

  it("re-keys a door entry whose importer moved and leaves its null `to` alone", () => {
    const moved = rekeyBoundaryLedger(boundaryLedgerOf([door, read]), [
      { from: door.from, to: "apps/web/src/billing/charge.ts" },
    ]);
    expect(moved.entries).toContainEqual({ ...door, from: "apps/web/src/billing/charge.ts" });
    expect(moved.entries).toContainEqual(read);
    expect(moved.entries.map((e) => e.to)).toEqual([null, null]);
  });

  it("keeps a global read and a bare import of the same name as two entries", () => {
    expect(ledgerKey(read)).not.toBe(ledgerKey(imported));
    const both = boundaryLedgerOf([read, imported, read]);
    expect(both.entries).toEqual([imported, read]);
    expect(boundaryLedgerOf([...both.entries].reverse())).toEqual(both);
    expect(parseBoundaryLedger(serializeBoundaryLedger(both))).toEqual({
      kind: "read",
      ledger: both,
    });
  });

  it("accepts `global` only as `true` on an impure-rules entry with no file", () => {
    const refused = [
      { ...door, global: true },
      { ...crossing, global: true },
      { ...imported, to: "apps/web/src/http.ts", global: true },
      { ...imported, global: false },
    ];
    for (const entry of refused) {
      expect(parseBoundaryLedger(JSON.stringify({ entries: [entry] })).kind).toBe("invalid");
    }
  });
});

describe("the hexagonal kinds are ledger entries", () => {
  const edge = (kind: BoundaryLedgerEntry["kind"]): BoundaryLedgerEntry => ({
    scope: S,
    kind,
    from: "apps/web/src/billing/application/charge.ts",
    to: "apps/web/src/billing/adapters/driven/stripe.ts",
    specifier: "../adapters/driven/stripe.js",
  });
  const noFile = (kind: BoundaryLedgerEntry["kind"], specifier: string): BoundaryLedgerEntry => ({
    scope: S,
    kind,
    from: "apps/web/src/billing/application/charge.ts",
    to: null,
    specifier,
  });
  const parses = (entry: unknown) => parseBoundaryLedger(JSON.stringify({ entries: [entry] })).kind;
  const DOOR_OR_ENTRY = [
    "impure-application",
    "door-outside-driven-adapter",
    "unknown-zone",
  ] as const;
  const FILE_EDGES = ["application-imports-adapter", "driving-reaches-driven"] as const;

  it("lists all five", () => {
    expect(BOUNDARY_KINDS).toEqual(expect.arrayContaining([...DOOR_OR_ENTRY, ...FILE_EDGES]));
  });

  it("accepts a null `to` on a door or an entry, and refuses one on an import of a file", () => {
    for (const kind of DOOR_OR_ENTRY) expect(parses(noFile(kind, "process.env"))).toBe("read");
    for (const kind of FILE_EDGES) {
      expect(parses(edge(kind))).toBe("read");
      expect(parses({ ...edge(kind), to: null })).toBe("invalid");
    }
  });

  it("keeps `global` to impure-rules", () => {
    for (const kind of DOOR_OR_ENTRY) {
      expect(parses({ ...noFile(kind, "fetch"), global: true })).toBe("invalid");
    }
  });

  it("re-keys a moved file in a new-kind entry", () => {
    const zoneEdge = edge("application-imports-adapter");
    const door = noFile("impure-application", "Date.now");
    const moved = rekeyBoundaryLedger(boundaryLedgerOf([zoneEdge, door]), [
      { from: zoneEdge.from, to: "apps/web/src/billing/application/pay.ts" },
      {
        from: "apps/web/src/billing/adapters/driven/stripe.ts",
        to: "apps/web/src/billing/adapters/driven/card.ts",
      },
    ]);
    expect(moved.entries).toEqual([
      {
        ...zoneEdge,
        from: "apps/web/src/billing/application/pay.ts",
        to: "apps/web/src/billing/adapters/driven/card.ts",
      },
      { ...door, from: "apps/web/src/billing/application/pay.ts" },
    ]);
  });
});

describe("the library kinds are ledger entries", () => {
  const LIB = "packages/string-util";
  const up: BoundaryLedgerEntry = {
    scope: LIB,
    kind: "library-imports-up",
    from: `${LIB}/src/x.ts`,
    to: "packages/orders-contract",
    specifier: "@shop/orders-contract/schema",
  };
  const impure: BoundaryLedgerEntry = {
    scope: LIB,
    kind: "impure-library",
    from: `${LIB}/src/log.ts`,
    to: null,
    specifier: "@sentry/node",
  };
  const outside: BoundaryLedgerEntry = {
    scope: "services/api",
    kind: "adapter-library-imported-outside-driven",
    from: "services/api/src/main.ts",
    to: "packages/clock-adapter",
    specifier: "@shop/clock-adapter",
  };
  const undeclared: BoundaryLedgerEntry = {
    scope: "packages",
    kind: "library-undeclared",
    from: "packages/scratch",
    to: null,
    specifier: "scratch",
  };
  const parses = (entry: unknown) => parseBoundaryLedger(JSON.stringify({ entries: [entry] })).kind;

  it("accepts a null `to` on B11 and B13, and refuses one on B12 and B14, which name a directory", () => {
    for (const entry of [impure, undeclared, up, outside]) expect(parses(entry)).toBe("read");
    for (const entry of [up, outside]) expect(parses({ ...entry, to: null })).toBe("invalid");
  });

  it("keeps `global` to impure-rules", () => {
    for (const entry of [impure, undeclared]) {
      expect(parses({ ...entry, global: true })).toBe("invalid");
    }
  });

  it("re-keys a moved importer file in a B12, B13 and B14 entry, and leaves a library directory", () => {
    const moved = rekeyBoundaryLedger(boundaryLedgerOf([up, impure, outside, undeclared]), [
      { from: up.from, to: `${LIB}/src/y.ts` },
      { from: impure.from, to: `${LIB}/src/trace.ts` },
      { from: outside.from, to: "services/api/src/boot.ts" },
    ]);
    expect(moved.entries).toEqual(
      boundaryLedgerOf([
        { ...up, from: `${LIB}/src/y.ts` },
        { ...impure, from: `${LIB}/src/trace.ts` },
        { ...outside, from: "services/api/src/boot.ts" },
        undeclared,
      ]).entries,
    );
  });
});

describe("the deployable kinds are ledger entries", () => {
  const API = "services/api";
  const binding: BoundaryLedgerEntry = {
    scope: API,
    kind: "binding-outside-driven-adapter",
    from: `${API}/src/orders/application/place.ts`,
    to: null,
    specifier: "DB",
  };
  const cycle: BoundaryLedgerEntry = {
    scope: ".",
    kind: "worker-call-cycle",
    from: "api, auth",
    to: null,
    specifier: "api.AUTH -> auth; auth.API -> api",
  };
  const reach: BoundaryLedgerEntry = {
    scope: API,
    kind: "relative-import-crosses-workspace",
    from: `${API}/src/main.ts`,
    to: "packages/string-util",
    specifier: "../../../packages/string-util/src/format",
  };
  const parses = (entry: unknown) => parseBoundaryLedger(JSON.stringify({ entries: [entry] })).kind;

  it("accepts a null `to` on B17 and B18, and refuses one on B19, which names a workspace", () => {
    for (const entry of [binding, cycle, reach]) expect(parses(entry)).toBe("read");
    expect(parses({ ...reach, to: null })).toBe("invalid");
    expect(parses({ ...binding, to: "packages/string-util" })).toBe("read");
  });

  it("keeps `global` to impure-rules", () => {
    for (const entry of [binding, cycle, reach]) {
      expect(parses({ ...entry, global: true })).toBe("invalid");
    }
  });

  it("is a door crossing for B17, an entry for B18 and an import for B19", () => {
    expect([binding, cycle, reach].map(crossingOf)).toEqual(["door", "entry", "import"]);
  });

  it("keys B17 by the file and binding, B18 by the workers and edges, B19 by the importer and workspace", () => {
    expect(boundaryLedgerOf([binding, { ...binding, reason: "r" }]).entries).toHaveLength(1);
    expect(ledgerKey(binding)).not.toBe(ledgerKey({ ...binding, specifier: "CACHE" }));
    expect(ledgerKey(cycle)).not.toBe(ledgerKey({ ...cycle, specifier: "api.AUTH -> auth" }));
    expect(ledgerKey(reach)).toBe(ledgerKey({ ...reach, specifier: "../../../other-spelling" }));
    expect(ledgerKey(reach)).not.toBe(ledgerKey({ ...reach, to: "packages/other" }));
  });

  it("re-keys a moved importer file in a B17 and a B19 entry, and leaves a B18 entry as it is", () => {
    const moved = rekeyBoundaryLedger(boundaryLedgerOf([binding, cycle, reach]), [
      { from: binding.from, to: `${API}/src/orders/application/order.ts` },
      { from: reach.from, to: `${API}/src/boot.ts` },
      { from: "api", to: "elsewhere" },
    ]);
    expect(moved.entries).toEqual(
      boundaryLedgerOf([
        { ...binding, from: `${API}/src/orders/application/order.ts` },
        cycle,
        { ...reach, from: `${API}/src/boot.ts` },
      ]).entries,
    );
  });
});

describe("the shape kinds are ledger entries", () => {
  const API = "services/api";
  const entry: BoundaryLedgerEntry = {
    scope: API,
    kind: "index-not-exports-only",
    from: `${API}/src/billing/index.ts`,
    to: null,
    specifier: "export *",
  };
  const pkg: BoundaryLedgerEntry = {
    scope: API,
    kind: "application-import-outside-allowlist",
    from: `${API}/src/orders/application/place.ts`,
    to: null,
    specifier: "drizzle-orm",
  };
  const file: BoundaryLedgerEntry = {
    ...pkg,
    to: `${API}/src/generated/client.ts`,
    specifier: "../../generated/client",
  };
  const parses = (value: unknown) => parseBoundaryLedger(JSON.stringify({ entries: [value] })).kind;

  it("lists both, and the published subpath reads and writes a ledger that holds them", () => {
    expect(BOUNDARY_KINDS).toEqual(
      expect.arrayContaining(["index-not-exports-only", "application-import-outside-allowlist"]),
    );
    const ledger = boundaryLedgerOf([entry, pkg, file]);
    const text = serializeBoundaryLedger(ledger);
    expect(parseBoundaryLedger(text)).toEqual({ kind: "read", ledger });
  });

  it("allows a null `to` on both: an entry file has no target, and a package is no file", () => {
    for (const value of [entry, pkg, file]) expect(parses(value)).toBe("read");
    for (const value of [entry, pkg]) expect(parses({ ...value, to: null })).toBe("read");
  });

  it("keeps `global` to impure-rules", () => {
    for (const value of [entry, pkg, file]) {
      expect(parses({ ...value, global: true })).toBe("invalid");
    }
  });

  it("is an entry crossing for B15 and an import for B16", () => {
    expect([entry, pkg, file].map(crossingOf)).toEqual(["entry", "import", "import"]);
  });

  it("keys B15 by the file and form, B16 by the file and target, the specifier being display for a file", () => {
    expect(boundaryLedgerOf([entry, { ...entry, reason: "r" }]).entries).toHaveLength(1);
    expect(ledgerKey(entry)).not.toBe(ledgerKey({ ...entry, specifier: "export default" }));
    expect(ledgerKey(pkg)).not.toBe(ledgerKey({ ...pkg, specifier: "hono" }));
    expect(ledgerKey(file)).toBe(ledgerKey({ ...file, specifier: "../generated/client" }));
    expect(ledgerKey(file)).not.toBe(ledgerKey({ ...file, to: `${API}/src/generated/other.ts` }));
  });

  it("re-keys a moved file in a B15 entry's `from`, and in a B16 entry's `from` and, for a file, `to`", () => {
    const moved = rekeyBoundaryLedger(boundaryLedgerOf([entry, pkg, file]), [
      { from: entry.from, to: `${API}/src/invoicing/index.ts` },
      { from: pkg.from, to: `${API}/src/orders/application/order.ts` },
      { from: `${API}/src/generated/client.ts`, to: `${API}/src/generated/api.ts` },
    ]);
    expect(moved.entries).toEqual(
      boundaryLedgerOf([
        { ...entry, from: `${API}/src/invoicing/index.ts` },
        { ...pkg, from: `${API}/src/orders/application/order.ts` },
        {
          ...file,
          from: `${API}/src/orders/application/order.ts`,
          to: `${API}/src/generated/api.ts`,
        },
      ]).entries,
    );
  });
});
