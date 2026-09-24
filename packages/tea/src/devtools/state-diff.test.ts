import { describe, expect, it } from "vitest";
import { diffState, formatDiff, type StateChange } from "./state-diff";

describe("diffState", () => {
  it("returns [] for deeply-equal states", () => {
    expect(diffState({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
    expect(diffState(5, 5)).toEqual([]);
    expect(diffState(null, null)).toEqual([]);
  });

  it("ignores object key order (sorted-union walk)", () => {
    expect(diffState({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it("reports a changed leaf with both values", () => {
    expect(diffState({ total: 121.5 }, { total: 135 })).toEqual<StateChange[]>([
      { path: "state.total", kind: "changed", expected: 121.5, actual: 135 },
    ]);
  });

  it("reports an added key", () => {
    expect(diffState({}, { tax: 8 })).toEqual<StateChange[]>([
      { path: "state.tax", kind: "added", expected: undefined, actual: 8 },
    ]);
  });

  it("reports a removed key", () => {
    expect(diffState({ coupon: "X" }, {})).toEqual<StateChange[]>([
      {
        path: "state.coupon",
        kind: "removed",
        expected: "X",
        actual: undefined,
      },
    ]);
  });

  it("walks nested objects with dotted paths", () => {
    const changes = diffState(
      { user: { name: "ada", age: 30 } },
      { user: { name: "ada", age: 31 } },
    );
    expect(changes).toEqual<StateChange[]>([
      { path: "state.user.age", kind: "changed", expected: 30, actual: 31 },
    ]);
  });

  it("indexes arrays by [i], matching trace-replay path syntax", () => {
    const changes = diffState(
      { items: [{ status: "done" }, { status: "done" }] },
      { items: [{ status: "done" }, { status: "pending" }] },
    );
    expect(changes).toEqual<StateChange[]>([
      {
        path: "state.items[1].status",
        kind: "changed",
        expected: "done",
        actual: "pending",
      },
    ]);
  });

  it("reports surplus/missing array elements as added/removed (not a node-level length mismatch)", () => {
    expect(diffState([1, 2], [1, 2, 3])).toEqual<StateChange[]>([
      { path: "state[2]", kind: "added", expected: undefined, actual: 3 },
    ]);
    expect(diffState([1, 2, 3], [1, 2])).toEqual<StateChange[]>([
      { path: "state[2]", kind: "removed", expected: 3, actual: undefined },
    ]);
  });

  it("collects EVERY difference in deterministic pre-order (the richer-cousin contract)", () => {
    const changes = diffState({ a: 1, b: 2, c: 3 }, { a: 9, b: 2, c: 3, d: 4 });
    // sorted-union key order: a (changed), then d (added). b/c equal.
    expect(changes).toEqual<StateChange[]>([
      { path: "state.a", kind: "changed", expected: 1, actual: 9 },
      { path: "state.d", kind: "added", expected: undefined, actual: 4 },
    ]);
  });

  it("treats NaN as equal to NaN (Object.is leaf equality)", () => {
    expect(diffState({ x: Number.NaN }, { x: Number.NaN })).toEqual([]);
  });

  it("treats +0 and -0 as different (Object.is leaf equality)", () => {
    expect(diffState({ x: 0 }, { x: -0 })).toEqual<StateChange[]>([
      { path: "state.x", kind: "changed", expected: 0, actual: -0 },
    ]);
  });

  it("reports a kind change (object vs array) as one changed at the node, no descent", () => {
    const expected = { v: { length: 2 } };
    const actual = { v: [1, 2] };
    expect(diffState(expected, actual)).toEqual<StateChange[]>([
      {
        path: "state.v",
        kind: "changed",
        expected: { length: 2 },
        actual: [1, 2],
      },
    ]);
  });

  it("reports a scalar root mismatch at path 'state'", () => {
    expect(diffState(1, 2)).toEqual<StateChange[]>([
      { path: "state", kind: "changed", expected: 1, actual: 2 },
    ]);
  });
});

describe("formatDiff", () => {
  it("returns the empty string for no changes", () => {
    expect(formatDiff([])).toBe("");
  });

  it("renders ~ for changed, - for removed, + for added", () => {
    const changes: StateChange[] = [
      { path: "state.total", kind: "changed", expected: 121.5, actual: 135 },
      {
        path: "state.coupon",
        kind: "removed",
        expected: "X",
        actual: undefined,
      },
      { path: "state.tax", kind: "added", expected: undefined, actual: 8 },
    ];
    expect(formatDiff(changes)).toBe(
      [
        "~ state.total: 121.5 → 135",
        '- state.coupon: "X"',
        "+ state.tax: 8",
      ].join("\n"),
    );
  });

  it('quotes strings so "3" is distinct from 3', () => {
    expect(
      formatDiff([
        { path: "state.x", kind: "changed", expected: "3", actual: 3 },
      ]),
    ).toBe('~ state.x: "3" → 3');
  });

  it("spells out NaN and undefined that JSON would mangle", () => {
    expect(
      formatDiff([
        {
          path: "state.x",
          kind: "changed",
          expected: Number.NaN,
          actual: undefined,
        },
      ]),
    ).toBe("~ state.x: NaN → undefined");
  });

  it("is the deterministic text form of a diffState result (round-trip)", () => {
    const changes = diffState(
      { a: 1, items: [{ s: "done" }] },
      { a: 1, items: [{ s: "pending" }], extra: true },
    );
    expect(formatDiff(changes)).toBe(
      ["+ state.extra: true", '~ state.items[0].s: "done" → "pending"'].join(
        "\n",
      ),
    );
  });
});
