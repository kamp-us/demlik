import { describe, expect, it } from "vitest";
import type { Smell } from "../schema.js";
import {
  parseSmellLedger,
  reconcileSmells,
  repoTarget,
  type SmellLedger,
  type SmellLedgerEntry,
  serializeSmellLedger,
  withAcceptedSmells,
} from "./ledger.js";
import { RULES, type SmellKind, smellKinds } from "./rules.js";

const ALL: ReadonlySet<SmellKind> = new Set(smellKinds());
const SYNTAX_ONLY: ReadonlySet<SmellKind> = new Set(
  smellKinds().filter((kind) => RULES[kind].measuredBy === "syntax"),
);

const entry = (rule: SmellKind, target: string, value: number): SmellLedgerEntry => ({
  rule,
  target,
  value,
  reason: "kept",
});

const ledger = (gated: SmellKind[], ...entries: SmellLedgerEntry[]): SmellLedger => ({
  gated,
  entries,
});

describe("repoTarget", () => {
  const smell = (target: Smell["target"]): Smell => ({
    kind: "long-function",
    target,
    value: 1,
    threshold: 0,
    severity: "warn",
  });

  it("prefixes the scope to a function id, keeping its name and #n, never its start line", () => {
    const target = {
      type: "function",
      id: "src/a.ts:run#2",
      file: "src/a.ts",
      startLine: 40,
    } as const;
    expect(repoTarget("packages/core", smell(target))).toBe("packages/core/src/a.ts:run#2");
    expect(repoTarget(".", smell(target))).toBe("src/a.ts:run#2");
  });

  it("joins a module file and a directory, the analyzed root itself included", () => {
    expect(repoTarget("packages/core", smell({ type: "module", file: "src/a.ts" }))).toBe(
      "packages/core/src/a.ts",
    );
    expect(repoTarget("packages/core", smell({ type: "directory", dir: "." }))).toBe(
      "packages/core",
    );
    expect(repoTarget(".", smell({ type: "directory", dir: "." }))).toBe(".");
  });
});

describe("reconcileSmells", () => {
  it("keeps an entry of a gated rule this run did not measure", () => {
    const fanIn = entry("high-fan-in", "packages/core/src/a.ts:shared", 12);
    const result = reconcileSmells(
      ledger(["high-fan-in"], fanIn),
      "packages/core",
      [],
      SYNTAX_ONLY,
    );
    expect(result.pruned).toEqual([]);
    expect(result.kept.entries).toEqual([fanIn]);
  });

  it("prunes the same entry when the run measured the rule and found no smell", () => {
    const fanIn = entry("high-fan-in", "packages/core/src/a.ts:shared", 12);
    const result = reconcileSmells(ledger(["high-fan-in"], fanIn), "packages/core", [], ALL);
    expect(result.pruned).toEqual([fanIn]);
    expect(result.kept.entries).toEqual([]);
  });

  it("leaves entries of an ungated rule and of another scope as they are", () => {
    const ungated = entry("long-function", "packages/core/src/a.ts:run", 90);
    const elsewhere = entry("big-file", "packages/core-extra/src/b.ts", 500);
    const result = reconcileSmells(
      ledger(["big-file"], ungated, elsewhere),
      "packages/core",
      [],
      ALL,
    );
    expect(result.pruned).toEqual([]);
    expect(result.kept.entries).toEqual([elsewhere, ungated]);
  });

  it("lowers an improved entry, flags a worsened one and ignores an ungated finding", () => {
    const result = reconcileSmells(
      ledger(["big-file"], entry("big-file", "p/a.ts", 900), entry("big-file", "p/b.ts", 500)),
      "p",
      [
        { rule: "big-file", target: "p/a.ts", value: 850 },
        { rule: "big-file", target: "p/b.ts", value: 600 },
        { rule: "long-function", target: "p/c.ts:run", value: 99 },
      ],
      ALL,
    );
    expect(result.unrecorded).toEqual([]);
    expect(result.lowered).toEqual([
      { rule: "big-file", target: "p/a.ts", recorded: 900, measured: 850 },
    ]);
    expect(result.worsened).toEqual([
      { rule: "big-file", target: "p/b.ts", recorded: 500, measured: 600 },
    ]);
    expect(result.kept.entries.map((kept) => kept.value)).toEqual([850, 500]);
  });
});

describe("withAcceptedSmells", () => {
  it("adds every unrecorded smell and raises every worsened one, each with the reason", () => {
    const result = reconcileSmells(
      ledger(["big-file"], entry("big-file", "p/b.ts", 500)),
      "p",
      [
        { rule: "big-file", target: "p/a.ts", value: 450 },
        { rule: "big-file", target: "p/b.ts", value: 600 },
      ],
      ALL,
    );
    expect(withAcceptedSmells(result, "split later").entries).toEqual([
      { rule: "big-file", target: "p/a.ts", value: 450, reason: "split later" },
      { rule: "big-file", target: "p/b.ts", value: 600, reason: "split later" },
    ]);
  });
});

describe("parseSmellLedger", () => {
  it("reads a gated list alone, with no entries yet", () => {
    expect(parseSmellLedger('{ "gated": ["big-file"] }')).toEqual({
      kind: "read",
      ledger: { gated: ["big-file"], entries: [] },
    });
  });

  it.each([
    ['{ "gated": ["big-files"] }', '"big-files" is not a smell rule'],
    ['{ "gated": ["big-file", "big-file"] }', "duplicate gated rule"],
    [
      '{ "entries": [{ "rule": "big-file", "target": "a.ts", "value": 1, "reason": "x" }, { "rule": "big-file", "target": "a.ts", "value": 2, "reason": "y" }] }',
      "duplicate entry",
    ],
    [
      '{ "entries": [{ "rule": "big-file", "target": "a.ts", "value": 1, "reason": " " }] }',
      "blank",
    ],
    ['{ "gated": [], "extra": 1 }', "extra"],
  ])("refuses %s", (text, message) => {
    const read = parseSmellLedger(text);
    expect(read.kind).toBe("invalid");
    expect(read.kind === "invalid" ? read.message : "").toContain(message);
  });

  it("serializes sorted, so a round trip is byte-stable", () => {
    const text = serializeSmellLedger(
      ledger(
        ["long-function", "big-file"],
        entry("long-function", "b.ts:x", 70),
        entry("big-file", "z.ts", 500),
      ),
    );
    const read = parseSmellLedger(text);
    expect(read.kind === "read" ? serializeSmellLedger(read.ledger) : "").toBe(text);
    expect(JSON.parse(text).gated).toEqual(["big-file", "long-function"]);
  });
});
