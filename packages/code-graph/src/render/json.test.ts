import { describe, expect, it } from "vitest";
import { stableStringify } from "./json.js";

describe("stableStringify (SPEC §3)", () => {
  it("sorts object keys alphabetically", () => {
    expect(stableStringify({ b: 1, a: 2 }, false)).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively in nested objects", () => {
    const out = stableStringify({ z: { y: 1, x: 2 }, a: 3 }, false);
    expect(out).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it("does NOT reorder array elements", () => {
    const out = stableStringify(
      {
        list: [
          { b: 1, a: 2 },
          { d: 3, c: 4 },
        ],
      },
      false,
    );
    expect(out).toBe('{"list":[{"a":2,"b":1},{"c":4,"d":3}]}');
  });

  it("is byte-stable regardless of input key order", () => {
    const a = stableStringify({ one: 1, two: 2, three: 3 }, false);
    const b = stableStringify({ three: 3, one: 1, two: 2 }, false);
    expect(a).toBe(b);
  });

  it("pretty mode indents with two spaces", () => {
    expect(stableStringify({ a: 1 }, true)).toBe('{\n  "a": 1\n}');
  });
});
