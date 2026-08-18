// ═══════════════════════════════════════════════════════════════════════════
// THE LANE'S MODEL — the facts `structure.ts` and the fold owe each other.
//
// `lane.test.ts` covers the shape a lane reads back as and `equiv-lane-run.ts`
// walks a run against a fold; this file holds the cases where the two USED to
// disagree, plus the derivations `laneShape` performs that nothing else looks
// at. Every test here fails without the fix beside it — several of them were
// written as reproductions first and only then as tests.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import {
  type Assigns,
  defineChart,
  type MsgOf,
  type StateOf,
  ty,
} from "../graph";
import {
  foldLane,
  initialStates,
  type LogEntry,
  stepTask,
  timeline,
  UnreplayableLogError,
} from "../report/fold";
import {
  type ImportedChart,
  type ImportedLane,
  RETRY_BUDGET,
  statesOf,
} from "../report/workflow";
import { type LaneHands, runLane } from "./run";
import {
  defineLane,
  type LaneShapeError,
  laneShape,
  LaneShapeError as ShapeError,
} from "./structure";

// ── the region the refusal cases are driven through ────────────────────────
//
// `PARK` is broadcast to the `working` phase and `RESUME` to the `parked` one,
// which is the ONE thing a lane region can say that makes an event refusable:
// the state accepts it and drops it, because it is addressed to somewhere else.
const worker = defineChart({
  ctx: ty<{ readonly retries: number; readonly maxRetries: number }>(),
  events: {
    GO: { scope: "edges" },
    PARK: { scope: "working" },
    RESUME: { scope: "parked" },
  },
  states: {
    working: {
      queued: { initial: true, on: { GO: "shipped", PARK: "parked_at" } },
      shipped: { end: true },
    },
    parked: { parked_at: { on: { RESUME: "queued" } } },
  },
});
type W = typeof worker;

const ctx = (s: StateOf<W>) => ({
  retries: s.retries,
  maxRetries: s.maxRetries,
});
const parts = {
  assign: {
    "queued.GO": ctx,
    "queued.PARK": ctx,
    "parked_at.RESUME": ctx,
  } as Assigns<W, StateOf<W>, MsgOf<W>>,
};

const lane = defineLane({
  id: "epic-model",
  phases: { p1: { issue_1: worker } },
  terminals: { complete: "complete", tripped: "tripped" },
});

const hands = {
  issue_1: {
    parts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
  },
} satisfies LaneHands<typeof lane>;

// ═══════════════════════════════════════════════════════════════════════════
describe("a refusal is a THIRD answer, and both sides give it", () => {
  // `RESUME` is broadcast to `parked` and `queued` lives in `working`, so a
  // `RESUME` arriving at `queued` is accepted and dropped by the runtime. The
  // fold used to throw `UnreplayableLogError` on exactly that log — a report
  // calling a run unreplayable when the run had replayed it.
  const refused: readonly LogEntry[] = [
    { task: "issue_1", event: "issue_1.RESUME", at: "t0" },
  ];

  it("the RUN leaves the state alone", () => {
    const rt = runLane(lane, hands);
    const [booted] = rt.init(null);
    const cell = rt.update["issue_1.RESUME"];
    const [after] = cell(booted, { type: "issue_1.RESUME" } as never);
    expect(after.regions.issue_1.type).toBe("queued");
  });

  it("and so does the FOLD, where it used to refuse the log", () => {
    expect(foldLane(lane, refused).issue_1?.type).toBe("queued");
  });

  it("the refusal set is carried on the chart, per state", () => {
    // `queued` refuses `RESUME` (broadcast elsewhere) and nothing else: `GO` is
    // routed, and `PARK` is broadcast to `queued`'s OWN phase, so it is live
    // there and its absence would be an unhandled pair rather than a refusal.
    expect(lane.charts.issue_1?.refusals).toEqual({
      queued: ["RESUME"],
      shipped: ["PARK", "RESUME"],
      parked_at: ["PARK"],
    });
  });

  it("still refuses a pair that is neither routed nor refused", () => {
    // `GO` at `parked_at` is an `"edges"` event the state does not route: not
    // ignored, not broadcast elsewhere — simply not addressed there. That is
    // the case that stays loud, and the diagnostic now NAMES THE TASK, which is
    // the whole difference between a usable message and a twelve-task hunt.
    const parked = foldLane(lane, [
      { task: "issue_1", event: "issue_1.PARK", at: "t0" },
    ]);
    expect(parked.issue_1?.type).toBe("parked_at");
    expect(() =>
      foldLane(lane, [
        { task: "issue_1", event: "issue_1.PARK", at: "t0" },
        { task: "issue_1", event: "issue_1.GO", at: "t1" },
      ]),
    ).toThrow(/task "issue_1": state "parked_at" holds no cell for "GO"/);
  });

  it("is a NO-OP at the imported door — no `refusals`, and still loud", () => {
    // An imported chart's events are `scope: "edges"` by construction, so the
    // rule cannot fire on one: `chartFromWorkflow` writes no refusals, lowering
    // an imported chart is still the identity, and a `workflow.json` log naming
    // an unrouted event is refused exactly as fabrika's own fold refuses it.
    const imported: ImportedChart = {
      events: { GO: { scope: "edges" }, NOPE: { scope: "edges" } },
      states: {
        only: {
          queued: { initial: true, on: { GO: { target: "shipped" } } },
          shipped: { end: true },
        },
      },
    };
    const roundTripped = defineLane({
      phases: { p1: { t: imported } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    expect(roundTripped.charts.t).toEqual(imported);
    expect(roundTripped.charts.t?.refusals).toBeUndefined();
    expect(() =>
      foldLane(roundTripped, [{ task: "t", event: "NOPE", at: "t0" }]),
    ).toThrow(UnreplayableLogError);
  });

  it("`stepTask` still names no task when it is not told one", () => {
    const chart = lane.charts.issue_1;
    if (chart === undefined) throw new Error("the lane lost `issue_1`");
    expect(() =>
      stepTask(chart, { type: "shipped", retries: 0, maxRetries: 2 }, "GO"),
    ).toThrow(/^(?!.*task ").*state "shipped" holds no cell for "GO"/s);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a fold names EVERY task the log invented, not the first", () => {
  const log: readonly LogEntry[] = [
    { task: "ghost_1", event: "GO", at: "t0" },
    { task: "ghost_2", event: "GO", at: "t1" },
    { task: "ghost_1", event: "GO", at: "t2" },
  ];

  it("collects them, deduplicated, in first-mention order", () => {
    for (const read of [foldLane, timeline]) {
      try {
        read(lane, log);
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(UnreplayableLogError);
        expect((error as UnreplayableLogError).defects).toEqual([
          'log names task "ghost_1", which is not in this lane\'s machine',
          'log names task "ghost_2", which is not in this lane\'s machine',
        ]);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("one zero per region — zero and two are both wrong", () => {
  it("refuses a chart marking two states `initial: true`", () => {
    // The type layer refuses this too (`e65`); this is the net at the imported
    // door, where the marker cannot be asked.
    const forked: ImportedChart = {
      events: { GO: { scope: "edges" } },
      states: {
        only: {
          a: { initial: true, on: { GO: { target: "done" } } },
          b: { initial: true, on: { GO: { target: "done" } } },
          done: { end: true },
        },
      },
    };
    try {
      defineLane({
        phases: { p1: { t: forked } },
        terminals: { complete: "complete", tripped: "tripped" },
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ShapeError);
      expect((error as LaneShapeError).defects).toEqual([
        'task "t": its chart marks 2 states `initial: true` — a fold has one zero, and which one it picks would be an accident of key order',
      ]);
    }
  });

  it("`laneShape` reads the FIRST initial, as the fold does", () => {
    // Not reachable through `defineLane` any more, so it is built by hand: the
    // two readers must agree even on a lane assembled somewhere else.
    const twoZeros: ImportedLane = {
      phases: [{ name: "p1", tasks: ["t"] }],
      terminals: { complete: "complete", tripped: "tripped" },
      context: {},
      charts: {
        t: {
          events: { GO: { scope: "edges" } },
          states: {
            only: {
              first: { initial: true, on: { GO: { target: "done" } } },
              second: { initial: true, on: { GO: { target: "done" } } },
              done: { end: true },
            },
          },
        },
      },
    };
    expect(laneShape(twoZeros).tasks[0]?.initial).toBe("first");
    expect(initialStates(twoZeros).t?.type).toBe("first");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fabrika's task ids ARE GitHub issue numbers, so `{ 5729: coder }` is the
// obvious spelling. It used to compile clean and annihilate the lane: every
// alphabet went `never`, no hand was demanded, and the CORRECT hand was
// rejected with `'5729' does not exist in type LaneHandsOf<…>`.
const numbered = defineLane({
  phases: { 1: { 5729: worker, 5730: worker } },
  terminals: { complete: "complete", tripped: "tripped" },
  retries: { 5729: 5 },
});

describe("a NUMERIC task id is a task id", () => {
  it("keeps the alphabet, and the phase keeps its tasks", () => {
    expect(laneShape(numbered).tasks.map((t) => t.id)).toEqual([
      "5729",
      "5730",
    ]);
    expect(laneShape(numbered).phases[0]?.name).toBe("1");
  });

  it("demands the hand under the id the author wrote", () => {
    const numberedHands = {
      "5729": {
        parts,
        boot: () => ({ type: "queued", retries: 0, maxRetries: 5 }),
      },
      "5730": {
        parts,
        boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
      },
    } satisfies LaneHands<typeof numbered>;
    const rt = runLane(numbered, numberedHands);
    const [booted] = rt.init(null);
    expect(Object.keys(booted.regions)).toEqual(["5729", "5730"]);
  });

  it("carries the retry budget keyed the same way", () => {
    expect(laneShape(numbered).tasks[0]?.maxRetries).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("one fact, one place — the retry budget", () => {
  it("`defineLane`'s default IS the importer's exported one", () => {
    // Two copies of this number had already drifted once. The assertion is not
    // "it is 2" — that would pin the copy — it is "the lane's default is the
    // constant the importer exports", which fails the moment they part.
    const bare = defineLane({
      phases: { p1: { issue_1: worker } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    expect(bare.context.issue_1?.maxRetries).toBe(RETRY_BUDGET);
    expect(laneShape(bare).tasks[0]?.maxRetries).toBe(RETRY_BUDGET);
  });

  it("`laneShape` reads the budget OFF the lane, not off the default", () => {
    const budgeted = defineLane({
      phases: { p1: { issue_1: worker } },
      terminals: { complete: "complete", tripped: "tripped" },
      retries: { issue_1: 9 },
    });
    expect(laneShape(budgeted).tasks[0]?.maxRetries).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("laneShape — the derivations nothing else reads back", () => {
  it("carries the lane's own id and trigger", () => {
    const titled = defineLane({
      id: "epic-5728",
      trigger: "an issue moved",
      phases: { p1: { issue_1: worker } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    const shape = laneShape(titled);
    expect(shape.id).toBe("epic-5728");
    expect(shape.trigger).toBe("an issue moved");
  });

  it("names the tasks that CANNOT trip — a lane fact, not a defect", () => {
    // `worker` declares `end: true` and no `end: "error"`, so no run of it can
    // reach the `tripped` terminal. Invisible otherwise, and it changes what
    // the lane can do.
    expect(laneShape(lane).cannotTrip).toEqual(["issue_1"]);
    const canTrip = defineChart({
      ctx: ty<{ readonly retries: number; readonly maxRetries: number }>(),
      events: { GO: { scope: "edges" } },
      states: {
        only: {
          queued: { initial: true, on: { GO: "frozen" } },
          frozen: { end: "error" },
        },
      },
    });
    const trippable = defineLane({
      phases: { p1: { issue_1: canTrip } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    expect(laneShape(trippable).cannotTrip).toEqual([]);
  });

  it("carries the authored `extras` through untouched", () => {
    const withExtras = defineLane({
      phases: { p1: { issue_1: worker } },
      terminals: { complete: "complete", tripped: "tripped" },
      extras: { issue_1: { repo: "kamp-us/demlik", pr: 6 } },
    });
    expect(withExtras.context.issue_1?.extras).toEqual({
      repo: "kamp-us/demlik",
      pr: 6,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the lowering refuses what a lane cannot hold", () => {
  it("refuses a lane with no phase at all", () => {
    expect(() =>
      defineLane({
        phases: {},
        terminals: { complete: "complete", tripped: "tripped" },
      }),
    ).toThrow(/the lane declares no phase/);
  });

  // THE IMPORTED DOOR'S HALF of `e51`. The typed door refuses a cell edge with
  // a marker; a region handed in as a value has no marker to refuse it, and the
  // runtime path that produces the defect had never been walked by a test.
  it("refuses a cell edge handed in as a value, naming the site", () => {
    const picky = {
      events: { GO: { scope: "edges" } },
      states: {
        only: {
          queued: {
            initial: true,
            on: { GO: { to: ["build"], cell: "pick" } },
          },
          build: { end: true },
        },
      },
    };
    expect(() =>
      defineLane({
        phases: { p1: { t: picky } },
        terminals: { complete: "complete", tripped: "tripped" },
      } as never),
    ).toThrow(
      /task "t": "queued.GO" delegates its target to a cell — a lane region routes to targets it DECLARES/,
    );
  });

  it("refuses a state that is not an object", () => {
    expect(() =>
      defineLane({
        phases: { p1: { t: { events: {}, states: { only: { queued: 7 } } } } },
        terminals: { complete: "complete", tripped: "tripped" },
      } as never),
    ).toThrow(/task "t": state "queued" is not an object/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the lowering keeps what the fold reads", () => {
  it("puts every state in the group its chart declared", () => {
    const chart = lane.charts.issue_1;
    if (chart === undefined) throw new Error("the lane lost `issue_1`");
    expect(Object.keys(chart.states)).toEqual(["working", "parked"]);
    expect([...statesOf(chart).keys()]).toEqual([
      "queued",
      "shipped",
      "parked_at",
    ]);
  });
});
