import { describe, expect, it } from "vitest";
import { __deepEqual } from "./assert-wrapper-faithful";

// The conformance gate (`assertWrapperFaithful`) leans on `__deepEqual` for its
// byte-identical Cmd checks and the intercepting retag-record check. The bug
// being closed here: the old `JSON.stringify`-based equality DROPPED
// undefined-valued fields, so a wrapper that smuggled an extra `undefined` field
// into a "byte-identical" base Cmd (or a retag carrier) slipped through.
describe("__deepEqual", () => {
  it("CATCHES a Cmd that differs only by an undefined-valued field", () => {
    // The exact betrayal that previously slipped through JSON.stringify: an
    // ABSENT key vs an `undefined`-VALUED key must NOT be treated as equal.
    expect(__deepEqual({ type: "x" }, { type: "x", foo: undefined })).toBe(
      false,
    );
    // Symmetric: extra undefined-valued key on the FIRST argument.
    expect(__deepEqual({ type: "x", foo: undefined }, { type: "x" })).toBe(
      false,
    );
  });

  it("treats two identically-shaped undefined-valued fields as equal", () => {
    // An undefined-valued field present on BOTH sides is genuine equality —
    // both carry the key, both carry `undefined`.
    expect(
      __deepEqual({ type: "x", foo: undefined }, { type: "x", foo: undefined }),
    ).toBe(true);
  });

  it("compares primitives and null/undefined exactly", () => {
    expect(__deepEqual(1, 1)).toBe(true);
    expect(__deepEqual("a", "a")).toBe(true);
    expect(__deepEqual(true, true)).toBe(true);
    expect(__deepEqual(null, null)).toBe(true);
    expect(__deepEqual(undefined, undefined)).toBe(true);

    expect(__deepEqual(1, 2)).toBe(false);
    expect(__deepEqual("a", "b")).toBe(false);
    expect(__deepEqual(0, false)).toBe(false);
    expect(__deepEqual("", false)).toBe(false);
    // null vs undefined are distinct (JSON.stringify would erase the gap).
    expect(__deepEqual(null, undefined)).toBe(false);
    // null vs object — null is typeof "object" but only equals null.
    expect(__deepEqual(null, {})).toBe(false);
    expect(__deepEqual({}, null)).toBe(false);
  });

  it("recurses into nested objects", () => {
    expect(
      __deepEqual(
        { type: "x", payload: { a: 1, b: [2, 3] } },
        { type: "x", payload: { a: 1, b: [2, 3] } },
      ),
    ).toBe(true);
    // A nested undefined-valued field is caught at depth too.
    expect(
      __deepEqual(
        { type: "x", payload: { a: 1 } },
        { type: "x", payload: { a: 1, b: undefined } },
      ),
    ).toBe(false);
    expect(
      __deepEqual(
        { type: "x", payload: { a: 1 } },
        { type: "x", payload: { a: 2 } },
      ),
    ).toBe(false);
  });

  it("compares arrays element-wise and by length", () => {
    expect(__deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(__deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(__deepEqual([1, 2, 3], [1, 2])).toBe(false);
    expect(__deepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(__deepEqual([{ a: 1 }], [{ a: 2 }])).toBe(false);
    // An array is not equal to a plain object, even if "shaped" alike.
    expect(__deepEqual([], {})).toBe(false);
    expect(__deepEqual({ 0: "a", length: 1 }, ["a"])).toBe(false);
    // A hole vs an explicit-undefined element are both length-1 and equal here
    // (both read as undefined at index 0).
    expect(__deepEqual([undefined], [undefined])).toBe(true);
  });
});
