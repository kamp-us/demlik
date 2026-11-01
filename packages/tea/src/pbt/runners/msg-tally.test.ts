import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, type Reducer, structuralHash } from "../../index";
import { arbMsg, arbMsgSequence } from "../arbitraries";
import { MsgTally } from "./msg-tally";
import {
  PropertyFailure,
  type PropertyRun,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
} from "./property";
import { foldEvents, type Step } from "./replay-fold";

// A review path, four states deep. `merge` is reachable only through `approve`, so
// the one-line change below makes both of them never act while every law still
// holds: nothing on the cut path runs, so nothing on it can break.

type State =
  | { readonly type: "draft"; readonly edits: number }
  | { readonly type: "reviewing"; readonly edits: number }
  | { readonly type: "approved"; readonly edits: number }
  | { readonly type: "merged"; readonly edits: number };

type Msg =
  | { readonly type: "edit" }
  | { readonly type: "submit" }
  | { readonly type: "reject" }
  | { readonly type: "approve" }
  | { readonly type: "merge" };

type Notify = { readonly type: "notify" };

const update: Reducer<State, Msg, Notify> = {
  edit: (s) =>
    s.type === "draft" ? [{ ...s, edits: s.edits + 1 }, []] : [s, []],
  submit: (s) =>
    s.type === "draft" ? [{ ...s, type: "reviewing" }, []] : [s, []],
  reject: (s) =>
    s.type === "reviewing" ? [{ ...s, type: "draft" }, []] : [s, []],
  approve: (s) =>
    s.type === "reviewing" ? [{ ...s, type: "approved" }, []] : [s, []],
  merge: (s) =>
    s.type === "approved"
      ? [{ ...s, type: "merged" }, [{ type: "notify" }]]
      : [s, []],
};

const defineReview = (cells: Reducer<State, Msg, Notify>) =>
  defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as Notify,
      ctx: {} as Record<string, never>,
    },
    init: (loaded) => [loaded ?? { type: "draft", edits: 0 }, []],
    update: cells,
  });

const healthy = defineReview(update);
// The one-line change: the path through `approve` is gone.
const cut = defineReview({ ...update, approve: (s) => [s, []] });

const msgArb = arbMsg<Msg>({
  edit: fc.constant({ type: "edit" as const }),
  submit: fc.constant({ type: "submit" as const }),
  reject: fc.constant({ type: "reject" as const }),
  approve: fc.constant({ type: "approve" as const }),
  merge: fc.constant({ type: "merge" as const }),
});

const longLists = arbMsgSequence(msgArb, { size: "max" });

const SEEDS = [1, 42, 20261101];

// Every law the two machines share, as one check.
const lawsHold = ({ prev, next }: Step<State, Msg, Notify>): string | null => {
  if (
    next.type === "approved" &&
    !["reviewing", "approved"].includes(prev.type)
  )
    return "only a review approves";
  if (next.type === "merged" && !["approved", "merged"].includes(prev.type))
    return "only an approved change merges";
  return next.edits < prev.edits ? "edits only grow" : null;
};

type ReviewMachine = typeof healthy;
type Opts = NonNullable<
  Parameters<
    typeof propertyTerminates<State, Msg, Notify, never, Record<string, never>>
  >[4]
>;

const RUNNERS: readonly (readonly [
  string,
  (machine: ReviewMachine, opts: Opts) => PropertyRun,
])[] = [
  [
    "propertyTerminates",
    (machine, opts) =>
      propertyTerminates(machine, {}, longLists, () => true, opts),
  ],
  [
    "propertyInvariant",
    (machine, opts) =>
      propertyInvariant(machine, {}, longLists, lawsHold, opts),
  ],
  [
    "propertyTrace",
    (machine, opts) => propertyTrace(machine, {}, longLists, () => null, opts),
  ],
];

const failureOf = (act: () => unknown): PropertyFailure => {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(PropertyFailure);
    return error as PropertyFailure;
  }
  throw new Error("expected the property to fail, and it passed");
};

const actedOf = (run: PropertyRun, type: string): number | undefined =>
  run.msgCounts.get(type)?.acted;

/** What the steps of `lists` come to, worked out apart from the runner. */
const countsOver = (lists: readonly (readonly Msg[])[]) => {
  const counts = new Map<string, { drawn: number; acted: number }>();
  for (const type of ["edit", "submit", "reject", "approve", "merge"]) {
    counts.set(type, { drawn: 0, acted: 0 });
  }
  for (const msgs of lists) {
    for (const step of foldEvents(healthy, {}, null, msgs).steps) {
      const count = counts.get(step.msg.type);
      if (!count) throw new Error(`unknown type ${step.msg.type}`);
      count.drawn += 1;
      const changed = structuralHash(step.next) !== structuralHash(step.prev);
      if (changed || step.cmds.length > 0) count.acted += 1;
    }
  }
  return counts;
};

describe("a cut path, with failOnNeverActed on", () => {
  describe.each(RUNNERS)("%s", (_name, run) => {
    it.each(SEEDS)("names the 2 types that never acted, seed %i", (seed) => {
      const failure = failureOf(() =>
        run(cut, { seed, failOnNeverActed: true }),
      );

      expect(failure.message).toContain("2 Msg type(s) never acted");
      expect(failure.message).toMatch(/\bapprove \(drawn [1-9]/);
      expect(failure.message).toMatch(/\bmerge \(drawn [1-9]/);
      expect(failure.message).not.toMatch(/\b(edit|submit|reject) \(drawn/);
      expect(failure.run.seed).toBe(seed);
      expect(failure.run.path).toBeNull();
      expect(actedOf(failure.run, "approve")).toBe(0);
      expect(actedOf(failure.run, "merge")).toBe(0);
    });

    it.each(SEEDS)("passes on the unchanged machine, seed %i", (seed) => {
      const passed = run(healthy, { seed, failOnNeverActed: true });

      expect(passed.numRuns).toBe(200);
      for (const count of passed.msgCounts.values()) {
        expect(count.acted).toBeGreaterThan(0);
      }
    });

    it.each(
      SEEDS,
    )("is green on the cut machine with it off, seed %i", (seed) => {
      expect(actedOf(run(cut, { seed }), "merge")).toBe(0);
    });

    // `path: ""` is what `{ path: failure.run.path ?? "" }` hands back for a run
    // this option failed, and fast-check reads it as no path: the full run draws.
    it.each(SEEDS)("still fails on an empty path, seed %i", (seed) => {
      const failure = failureOf(() =>
        run(cut, { seed, path: "", failOnNeverActed: true }),
      );

      expect(failure.run.numRuns).toBe(200);
      expect(failure.message).toContain("2 Msg type(s) never acted");
      expect(failure.message).toMatch(/\bapprove \(drawn [1-9]/);
      expect(failure.message).toMatch(/\bmerge \(drawn [1-9]/);
    });

    // A failure with no shrinks reports a path like "3". Handed back once that
    // failure is gone, it is no replay: fast-check draws a full run from there, and
    // the option stays out, so a cut path reads green.
    it.each(
      SEEDS,
    )("stays out of a full run on a colon-less path, seed %i", (seed) => {
      const passed = run(cut, { seed, path: "3", failOnNeverActed: true });

      expect(passed.numRuns).toBe(200);
      expect(passed.path).toBeNull();
      expect(passed.msgCounts.get("merge")?.drawn).toBeGreaterThan(0);
      expect(actedOf(passed, "merge")).toBe(0);
    });
  });

  it("starts a colon-less path's full run at the list that path names", () => {
    const listsOf = (path: string | undefined) => {
      const lists: (readonly Msg[])[] = [];
      propertyTrace(
        cut,
        {},
        longLists,
        (steps) => {
          lists.push(steps.map((step) => step.msg));
          return true;
        },
        { seed: 1, numRuns: 10, ...(path === undefined ? {} : { path }) },
      );
      return lists;
    };

    const full = listsOf(undefined);
    const fromThree = listsOf("3");

    expect(fromThree).toHaveLength(10);
    expect(fromThree.slice(0, 7)).toEqual(full.slice(3));
  });
});

describe("msgCounts", () => {
  it.each(SEEDS)("reads what the lists did, seed %i", (seed) => {
    const lists: (readonly Msg[])[] = [];
    const run = propertyTrace(
      healthy,
      {},
      longLists,
      (steps) => {
        lists.push(steps.map((step) => step.msg));
        return true;
      },
      { seed },
    );

    expect(run.msgCounts).toEqual(countsOver(lists));
  });

  it("lists the machine's types first, in its own order", () => {
    const run = propertyTrace(healthy, {}, longLists, () => true, { seed: 1 });

    expect([...run.msgCounts.keys()]).toEqual([
      "edit",
      "submit",
      "reject",
      "approve",
      "merge",
    ]);
  });

  it("stops at the failing list, so shrinking adds nothing", () => {
    const lists: (readonly Msg[])[] = [];
    const failure = failureOf(() =>
      propertyTrace(
        healthy,
        {},
        longLists,
        (steps, final) => {
          lists.push(steps.map((step) => step.msg));
          return final.type !== "merged";
        },
        { seed: 1 },
      ),
    );

    expect(failure.run.numShrinks).toBeGreaterThan(0);
    expect(lists.length).toBeGreaterThan(failure.run.numRuns);
    expect(failure.run.msgCounts).toEqual(
      countsOver(lists.slice(0, failure.run.numRuns)),
    );
  });

  it("adds nothing for a list whose reducer threw, though numRuns includes it", () => {
    const throwing = defineReview({
      ...update,
      edit: () => {
        throw new Error("reducer threw");
      },
    });
    const failure = failureOf(() =>
      propertyTrace(
        throwing,
        {},
        arbMsgSequence(fc.constant<Msg>({ type: "edit" }), { minLength: 1 }),
        () => true,
        { seed: 1 },
      ),
    );

    expect(failure.run.numRuns).toBe(1);
    for (const count of failure.run.msgCounts.values()) {
      expect(count).toEqual({ drawn: 0, acted: 0 });
    }
  });

  it("adds nothing for a list fc.pre skipped", () => {
    const lists: (readonly Msg[])[] = [];
    const run = propertyTrace(
      healthy,
      {},
      longLists,
      (steps, final) => {
        fc.pre(final.type !== "merged");
        lists.push(steps.map((step) => step.msg));
        return true;
      },
      { seed: 1, numRuns: 50 },
    );

    expect(lists).toHaveLength(run.numRuns);
    expect(run.msgCounts).toEqual(countsOver(lists));
  });

  it("does not count a new but equal state as acting", () => {
    const copying = defineReview({ ...update, edit: (s) => [{ ...s }, []] });
    const run = propertyTrace(copying, {}, longLists, () => true, { seed: 1 });

    expect(run.msgCounts.get("edit")?.drawn).toBeGreaterThan(0);
    expect(actedOf(run, "edit")).toBe(0);
  });

  it("counts a step that only sent a Cmd as acting", () => {
    const pinging = defineReview({
      ...update,
      edit: (s) => [s, [{ type: "notify" }]],
    });
    const run = propertyTrace(pinging, {}, longLists, () => true, { seed: 1 });

    expect(actedOf(run, "edit")).toBe(run.msgCounts.get("edit")?.drawn);
  });
});

describe("a Msg type never drawn", () => {
  const withoutMerge = arbMsgSequence(
    fc.constantFrom<Msg>({ type: "submit" }, { type: "approve" }),
    { size: "max" },
  );

  it("counts as zero", () => {
    const run = propertyTrace(healthy, {}, withoutMerge, () => true, {
      seed: 1,
    });

    expect(run.msgCounts.get("merge")).toEqual({ drawn: 0, acted: 0 });
  });

  it.each(SEEDS)("fails the option, seed %i", (seed) => {
    const failure = failureOf(() =>
      propertyTrace(healthy, {}, withoutMerge, () => true, {
        seed,
        failOnNeverActed: true,
      }),
    );

    for (const type of ["edit", "reject", "merge"]) {
      expect(failure.message).toContain(`${type} (drawn 0)`);
    }
    expect(failure.message).not.toContain("submit (drawn");
  });
});

describe("failOnNeverActed beside other failures", () => {
  it("leaves a broken law's report alone", () => {
    const failure = failureOf(() =>
      propertyInvariant(
        cut,
        {},
        longLists,
        ({ next }) => (next.edits < 1 ? null : "no edits allowed"),
        { seed: 1, failOnNeverActed: true },
      ),
    );

    expect(failure.message).toContain("no edits allowed");
    expect(failure.message).toContain("Counterexample");
    expect(failure.message).not.toContain("never acted");
    expect(failure.run.path).not.toBeNull();
  });

  it("stays out of a replay, which draws no run's worth of lists", () => {
    const run = propertyTrace(cut, {}, longLists, () => true, {
      seed: 1,
      path: "0:0",
      failOnNeverActed: true,
    });

    expect(actedOf(run, "merge")).toBe(0);
  });
});

describe("a state that isn't plain data", () => {
  type Dated = { readonly at: Date };
  type Tick = { readonly type: "tick" };
  const dated = defineMachine({
    types: {
      model: {} as Dated,
      msg: {} as Tick,
      ctx: {} as Record<string, never>,
    },
    init: () => [{ at: new Date(0) }, []],
    update: { tick: (s: Dated) => [{ at: new Date(s.at) }, []] },
  });
  const ticks = arbMsgSequence(fc.constant<Tick>({ type: "tick" }), {
    minLength: 1,
  });

  class Money {
    constructor(readonly cents: number) {}
  }
  type Swap = { readonly type: "swap" };
  /** A machine that swaps between two states, each a new object to the other. */
  const rebuilding = (one: object, other: object) =>
    defineMachine({
      types: {
        model: {} as object,
        msg: {} as Swap,
        ctx: {} as Record<string, never>,
      },
      init: () => [one, []],
      update: { swap: (s: object) => [s === one ? other : one, []] },
    });
  const swaps = arbMsgSequence(fc.constant<Swap>({ type: "swap" }), {
    minLength: 1,
  });

  it("does not fail a run with the option off", () => {
    const run = propertyTrace(dated, {}, ticks, () => true, { seed: 1 });

    expect(run.numRuns).toBe(200);
    expect(actedOf(run, "tick")).toBe(run.msgCounts.get("tick")?.drawn);
  });

  it("fails the option, since it can't tell what acted", () => {
    const failure = failureOf(() =>
      propertyTrace(dated, {}, ticks, () => true, {
        seed: 1,
        failOnNeverActed: true,
      }),
    );

    expect(failure.message).toContain("can't tell what acted");
    expect(failure.message).toContain("non-plain object (Date)");
  });

  describe.each([
    ["a Date", new Date(0), new Date(0), "non-plain object (Date)"],
    ["a Map", new Map([[1, 2]]), new Map([[1, 2]]), "non-plain object (Map)"],
    [
      "a class instance",
      new Money(1),
      new Money(1),
      "non-plain object (Money)",
    ],
    [
      "a Date set where null stood",
      null,
      new Date(0),
      "non-plain object (Date)",
    ],
    [
      "a Date under a new key",
      undefined,
      new Date(0),
      "non-plain object (Date)",
    ],
  ])("%s deep in a rebuilt state", (_name, before, after, named) => {
    const held = (value: unknown) => ({ deep: [{ value }] });
    const machine = rebuilding(held(before), held(after));

    it("fails the option, naming it", () => {
      const failure = failureOf(() =>
        propertyTrace(machine, {}, swaps, () => true, {
          seed: 1,
          failOnNeverActed: true,
        }),
      );

      expect(failure.message).toContain("can't tell what acted");
      expect(failure.message).toContain(named);
    });

    it("throws nothing with the option off, and counts it as acted", () => {
      const run = propertyTrace(machine, {}, swaps, () => true, { seed: 1 });

      expect(run.numRuns).toBe(200);
      expect(actedOf(run, "swap")).toBe(run.msgCounts.get("swap")?.drawn);
    });
  });

  describe("one the comparison never reaches", () => {
    it("reads nothing in an object both states share", () => {
      const shared = { at: new Date(0), byId: new Map(), money: new Money(1) };
      const machine = rebuilding({ shared, n: 0 }, { shared, n: 1 });

      const run = propertyTrace(machine, {}, swaps, () => true, {
        seed: 1,
        failOnNeverActed: true,
      });

      expect(actedOf(run, "swap")).toBe(run.msgCounts.get("swap")?.drawn);
    });

    it("counts an equal rebuild around a shared Date as not acting", () => {
      const at = new Date(0);
      const machine = rebuilding({ at }, { at });

      const failure = failureOf(() =>
        propertyTrace(machine, {}, swaps, () => true, {
          seed: 1,
          failOnNeverActed: true,
        }),
      );

      expect(failure.message).toContain("1 Msg type(s) never acted");
      expect(actedOf(failure.run, "swap")).toBe(0);
    });

    it("stops at the difference ahead of it, since that step acted", () => {
      const machine = rebuilding(
        { n: 0, at: new Date(0) },
        { n: 1, at: new Date(0) },
      );

      const run = propertyTrace(machine, {}, swaps, () => true, {
        seed: 1,
        failOnNeverActed: true,
      });

      expect(actedOf(run, "swap")).toBe(run.msgCounts.get("swap")?.drawn);
    });
  });
});

/** Whether one step counts as acting, read from the tally the runners fill. */
const actedOnStep = (prev: unknown, next: unknown): boolean => {
  const tally = new MsgTally(["step"]);
  tally.add([{ prev, msg: { type: "step" }, next, cmds: [] }]);
  expect(tally.refusal).toBeNull();
  return tally.counts.get("step")?.acted === 1;
};

describe("a step's comparison against structuralHash", () => {
  const nullProto = (fields: object): object =>
    Object.assign(Object.create(null), fields);
  const holeAtZero = (): unknown[] => {
    const list: unknown[] = [];
    list[1] = 1;
    return list;
  };

  it.each<readonly [string, unknown, unknown]>([
    [
      "different key order",
      { a: 1, b: { c: 2, d: 3 } },
      { b: { d: 3, c: 2 }, a: 1 },
    ],
    ["undefined against an absent key", { a: 1, b: undefined }, { a: 1 }],
    ["an absent key against undefined", { a: 1 }, { a: 1, b: undefined }],
    ["undefined against null", { a: undefined }, { a: null }],
    ["an absent key against null", {}, { a: null }],
    ["NaN against NaN", { a: Number.NaN }, { a: Number.NaN }],
    ["NaN against its spelling", { a: Number.NaN }, { a: "NaN" }],
    ["0 against -0", { a: 0 }, { a: -0 }],
    ["a rebuilt list, equal", { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }],
    ["a rebuilt list, reordered", { a: [1, 2] }, { a: [2, 1] }],
    ["a list against a longer one", { a: [1] }, { a: [1, 2] }],
    ["a list against a record", { a: [] }, { a: {} }],
    ["a number against its spelling", { a: 1 }, { a: "1" }],
    ["null against its spelling", { a: null }, { a: "null" }],
    ["a bracket against a list", { a: "[" }, { a: [] }],
    ["undefined in a list against null", [undefined], [null]],
    ["a hole against undefined", holeAtZero(), [undefined, 1]],
    ["a hole against a hole", holeAtZero(), holeAtZero()],
    ["one hole against an empty list", new Array(1), []],
    ["a null-prototype record", nullProto({ a: 1 }), { a: 1 }],
    ["a key named like an inherited one", { constructor: 1 }, {}],
    ["toString held by one side", {}, { toString: undefined }],
    [
      "a non-enumerable field",
      Object.defineProperty({}, "a", { value: 1 }),
      {},
    ],
  ])("agrees on %s", (_name, prev, next) => {
    const changed = structuralHash(next) !== structuralHash(prev);

    expect(actedOnStep(prev, next)).toBe(changed);
    expect(actedOnStep(next, prev)).toBe(changed);
  });

  // A small pool of keys and leaves, so two states drawn apart often come out equal.
  const plainData = fc.anything({
    key: fc.constantFrom("a", "b", "__proto__", "toString"),
    values: [
      fc.constantFrom<unknown>(
        0,
        -0,
        1,
        "1",
        "",
        "[",
        Number.NaN,
        true,
        null,
        undefined,
      ),
    ],
    maxDepth: 2,
    maxKeys: 3,
    withNullPrototype: true,
    withSparseArray: true,
  });

  /** The same data with every record's keys set in the opposite order. */
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const copy: unknown[] = new Array(value.length);
      for (const i of value.keys())
        if (i in value) copy[i] = reversed(value[i]);
      return copy;
    }
    if (typeof value !== "object" || value === null) return value;
    const copy = Object.create(Object.getPrototypeOf(value)) as object;
    for (const key of Object.keys(value).reverse()) {
      Object.defineProperty(copy, key, {
        value: reversed((value as Record<string, unknown>)[key]),
        enumerable: true,
      });
    }
    return copy;
  };

  const agrees = (prev: unknown, next: unknown): void => {
    const changed = structuralHash(next) !== structuralHash(prev);
    expect(actedOnStep(prev, next)).toBe(changed);
  };

  it("agrees on any two plain-data states", () => {
    let same = 0;
    let different = 0;
    fc.assert(
      fc.property(plainData, plainData, (prev, next) => {
        if (structuralHash(next) === structuralHash(prev)) same += 1;
        else different += 1;
        agrees(prev, next);
      }),
      { seed: 20261101, numRuns: 2000 },
    );

    // The check means little unless both answers came up often.
    expect(same).toBeGreaterThan(10);
    expect(different).toBeGreaterThan(100);
  });

  it("agrees on a state and its own rebuild, whatever the key order", () => {
    fc.assert(
      fc.property(plainData, (state) => {
        const rebuilt = reversed(state);
        expect(structuralHash(rebuilt)).toBe(structuralHash(state));
        agrees(state, rebuilt);
      }),
      { seed: 20261101, numRuns: 500 },
    );
  });

  it("agrees on a state and a one-field change deep inside it", () => {
    fc.assert(
      fc.property(plainData, plainData, (head, tail) => {
        agrees({ head, list: [tail, 1] }, { head, list: [tail, 2] });
        agrees({ list: [tail, 1], head }, { list: [reversed(tail), 1], head });
      }),
      { seed: 20261101, numRuns: 500 },
    );
  });
});

describe("a step that shares a list with its prev", () => {
  /** A list whose items count every field read through their accessors. */
  const countedList = (length: number) => {
    let reads = 0;
    const items = Array.from({ length }, (_, id) => ({
      get id() {
        reads += 1;
        return id;
      },
    }));
    return { items, reads: () => reads };
  };

  type Held = {
    readonly n: number;
    readonly items: readonly { readonly id: number }[];
  };
  type HeldMsg = { readonly type: "bump" } | { readonly type: "copy" };
  const holding = (loaded: Held) =>
    defineMachine({
      types: {
        model: {} as Held,
        msg: {} as HeldMsg,
        ctx: {} as Record<string, never>,
      },
      init: () => [loaded, []],
      update: {
        bump: (s: Held) => [{ ...s, n: s.n + 1 }, []],
        copy: (s: Held) => [{ ...s }, []],
      },
    });
  const heldMsgs = arbMsgSequence(
    fc.constantFrom<HeldMsg>({ type: "bump" }, { type: "copy" }),
    { size: "max", maxLength: 60 },
  );

  it("reads none of its items, with failOnNeverActed on or off", () => {
    const { items, reads } = countedList(100);
    const machine = holding({ n: 0, items });

    const off = propertyTrace(machine, {}, heldMsgs, () => true, { seed: 1 });
    expect(reads()).toBe(0);
    // `copy` never acts, so the option fails this run, having compared every step.
    const on = failureOf(() =>
      propertyTrace(machine, {}, heldMsgs, () => true, {
        seed: 1,
        failOnNeverActed: true,
      }),
    );
    expect(on.message).toContain("1 Msg type(s) never acted");
    expect(reads()).toBe(0);

    expect(off.msgCounts.get("copy")?.drawn).toBeGreaterThan(0);
    expect(off.msgCounts.get("copy")?.acted).toBe(0);
    expect(on.run.msgCounts).toEqual(off.msgCounts);
  });

  it("reads its items once they stop being shared, so the count can move", () => {
    const before = countedList(3);
    const after = countedList(3);

    expect(actedOnStep({ items: before.items }, { items: after.items })).toBe(
      false,
    );
    expect(before.reads()).toBe(3);
    expect(after.reads()).toBe(3);
  });
});

describe("a property on a large state", () => {
  type Item = {
    readonly id: number;
    readonly name: string;
    readonly done: boolean;
    readonly tags: readonly string[];
  };
  type Big = {
    readonly n: number;
    readonly flag: boolean;
    readonly items: readonly Item[];
  };
  type BigMsg = {
    readonly type: "bump" | "flip" | "a" | "b" | "c" | "d";
  };
  type Ping = { readonly type: "ping" };

  const itemsOf = (count: number): readonly Item[] =>
    Array.from({ length: count }, (_, id) => ({
      id,
      name: `item-${id}`,
      done: id % 2 === 0,
      tags: ["x", "y"],
    }));

  /** Two of six Msg types return a new object sharing the list. `others` is the rest. */
  const big = (
    items: readonly Item[],
    others: (s: Big) => readonly [Big, Ping[]],
  ) =>
    defineMachine({
      types: {
        model: {} as Big,
        msg: {} as BigMsg,
        cmd: {} as Ping,
        ctx: {} as Record<string, never>,
      },
      init: () => [{ n: 0, flag: false, items }, []],
      update: {
        bump: (s: Big) => [{ ...s, n: s.n + 1 }, []],
        flip: (s: Big) => [{ ...s, flag: !s.flag }, []],
        a: others,
        b: others,
        c: others,
        d: others,
      },
    });

  const quiet = (s: Big): readonly [Big, Ping[]] => [s, []];
  const pinging = (s: Big): readonly [Big, Ping[]] => [s, [{ type: "ping" }]];

  const lists = arbMsgSequence(
    fc.constantFrom<BigMsg>(
      { type: "bump" },
      { type: "flip" },
      { type: "a" },
      { type: "b" },
      { type: "c" },
      { type: "d" },
    ),
    { size: "max", maxLength: 300 },
  );

  /**
   * Run the fixture on 5000 items, timing the runner. The machine never reads its
   * items, so the counts are worked out from the same lists over 5: hashing every
   * step of 5000 is the very cost this test exists to rule out.
   */
  const timed = (
    others: (s: Big) => readonly [Big, Ping[]],
    failOnNeverActed: boolean,
  ) => {
    const seen: (readonly BigMsg[])[] = [];
    const startedAt = performance.now();
    let run: PropertyRun;
    try {
      run = propertyTrace(
        big(itemsOf(5000), others),
        {},
        lists,
        (steps) => {
          seen.push(steps.map((step) => step.msg));
          return true;
        },
        { seed: 1, numRuns: 200, failOnNeverActed },
      );
    } catch (error) {
      if (!(error instanceof PropertyFailure)) throw error;
      run = error.run;
    }
    const elapsed = performance.now() - startedAt;

    const small = big(itemsOf(5), others);
    const expected = new Map<string, { drawn: number; acted: number }>(
      ["bump", "flip", "a", "b", "c", "d"].map((type) => [
        type,
        { drawn: 0, acted: 0 },
      ]),
    );
    for (const msgs of seen) {
      for (const step of foldEvents(small, {}, null, msgs).steps) {
        const count = expected.get(step.msg.type);
        if (!count) throw new Error(`unknown type ${step.msg.type}`);
        count.drawn += 1;
        const changed = structuralHash(step.next) !== structuralHash(step.prev);
        if (changed || step.cmds.length > 0) count.acted += 1;
      }
    }
    return { run, elapsed, expected };
  };

  it.each([
    ["off", quiet, false],
    ["on, and the four quiet types fail it", quiet, true],
    ["on, and every type acts", pinging, true],
  ] as const)("finishes in under 1 s with failOnNeverActed %s", (_name, others, on) => {
    const { run, elapsed, expected } = timed(others, on);

    expect(run.numRuns).toBe(200);
    expect(run.msgCounts).toEqual(expected);
    expect(run.msgCounts.get("bump")?.acted).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it("gives the 5000-item counts that hashing those 5000 items gives", () => {
    const items = itemsOf(5000);
    const machine = big(items, quiet);
    const msgs = Array.from(
      { length: 60 },
      (_, i): BigMsg => ({
        type: (["bump", "flip", "a", "b", "c", "d"] as const)[i % 6] ?? "a",
      }),
    );
    const { steps } = foldEvents(machine, {}, null, msgs);

    for (const step of steps) {
      const changed = structuralHash(step.next) !== structuralHash(step.prev);
      expect(actedOnStep(step.prev, step.next)).toBe(changed);
    }
  });
});
