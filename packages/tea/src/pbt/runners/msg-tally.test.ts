import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, type Reducer, structuralHash } from "../../index";
import { arbMsg, arbMsgSequence } from "../arbitraries";
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
    update: { tick: (s: Dated) => [{ at: s.at }, []] },
  });
  const ticks = arbMsgSequence(fc.constant<Tick>({ type: "tick" }), {
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
});
