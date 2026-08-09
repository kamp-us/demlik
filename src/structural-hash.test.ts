import { describe, expect, it } from "vitest";
import { structuralHash } from "./index";

// ───────────────────────────────────────────────────────────────────────────
// `structuralHash` is the kernel's ONE "turn a plain value into a stable id"
// primitive — the dep-keyed Sub id, the identity comparison, and the subs
// batteries' handle-table keys all derive from it. Two properties are
// load-bearing and everything else follows from them:
//
//   1. DETERMINISM + ORDER-INDEPENDENCE. Insertion order is not identity, so
//      `{ runId, phase }` and `{ phase, runId }` are ONE key. Without this a
//      Sub churns every time a reducer rebuilds its deps slice with the fields
//      in a different order.
//   2. LOUD FAILURE on a value with no stable identity. A closure hashed by
//      any structural walk would produce an unstable id — a Sub that remounts
//      forever. It throws instead of silently doing that.
// ───────────────────────────────────────────────────────────────────────────

describe("structuralHash — determinism", () => {
  it("sorts object keys, so field order is not identity", () => {
    expect(structuralHash({ runId: "r1", phase: "auditing" })).toBe(
      structuralHash({ phase: "auditing", runId: "r1" }),
    );
  });

  it("sorts keys at every depth, not just the top level", () => {
    expect(structuralHash({ outer: { a: 1, b: 2 }, z: [{ c: 3, d: 4 }] })).toBe(
      structuralHash({ z: [{ d: 4, c: 3 }], outer: { b: 2, a: 1 } }),
    );
  });

  it("is stable across repeated calls on equal values", () => {
    const a = structuralHash({ runId: "r1", attempts: [1, 2, 3] });
    const b = structuralHash({ runId: "r1", attempts: [1, 2, 3] });
    expect(a).toBe(b);
  });

  it("changes exactly when the slice changes", () => {
    const before = structuralHash({ runId: "r1", phase: "idle" });
    expect(structuralHash({ runId: "r1", phase: "auditing" })).not.toBe(before);
    expect(structuralHash({ runId: "r2", phase: "idle" })).not.toBe(before);
  });

  it("array order IS identity (a list is ordered, a record is not)", () => {
    expect(structuralHash([1, 2])).not.toBe(structuralHash([2, 1]));
  });
});

describe("structuralHash — distinctness of the primitive scalars", () => {
  it("a string key and the same-looking number key never collide", () => {
    // The handle-table consequence: `live.get(keyString(1))` must never return
    // the transport opened for `"1"`.
    expect(structuralHash("1")).not.toBe(structuralHash(1));
  });

  it("null, undefined, and their string spellings stay distinct", () => {
    const rendered = [
      structuralHash(null),
      structuralHash(undefined),
      structuralHash("null"),
      structuralHash("undefined"),
    ];
    expect(new Set(rendered).size).toBe(4);
  });

  it("booleans stay distinct from their string spellings", () => {
    expect(structuralHash(true)).not.toBe(structuralHash("true"));
  });

  it("an empty object and an empty array are different keys", () => {
    expect(structuralHash({})).not.toBe(structuralHash([]));
  });
});

describe("structuralHash — loud failure on unstable values", () => {
  it("throws on a function rather than producing an unstable id", () => {
    expect(() => structuralHash(() => {})).toThrow(/function in `deps`/);
  });

  it("throws on a function nested inside the slice", () => {
    expect(() => structuralHash({ runId: "r1", onDone: () => {} })).toThrow(
      /function in `deps`/,
    );
  });

  it("throws on a symbol (not JSON-representable)", () => {
    expect(() => structuralHash(Symbol("s"))).toThrow(/unsupported/);
  });

  it("throws on a bigint (not JSON-representable)", () => {
    expect(() => structuralHash(10n)).toThrow(/unsupported/);
  });
});
