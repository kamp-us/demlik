import { describe, expect, it } from "vitest";
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
