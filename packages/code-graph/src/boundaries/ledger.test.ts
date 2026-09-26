import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BoundaryLedger,
  type BoundaryLedgerEntry,
  boundaryLedgerOf,
  parseBoundaryLedger,
  readBoundaryLedger,
  rekeyBoundaryLedger,
  rekeyBoundaryLedgerFile,
  serializeBoundaryLedger,
  writeBoundaryLedger,
} from "./ledger.js";

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
        "entries.0.to: only an impure-rules entry may have a null `to` (a bare-specifier import)",
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
