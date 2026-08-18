// ═══════════════════════════════════════════════════════════════════════════
// THE RUNTIME'S DOORS — the checks `run.test.ts` drives the HAPPY path through,
// asked the other way round.
//
// Every test here was written against a mutation: delete the line it names and
// this file goes red, which is the only property that makes a refusal real.
// `run.test.ts` drives a lane that works; this one drives the lanes a host
// actually restarts with — a persisted state written by an older build, a boot
// whose retry budget disagrees with the lane's, a task id with a dot in it —
// and the two walls a lane between two parking states can fall off.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { defineChart, ty } from "../graph";
import { foldLane, type LogEntry, type TaskState } from "../report/fold";
import type { ImportedChart } from "../report/workflow";
import { coderParts, epic } from "./__fixtures__/epic-run";
import { type LaneHands, type LaneRunState, runLane } from "./run";
import { defineLane, LaneShapeError } from "./structure";

type Run = LaneRunState<typeof epic>;
type AnyMsg = { readonly type: string; readonly at?: number };
type Leaf = { readonly type: string; readonly was?: string } & Readonly<
  Record<string, unknown>
>;
type Cells = Readonly<
  Record<
    string,
    | ((
        s: {
          readonly regions: Readonly<Record<string, Leaf>>;
          readonly lane: string;
        },
        m: AnyMsg,
      ) => readonly [
        {
          readonly regions: Readonly<Record<string, Leaf>>;
          readonly lane: string;
        },
        readonly { readonly type: string }[],
      ])
    | undefined
  >
>;

/** The string-keyed view of `update` the loops need — `run.test.ts`'s. */
const cells = (rt: { readonly update: object }): Cells =>
  rt.update as unknown as Cells;

const freshHands = {
  issue_1: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
  },
  issue_2: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
  },
  issue_3: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 5 }),
  },
} satisfies LaneHands<typeof epic>;

// ═══════════════════════════════════════════════════════════════════════════
// THE RETRY BUDGET — one fact, one place.
// ═══════════════════════════════════════════════════════════════════════════

describe("runLane — the retry budget", () => {
  it("refuses a boot whose budget contradicts the lane's, naming both", () => {
    // `epic` declares `retries: { issue_3: 5 }` and nothing for `issue_1`, so
    // `issue_1`'s budget is the default 2 — the number `foldLane` will use when
    // this run's log is replayed. A hand booting it at 0 is a run that freezes
    // where the report says it retried.
    const rt = runLane(epic, {
      ...freshHands,
      issue_1: {
        parts: coderParts,
        boot: () => ({ type: "queued", retries: 0, maxRetries: 0 }),
      },
    });
    expect(() => rt.init(null)).toThrow(LaneShapeError);
    expect(() => rt.init(null)).toThrow(/issue_1[\s\S]*0[\s\S]*2/);
  });

  it("takes the budget the lane declares, so the run and the fold freeze together", () => {
    const strict = defineLane({
      id: "strict",
      phases: { phase1: { issue_1: epic.spec.phases.phase1.issue_1 } },
      terminals: { complete: "complete", tripped: "tripped" },
      retries: { issue_1: 0 },
    });
    const rt = runLane(strict, {
      issue_1: {
        parts: coderParts,
        boot: () => ({ type: "queued", retries: 0, maxRetries: 0 }),
      },
    });
    const walk: readonly string[] = ["WIP", "DONE", "FAIL"];
    let state = rt.init(null)[0] as unknown as {
      readonly regions: Readonly<Record<string, Leaf>>;
      readonly lane: string;
    };
    const log: LogEntry[] = [];
    for (const [index, event] of walk.entries()) {
      const cell = cells(rt)[`issue_1.${event}`];
      if (cell === undefined) throw new Error(`no cell for ${event}`);
      [state] = cell(state, {
        type: `issue_1.${event}`,
        at: index,
        reason: "flaky",
      } as AnyMsg);
      log.push({ task: "issue_1", event: `issue_1.${event}`, at: `t${index}` });
    }
    const folded = foldLane(strict, log);
    expect(state.regions.issue_1?.type).toBe("frozen");
    expect(folded.issue_1?.type).toBe("frozen");
    expect(state.lane).toBe("tripped");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REHYDRATION — the branch that runs on every production restart.
// ═══════════════════════════════════════════════════════════════════════════

const midRun = (): Run => {
  const rt = runLane(epic, freshHands);
  let state = rt.init(null)[0];
  for (const [index, key] of ["issue_1.WIP", "issue_1.BLOCKED"].entries()) {
    const cell = cells(rt)[key];
    if (cell === undefined) throw new Error(`no cell for ${key}`);
    [state] = cell(
      state as never,
      {
        type: key,
        at: index,
        reason: "waiting on the operator",
      } as AnyMsg,
    ) as unknown as [Run, unknown];
  }
  return state;
};

/** A persisted state, as a host hands one back: leaves and a standing. */
const persisted = (
  regions: Readonly<Record<string, Leaf>>,
  lane = "running",
): LaneRunState<typeof epic> =>
  ({ regions, lane }) as unknown as LaneRunState<typeof epic>;

describe("runLane — rehydration", () => {
  it("returns a NON-boot state's leaves verbatim", () => {
    // Deliberately not the state a cold boot produces: `issue_1` is parked, so
    // deleting `init`'s rehydration branch lands `queued` here and this fails.
    const loaded = midRun();
    expect(loaded.regions.issue_1.type).toBe("blocked");
    const rt = runLane(epic, freshHands);
    const [rehydrated, cmds] = rt.init(loaded);
    expect(rehydrated.regions).toEqual(loaded.regions);
    expect(cmds).toEqual([]);
    // and it is LIVE where it was persisted: `blocked` routes `UNBLOCKED` back
    // to the `build` it was parked from.
    const [next] = rt.update["issue_1.UNBLOCKED"](rehydrated, {
      type: "issue_1.UNBLOCKED",
      at: 9,
    });
    expect(next.regions.issue_1.type).toBe("build");
  });

  it("re-derives the lane's standing rather than trusting the persisted one", () => {
    const rt = runLane(epic, freshHands);
    const loaded = persisted(
      {
        issue_1: { type: "shipped", retries: 0, maxRetries: 2 },
        issue_2: { type: "shipped", retries: 0, maxRetries: 2 },
        issue_3: { type: "shipped", retries: 0, maxRetries: 5 },
      },
      // a stale standing — every region is final, so the lane is `complete`.
      "running",
    );
    expect(rt.init(loaded)[0].lane).toBe("complete");
  });

  it("refuses a persisted state missing a task the lane has since gained", () => {
    const rt = runLane(epic, freshHands);
    const loaded = persisted({
      issue_1: { type: "queued", retries: 0, maxRetries: 2 },
      issue_2: { type: "queued", retries: 0, maxRetries: 2 },
    });
    expect(() => rt.init(loaded)).toThrow(LaneShapeError);
    expect(() => rt.init(loaded)).toThrow(/issue_3/);
  });

  it("refuses a persisted state naming a task the lane does not have", () => {
    const rt = runLane(epic, freshHands);
    const loaded = persisted({
      issue_1: { type: "queued", retries: 0, maxRetries: 2 },
      issue_2: { type: "queued", retries: 0, maxRetries: 2 },
      issue_3: { type: "queued", retries: 0, maxRetries: 5 },
      issue_4: { type: "queued", retries: 0, maxRetries: 2 },
    });
    expect(() => rt.init(loaded)).toThrow(/issue_4/);
  });

  it("refuses a persisted leaf standing in a state its chart does not declare", () => {
    const rt = runLane(epic, freshHands);
    const loaded = persisted({
      issue_1: { type: "landed", retries: 0, maxRetries: 2 },
      issue_2: { type: "queued", retries: 0, maxRetries: 2 },
      issue_3: { type: "queued", retries: 0, maxRetries: 5 },
    });
    expect(() => rt.init(loaded)).toThrow(/issue_1[\s\S]*landed/);
  });

  it("refuses a persisted leaf whose `was` is not a state of its chart", () => {
    const rt = runLane(epic, freshHands);
    const loaded = persisted({
      issue_1: { type: "blocked", was: "landed", retries: 0, maxRetries: 2 },
      issue_2: { type: "queued", retries: 0, maxRetries: 2 },
      issue_3: { type: "queued", retries: 0, maxRetries: 5 },
    });
    expect(() => rt.init(loaded)).toThrow(/issue_1[\s\S]*was[\s\S]*landed/);
  });

  it("refuses a persisted budget that contradicts the lane's", () => {
    const rt = runLane(epic, freshHands);
    const loaded = persisted({
      issue_1: { type: "queued", retries: 0, maxRetries: 2 },
      issue_2: { type: "queued", retries: 0, maxRetries: 2 },
      issue_3: { type: "queued", retries: 0, maxRetries: 2 },
    });
    expect(() => rt.init(loaded)).toThrow(/issue_3[\s\S]*2[\s\S]*5/);
  });
});

describe("runLane — boot", () => {
  it("refuses a boot whose `was` is not a state of its chart", () => {
    // The typed door refuses this in `StateOf`; the imported door — the one the
    // real consumer walks — has no alphabet to refuse it with, so `init` is the
    // only net there is, and it checked `type` and not `was`.
    const doc: ImportedChart = {
      events: { GO: { scope: "edges" }, HOLD: { scope: "edges" } },
      states: {
        only: {
          queued: { initial: true, on: { HOLD: { target: "held" } } },
          held: { on: { GO: { resume: { fallback: "queued" } } } },
          shipped: { end: true },
        },
      },
    };
    const imported = defineLane({
      phases: { p1: { t1: doc } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    const rt = runLane(imported, {
      t1: {
        parts: { assign: { "queued.HOLD": () => ({}), "held.GO": () => ({}) } },
        boot: () => ({ type: "held", was: "landed" }),
      },
    });
    expect(() => rt.init(null)).toThrow(LaneShapeError);
    expect(() => rt.init(null)).toThrow(/t1[\s\S]*was[\s\S]*landed/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// `was` ON A RESUME — the fold does not rewrite it, and neither may the run.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A region with TWO parking states, mutually reachable.
 *
 * fabrika's region has exactly one, which is why this never bit: with one
 * parking state a resume can only land somewhere unparked, and re-injecting
 * `was` on arrival changes a field nobody reads again. With two, a resume lands
 * ON a parking state — the compiled cell overwrites `was` with the park you
 * just left, the fold leaves it alone, and the NEXT resume walks to two
 * different states.
 */
const twoParks: ImportedChart = {
  events: {
    HOLD: { scope: "edges" },
    SWAP: { scope: "edges" },
    GO: { scope: "edges" },
    DONE: { scope: "edges" },
  },
  states: {
    only: {
      work: {
        initial: true,
        on: { HOLD: { target: "hold_a" }, DONE: { target: "shipped" } },
      },
      hold_a: {
        on: {
          SWAP: { target: "hold_b" },
          GO: { resume: { fallback: "work" } },
        },
      },
      hold_b: { on: { GO: { resume: { fallback: "work" } } } },
      shipped: { end: true },
    },
  },
};

describe("runLane — a resume between two parking states", () => {
  it("leaves `was` where the fold leaves it, so the two land on one state", () => {
    const lane = defineLane({
      phases: { p1: { t1: twoParks } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    const rt = runLane(lane, {
      t1: {
        parts: {
          assign: {
            "work.HOLD": () => ({}),
            "work.DONE": () => ({}),
            "hold_a.SWAP": () => ({}),
            "hold_a.GO": () => ({}),
            "hold_b.GO": () => ({}),
          },
        },
        boot: () => ({ type: "work" }),
      },
    });
    let state = rt.init(null)[0] as unknown as {
      readonly regions: Readonly<Record<string, Leaf>>;
    };
    let folded: Readonly<Record<string, TaskState>> = { ...{} };
    const log: LogEntry[] = [];
    // park, hop to the other park, resume, resume again.
    for (const [index, event] of ["HOLD", "SWAP", "GO", "GO"].entries()) {
      const cell = cells(rt)[`t1.${event}`];
      if (cell === undefined) throw new Error(`no cell for ${event}`);
      [state] = cell(state as never, { type: `t1.${event}`, at: index });
      log.push({ task: "t1", event: `t1.${event}`, at: `t${index}` });
      folded = foldLane(lane, log);
      expect([event, state.regions.t1?.type, state.regions.t1?.was]).toEqual([
        event,
        folded.t1?.type,
        folded.t1?.was,
      ]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CMD TAG — the lane's namespace, beside the payload rather than over it.
// ═══════════════════════════════════════════════════════════════════════════

const notifier = defineChart({
  cmds: { notify: ty<{ readonly task: string }>() },
  events: { GO: { data: ty<{ readonly at: number }>(), scope: "edges" } },
  states: {
    only: {
      queued: {
        initial: true,
        on: { GO: { target: "shipped", cmd: "notify" } },
      },
      shipped: { end: true },
    },
  },
});

describe("runLane — the cmd tag", () => {
  it("does not destroy a payload field the chart named `task`", () => {
    const lane = defineLane({
      phases: { p1: { t1: notifier } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    const rt = runLane(lane, {
      t1: {
        parts: {
          assign: { "queued.GO": () => ({}) },
          cmds: { notify: () => ({ task: "the author's own field" }) },
        },
        boot: () => ({ type: "queued" }) as const,
      },
    });
    const [booted] = rt.init(null);
    const [, cmds] = rt.update["t1.GO"](booted, { type: "t1.GO", at: 1 });
    expect(cmds).toEqual([
      {
        type: "t1.notify",
        task: "the author's own field",
        lane: { task: "t1" },
      },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMES — a dispatch key is `${task}.${event}` and it is split at the FIRST
// dot, so a dot on either side of it is two messages wearing one key.
// ═══════════════════════════════════════════════════════════════════════════

const goer: ImportedChart = {
  events: { GO: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: { target: "shipped" } } },
      shipped: { end: true },
    },
  },
};

describe("runLane — dots", () => {
  it("refuses a task id with a dot in it", () => {
    const lane = defineLane({
      phases: { p1: { "a.b": goer } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    expect(() =>
      runLane(lane, {
        "a.b": {
          parts: { assign: { "queued.GO": () => ({}) } },
          boot: () => ({ type: "queued" }),
        },
      }),
    ).toThrow(/a\.b/);
  });

  it("refuses an event name with a dot in it", () => {
    const dotted: ImportedChart = {
      events: { "b.GO": { scope: "edges" } },
      states: {
        only: {
          queued: { initial: true, on: { "b.GO": { target: "shipped" } } },
          shipped: { end: true },
        },
      },
    };
    const lane = defineLane({
      phases: { p1: { a: dotted } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    expect(() =>
      runLane(lane, {
        a: {
          parts: { assign: { "queued.b.GO": () => ({}) } },
          boot: () => ({ type: "queued" }),
        },
      }),
    ).toThrow(/b\.GO/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE TWO REFUSALS NOTHING WAS DRIVING.
// ═══════════════════════════════════════════════════════════════════════════

describe("runLane — the refusals nothing was driving", () => {
  it("refuses a task the lane's phases declare and its charts do not", () => {
    const lane = defineLane({
      phases: { p1: { t1: goer } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    // The imported door's shape, hand-held: a lane whose phase names a task its
    // `charts` never got. Through it, that task gets no dispatch key and no
    // boot check, and the `as unknown as LaneRuntime<L>` at the bottom of
    // `runLane` asserts a totality that is not there.
    const holed = { ...lane, charts: {} };
    expect(() =>
      runLane(holed, {
        t1: {
          parts: { assign: { "queued.GO": () => ({}) } },
          boot: () => ({ type: "queued" }),
        },
      }),
    ).toThrow(/t1/);
  });

  it("refuses a message with no cell in the state the region is standing in", () => {
    const lane = defineLane({
      phases: { p1: { t1: goer } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    // A lane whose `charts` know a state its `spec` does not: the boot check
    // reads `charts` and passes, the compiled table was built from `spec` and
    // has no row for it. Everything downstream of this throw would be reading a
    // region that is standing nowhere.
    const skewed = {
      ...lane,
      charts: {
        t1: {
          events: goer.events,
          states: {
            only: {
              ...goer.states.only,
              limbo: { on: { GO: { target: "shipped" } } },
            },
          },
        } as ImportedChart,
      },
    };
    const rt = runLane(skewed, {
      t1: {
        parts: { assign: { "queued.GO": () => ({}) } },
        boot: () => ({ type: "limbo" }),
      },
    });
    const [booted] = rt.init(null);
    const cell = cells(rt)["t1.GO"];
    if (cell === undefined) throw new Error("no cell for t1.GO");
    expect(() => cell(booted as never, { type: "t1.GO" })).toThrow(
      /no cell for "t1\.GO" in state "limbo"/,
    );
  });
});
