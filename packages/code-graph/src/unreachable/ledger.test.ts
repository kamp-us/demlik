import { describe, expect, it } from "vitest";
import { type UnreachableFindingKind, UnreachableFindingKindSchema } from "../schema.js";
import {
  parseUnreachableLedger,
  reconcileUnreachable,
  serializeUnreachableLedger,
  type UnreachableFinding,
  type UnreachableLedger,
  withAcceptedFindings,
} from "./ledger.js";

const dead = (scope: string, id: string): UnreachableFinding => ({ scope, kind: "dead", id });
const testOnly = (scope: string, id: string): UnreachableFinding => ({
  scope,
  kind: "only-called-from-tests",
  id,
});
const recorded = (...findings: UnreachableFinding[]): UnreachableLedger => ({
  entries: findings.map((finding) => ({ ...finding, reason: "kept" })),
});

describe("parseUnreachableLedger", () => {
  it("reads a well-formed ledger, sorted by scope, kind and id", () => {
    const read = parseUnreachableLedger(
      JSON.stringify({
        entries: [
          { scope: "b", kind: "dead", id: "src/a.ts:x", reason: "r" },
          { scope: "a", kind: "only-called-from-tests", id: "src/a.ts:y", reason: "r" },
          { scope: "a", kind: "dead", id: "src/z.ts:z", reason: "r" },
        ],
      }),
    );
    expect(read.kind).toBe("read");
    if (read.kind !== "read") return;
    expect(read.ledger.entries.map((e) => [e.scope, e.kind, e.id])).toEqual([
      ["a", "dead", "src/z.ts:z"],
      ["a", "only-called-from-tests", "src/a.ts:y"],
      ["b", "dead", "src/a.ts:x"],
    ]);
  });

  it.each([
    ["not JSON", "{"],
    ["an unknown kind", '{"entries":[{"scope":"a","kind":"gone","id":"x","reason":"r"}]}'],
    ["a blank reason", '{"entries":[{"scope":"a","kind":"dead","id":"x","reason":"  "}]}'],
    ["a missing reason", '{"entries":[{"scope":"a","kind":"dead","id":"x"}]}'],
    ["an extra key", '{"entries":[{"scope":"a","kind":"dead","id":"x","reason":"r","to":1}]}'],
    ["no entries array", "{}"],
    [
      "a duplicate key",
      '{"entries":[{"scope":"a","kind":"dead","id":"x","reason":"r"},{"scope":"a","kind":"dead","id":"x","reason":"s"}]}',
    ],
  ])("refuses %s", (_, text) => {
    expect(parseUnreachableLedger(text).kind).toBe("invalid");
  });
});

describe("reconcileUnreachable", () => {
  const ledger = recorded(
    dead("packages/a", "src/gone.ts:g"),
    dead("packages/a", "src/kept.ts:k"),
    testOnly("packages/a", "src/t.ts:t"),
    dead("packages/b", "src/gone.ts:g"),
  );

  it("names the unrecorded findings and prunes only the analyzed scope's vanished entries", () => {
    const result = reconcileUnreachable(
      ledger,
      "packages/a",
      [dead("packages/a", "src/kept.ts:k"), dead("packages/a", "src/new.ts:n")],
      ["dead", "only-called-from-tests"],
    );
    expect(result.unrecorded).toEqual([dead("packages/a", "src/new.ts:n")]);
    expect(result.pruned.map((e) => e.id)).toEqual(["src/gone.ts:g", "src/t.ts:t"]);
    expect(result.kept.entries.map((e) => [e.scope, e.id])).toEqual([
      ["packages/a", "src/kept.ts:k"],
      ["packages/b", "src/gone.ts:g"],
    ]);
  });

  it("counts an entry of another scope naming the same symbol as recorded, and never prunes it", () => {
    const fromPackage = recorded(
      dead("packages/a", "src/x.ts:x"),
      dead("packages/b", "src/y.ts:y"),
    );
    const atRoot = reconcileUnreachable(
      fromPackage,
      ".",
      [dead(".", "packages/a/src/x.ts:x"), dead(".", "packages/c/src/z.ts:z")],
      ["dead"],
    );
    expect(atRoot.unrecorded).toEqual([dead(".", "packages/c/src/z.ts:z")]);
    expect(atRoot.pruned).toEqual([]);
    expect(atRoot.kept.entries).toEqual(fromPackage.entries);

    const atPackage = reconcileUnreachable(
      recorded(dead(".", "packages/a/src/x.ts:x")),
      "packages/a",
      [dead("packages/a", "src/x.ts:x")],
      ["dead"],
    );
    expect(atPackage.unrecorded).toEqual([]);
    expect(atPackage.pruned).toEqual([]);
  });

  it("lets another scope's entry cover the same symbol measured under another kind", () => {
    const fromPackage = recorded(dead("packages/a", "src/x.ts:x"));
    const atRoot = reconcileUnreachable(
      fromPackage,
      ".",
      [testOnly(".", "packages/a/src/x.ts:x")],
      ["dead", "only-called-from-tests"],
    );
    expect(atRoot.unrecorded).toEqual([]);
    expect(atRoot.recorded).toBe(1);
    expect(atRoot.pruned).toEqual([]);
    expect(atRoot.kept.entries).toEqual(fromPackage.entries);

    const atPackage = reconcileUnreachable(
      recorded(testOnly(".", "packages/a/src/x.ts:x")),
      "packages/a",
      [dead("packages/a", "src/x.ts:x")],
      ["dead", "only-called-from-tests"],
    );
    expect(atPackage.unrecorded).toEqual([]);
    expect(atPackage.pruned).toEqual([]);
  });

  describe("across two scopes, by what the narrower scope holds", () => {
    const ALL: readonly UnreachableFindingKind[] = UnreachableFindingKindSchema.options;
    const of = (scope: string, kind: UnreachableFindingKind, id: string): UnreachableFinding => ({
      scope,
      kind,
      id,
    });

    it.each<[UnreachableFindingKind, UnreachableFindingKind, boolean]>([
      ["dead", "dead", true],
      ["dead", "only-called-from-tests", true],
      ["dead", "unused-export", true],
      ["only-called-from-tests", "dead", false],
      ["only-called-from-tests", "only-called-from-tests", true],
      ["only-called-from-tests", "unused-export", false],
      ["unused-export", "dead", false],
      ["unused-export", "only-called-from-tests", false],
      ["unused-export", "unused-export", true],
    ])("narrower %s, wider %s: covered is %s, whichever one is the entry", (narrow, wide, covered) => {
      const inPackage = of("packages/a", narrow, "src/x.ts:x");
      const atRoot = of(".", wide, "packages/a/src/x.ts:x");

      const rootRun = reconcileUnreachable(recorded(inPackage), ".", [atRoot], ALL);
      expect(rootRun.unrecorded).toEqual(covered ? [] : [atRoot]);
      expect(rootRun.pruned).toEqual([]);

      const packageRun = reconcileUnreachable(recorded(atRoot), "packages/a", [inPackage], ALL);
      expect(packageRun.unrecorded).toEqual(covered ? [] : [inPackage]);
      expect(packageRun.pruned).toEqual([]);
    });

    it("reads a nested scope that is not the root the same way", () => {
      const result = reconcileUnreachable(
        recorded(testOnly("packages/a/src", "x.ts:x")),
        "packages/a",
        [dead("packages/a", "src/x.ts:x")],
        ALL,
      );
      expect(result.unrecorded).toEqual([dead("packages/a", "src/x.ts:x")]);
    });

    it("fails a root --dead-only run on a dead symbol a package recorded as test-only", () => {
      const result = reconcileUnreachable(
        recorded(testOnly("packages/a", "src/x.ts:x")),
        ".",
        [dead(".", "packages/a/src/x.ts:x")],
        ["dead"],
      );
      expect(result.unrecorded).toEqual([dead(".", "packages/a/src/x.ts:x")]);
    });

    it("passes a kind change at one of two recording scopes and fails it at the other", () => {
      const both = recorded(dead(".", "packages/a/src/x.ts:x"), dead("packages/a", "src/x.ts:x"));
      const gainedTest = reconcileUnreachable(
        both,
        ".",
        [testOnly(".", "packages/a/src/x.ts:x")],
        ALL,
      );
      expect(gainedTest.unrecorded).toEqual([]);
      expect(gainedTest.pruned).toEqual([
        { ...dead(".", "packages/a/src/x.ts:x"), reason: "kept" },
      ]);
      expect(
        reconcileUnreachable(both, "packages/a", [testOnly("packages/a", "src/x.ts:x")], ALL)
          .unrecorded,
      ).toEqual([testOnly("packages/a", "src/x.ts:x")]);

      const bothTested = recorded(
        testOnly(".", "packages/a/src/x.ts:x"),
        testOnly("packages/a", "src/x.ts:x"),
      );
      expect(
        reconcileUnreachable(bothTested, "packages/a", [dead("packages/a", "src/x.ts:x")], ALL)
          .unrecorded,
      ).toEqual([]);
      expect(
        reconcileUnreachable(bothTested, ".", [dead(".", "packages/a/src/x.ts:x")], ALL).unrecorded,
      ).toEqual([dead(".", "packages/a/src/x.ts:x")]);
    });
  });

  it("does not let another scope's entry of another symbol cover a finding", () => {
    const result = reconcileUnreachable(
      recorded(dead("packages/a", "src/x.ts:other"), dead("packages/b", "src/x.ts:x")),
      ".",
      [dead(".", "packages/a/src/x.ts:x")],
      ["dead", "only-called-from-tests"],
    );
    expect(result.unrecorded).toEqual([dead(".", "packages/a/src/x.ts:x")]);
  });

  it("leaves a kind the run does not gate alone: never unrecorded, never pruned", () => {
    const result = reconcileUnreachable(
      ledger,
      "packages/a",
      [dead("packages/a", "src/kept.ts:k"), testOnly("packages/a", "src/fresh.ts:f")],
      ["dead"],
    );
    expect(result.unrecorded).toEqual([]);
    expect(result.pruned.map((e) => e.id)).toEqual(["src/gone.ts:g"]);
    expect(result.kept.entries.some((e) => e.id === "src/t.ts:t")).toBe(true);
  });

  it("reads a finding whose kind changed as a new finding and its old entry as gone", () => {
    const result = reconcileUnreachable(
      recorded(dead("packages/a", "src/x.ts:x")),
      "packages/a",
      [testOnly("packages/a", "src/x.ts:x")],
      ["dead", "only-called-from-tests"],
    );
    expect(result.unrecorded).toEqual([testOnly("packages/a", "src/x.ts:x")]);
    expect(result.pruned.map((e) => e.kind)).toEqual(["dead"]);
  });
});

describe("withAcceptedFindings", () => {
  it("adds each finding with the reason and keeps the reason already recorded", () => {
    const next = withAcceptedFindings(
      recorded(dead("a", "src/x.ts:x")),
      [dead("a", "src/x.ts:x"), dead("a", "src/y.ts:y")],
      "new",
    );
    expect(next.entries.map((e) => [e.id, e.reason])).toEqual([
      ["src/x.ts:x", "kept"],
      ["src/y.ts:y", "new"],
    ]);
  });

  it("serializes to the same bytes whatever order the entries arrive in", () => {
    const a = recorded(dead("a", "src/x.ts:x"), dead("a", "src/y.ts:y"));
    const b = recorded(dead("a", "src/y.ts:y"), dead("a", "src/x.ts:x"));
    expect(serializeUnreachableLedger(a)).toBe(serializeUnreachableLedger(b));
  });
});
