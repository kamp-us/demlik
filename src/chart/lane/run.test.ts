// The lane RUNTIME: routing, per-instance boot, phase advancement, tagged cmds
// — and the one assertion that decides whether any of it is real, which is that
// `defineMachine` takes the result with no cast.
import { describe, expect, it } from "vitest";
import type { Sub } from "../../pure/core";
import { defineMachine } from "../../runtime-types";
import { defineChart, ty } from "../graph";
import type { ImportedChart } from "../report/workflow";
import { coderParts, epic } from "./__fixtures__/epic-run";
import {
  type LaneCmd,
  type LaneHands,
  type LaneRunMsg,
  type LaneRunState,
  runLane,
} from "./run";
import { defineLane, LaneShapeError } from "./structure";

type Run = LaneRunState<typeof epic>;
type AnyMsg = {
  readonly type: string;
  readonly at?: number;
  readonly reason?: string;
};
type Cells = Readonly<
  Record<
    string,
    | ((s: Run, m: AnyMsg) => readonly [Run, readonly { type: string }[]])
    | undefined
  >
>;

/**
 * The test-side dispatch harness. `update` is a mapped type over the lane's
 * whole msg union, and driving it from a `msg.type` held in a variable is the
 * one thing that type cannot express — the same reason `equiv-status-poller`
 * reaches for a string-keyed view of the compiled table. Every TYPED dispatch
 * in this file goes through `machine.update["issue_1.WIP"](…)` instead, with no
 * cast at all; this is only for the loops.
 */
const cells = (rt: { readonly update: object }): Cells =>
  rt.update as unknown as Cells;

/**
 * Every task booted where its chart starts — the fold's zero.
 *
 * `satisfies` rather than a bare `const`: it is what gives `boot`'s body a
 * contextual type, so `{ type: "queued" }` stays the literal instead of
 * widening to `string`. Written inline at the call site the parameter does the
 * same job; a hoisted hands object needs to ask for it.
 */
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

const drive = (
  rt: {
    readonly init: (l: null) => readonly [Run, unknown];
    readonly update: object;
  },
  msgs: readonly AnyMsg[],
): Run => {
  let state = rt.init(null)[0];
  for (const msg of msgs) {
    const cell = cells(rt)[msg.type];
    if (cell === undefined) throw new Error(`no cell for ${msg.type}`);
    state = cell(state, msg)[0];
  }
  return state;
};

const ship = (task: string, t: number): readonly AnyMsg[] => [
  { type: `${task}.WIP`, at: t },
  { type: `${task}.DONE`, at: t + 1 },
  { type: `${task}.PASS`, at: t + 2 },
  { type: `${task}.DONE`, at: t + 3 },
];

describe("runLane — routing", () => {
  const rt = runLane(epic, freshHands);

  it("keys the dispatch surface by task-dot-event — keyOf's namespace", () => {
    expect(Object.keys(rt.update).sort()).toEqual([
      "issue_1.BLOCKED",
      "issue_1.DONE",
      "issue_1.FAIL",
      "issue_1.PASS",
      "issue_1.UNBLOCKED",
      "issue_1.WIP",
      "issue_2.BLOCKED",
      "issue_2.DONE",
      "issue_2.FAIL",
      "issue_2.PASS",
      "issue_2.UNBLOCKED",
      "issue_2.WIP",
      "issue_3.BLOCKED",
      "issue_3.DONE",
      "issue_3.FAIL",
      "issue_3.PASS",
      "issue_3.UNBLOCKED",
      "issue_3.WIP",
    ]);
  });

  it("moves the addressed region and NO other", () => {
    const state = drive(rt, [{ type: "issue_1.WIP", at: 1 }]);
    expect(state.regions.issue_1.type).toBe("build");
    expect(state.regions.issue_2.type).toBe("queued");
    expect(state.regions.issue_3.type).toBe("queued");
  });

  it("tags every cmd with the task that emitted it", () => {
    const [booted] = rt.init(null);
    // TYPED dispatch — no cast: the key, the msg and the state are all the
    // lane's own derivations.
    const [, cmds] = rt.update["issue_2.WIP"](booted, {
      type: "issue_2.WIP",
      at: 1,
    });
    // the tag rides BESIDE the payload, nested — a chart's own `task` field
    // would otherwise be overwritten by the lane's task id, silently.
    expect(cmds).toEqual([
      {
        type: "issue_2.spawn_shell",
        lane: { task: "issue_2" },
        step: "queued.WIP",
      },
    ]);
  });
});

describe("runLane — per-instance boot", () => {
  it("boots each instance where IT is, not where the chart starts", () => {
    const rt = runLane(epic, {
      issue_1: {
        parts: coderParts,
        boot: () => ({ type: "review", retries: 1, maxRetries: 2 }),
      },
      issue_2: {
        parts: coderParts,
        boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
      },
      issue_3: {
        parts: coderParts,
        boot: () => ({ type: "build", retries: 0, maxRetries: 5 }),
      },
    });
    const [booted] = rt.init(null);
    expect(booted.regions.issue_1.type).toBe("review");
    expect(booted.regions.issue_2.type).toBe("queued");
    expect(booted.regions.issue_3.type).toBe("build");
    // the region really is LIVE where it booted: `review` routes PASS.
    const [next] = rt.update["issue_1.PASS"](booted, {
      type: "issue_1.PASS",
      at: 2,
    });
    expect(next.regions.issue_1.type).toBe("ship");
    // …and it kept the retry count it booted with.
    expect(next.regions.issue_1.retries).toBe(1);
  });

  it("derives the lane's standing AT BOOT — a lane can boot already tripped", () => {
    const rt = runLane(epic, {
      issue_1: {
        parts: coderParts,
        boot: () => ({ type: "frozen", retries: 2, maxRetries: 2 }),
      },
      issue_2: {
        parts: coderParts,
        boot: () => ({ type: "shipped", retries: 0, maxRetries: 2 }),
      },
      issue_3: {
        parts: coderParts,
        boot: () => ({ type: "queued", retries: 0, maxRetries: 5 }),
      },
    });
    expect(rt.init(null)[0].lane).toBe("tripped");
  });

  it("boots straight into `complete` when every phase is already done", () => {
    const rt = runLane(epic, {
      issue_1: {
        parts: coderParts,
        boot: () => ({ type: "shipped", retries: 0, maxRetries: 2 }),
      },
      issue_2: {
        parts: coderParts,
        boot: () => ({ type: "shipped", retries: 0, maxRetries: 2 }),
      },
      issue_3: {
        parts: coderParts,
        boot: () => ({ type: "shipped", retries: 0, maxRetries: 5 }),
      },
    });
    expect(rt.init(null)[0].lane).toBe("complete");
  });

  it("returns a rehydrated lane's leaves verbatim, with no cmds (invariant 2)", () => {
    const rt = runLane(epic, freshHands);
    // NOT the state a cold boot produces, which is the whole assertion: handed
    // `init(null)`'s own output back, this test holds whether or not the
    // rehydration branch exists at all. Driven three steps first, it does not.
    // `lane-runtime.test.ts` carries the rest of that door — what a persisted
    // state is CHECKED against on the way in.
    const loaded = drive(rt, [
      { type: "issue_1.WIP", at: 1 },
      { type: "issue_1.DONE", at: 2 },
      { type: "issue_1.BLOCKED", at: 3, reason: "waiting on review" },
    ]);
    expect(loaded.regions.issue_1.type).toBe("blocked");
    expect(rt.init(loaded)).toEqual([loaded, []]);
  });

  it("refuses a boot state the task's chart does not declare", () => {
    // At the IMPORTED door, where the marker stands down: an `ImportedChart`'s
    // states are `string`, so "is `landed` one of them" is not a question the
    // type layer can be asked and `init` is the only net there is. The typed
    // door never reaches this throw — `boot: () => StateOf<C>` refuses
    // `"landed"` at compile time, which `run.markers.test-d.ts` pins.
    const doc: ImportedChart = {
      events: { GO: { scope: "edges" } },
      states: {
        only: {
          queued: { initial: true, on: { GO: { target: "shipped" } } },
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
        parts: { assign: { "queued.GO": () => ({}) } },
        boot: () => ({ type: "landed" }),
      },
    });
    expect(() => rt.init(null)).toThrow(LaneShapeError);
    expect(() => rt.init(null)).toThrow(/t1.*landed/);
  });
});

describe("runLane — phase advancement", () => {
  const rt = runLane(epic, freshHands);

  it("stays `running` while any region of the active phase is live", () => {
    const state = drive(rt, ship("issue_1", 1));
    expect(state.regions.issue_1.type).toBe("shipped");
    // `issue_2` is still queued — phase1 has not completed.
    expect(state.lane).toBe("running");
  });

  it("stays `running` when a phase completes but a LATER phase has not", () => {
    const state = drive(rt, [...ship("issue_1", 1), ...ship("issue_2", 10)]);
    expect(state.lane).toBe("running");
  });

  it("lands on `complete` when the last phase's regions all reach a success final", () => {
    const state = drive(rt, [
      ...ship("issue_1", 1),
      ...ship("issue_2", 10),
      ...ship("issue_3", 20),
    ]);
    expect(state.lane).toBe("complete");
  });

  it("trips the lane the moment a completed phase holds an error final", () => {
    const state = drive(rt, [
      // `issue_1` burns its budget of 2: two retries, then frozen.
      { type: "issue_1.WIP", at: 1 },
      { type: "issue_1.DONE", at: 2 },
      { type: "issue_1.FAIL", at: 3, reason: "flaky" },
      { type: "issue_1.DONE", at: 4 },
      { type: "issue_1.FAIL", at: 5, reason: "flaky" },
      { type: "issue_1.DONE", at: 6 },
      { type: "issue_1.FAIL", at: 7, reason: "out of budget" },
      // …and `issue_2` finishes, so phase1 is complete-with-an-error.
      ...ship("issue_2", 10),
    ]);
    expect(state.regions.issue_1.type).toBe("frozen");
    expect(state.regions.issue_1.retries).toBe(2);
    expect(state.lane).toBe("tripped");
  });

  it("resumes a parked region to where it was parked from", () => {
    const state = drive(rt, [
      { type: "issue_1.WIP", at: 1 },
      { type: "issue_1.BLOCKED", at: 2, reason: "waiting on review" },
      { type: "issue_1.UNBLOCKED", at: 3 },
    ]);
    expect(state.regions.issue_1.type).toBe("build");
  });
});

describe("runLane — a real Machine", () => {
  it("is accepted by `defineMachine` with no cast", async () => {
    const machine = defineMachine<
      LaneRunState<typeof epic>,
      LaneRunMsg<typeof epic>,
      LaneCmd<typeof epic>,
      Sub<never>,
      Record<never, never>
    >({
      ...runLane(epic, freshHands),
      interpret: {
        "issue_1.spawn_shell": async () => undefined,
        "issue_2.spawn_shell": async () => undefined,
        "issue_3.spawn_shell": async () => undefined,
      },
    });
    expect(machine.__form).toBe("reducer");
    const [state] = machine.init(null, {});
    expect(state.lane).toBe("running");
    const [next] = machine.update["issue_3.WIP"](state, {
      type: "issue_3.WIP",
      at: 1,
    });
    expect(next.regions.issue_3.type).toBe("build");
    await expect(
      machine.interpret["issue_1.spawn_shell"](
        {
          type: "issue_1.spawn_shell",
          lane: { task: "issue_1" },
          step: "queued.WIP",
        },
        { emit: () => undefined },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("runLane — the refusals", () => {
  it("refuses a region whose chart declares a FOREIGN event", () => {
    const foreignish = defineChart({
      events: {
        GO: { scope: "edges" },
        deadline_exceeded: {
          data: ty<{ readonly atMs: number }>(),
          scope: "edges",
          foreign: true,
        },
      },
      states: {
        only: {
          queued: { initial: true, on: { GO: "shipped" } },
          shipped: { end: true },
        },
      },
    });
    const lane = defineLane({
      phases: { p1: { t1: foreignish } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    const hand = {
      t1: {
        parts: { assign: { "queued.GO": () => ({}) } },
        boot: () => ({ type: "queued" }) as const,
      },
    };
    // @ts-expect-error — `__laneRegionChartDeclaresAForeignEvent: "t1"`
    expect(() => runLane(lane, hand)).toThrow(LaneShapeError);
  });

  it("still runs a lane read out of a `workflow.json` — the imported door", () => {
    const doc: ImportedChart = {
      events: { GO: { scope: "edges" } },
      states: {
        only: {
          queued: { initial: true, on: { GO: { target: "shipped" } } },
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
        parts: { assign: { "queued.GO": () => ({}) } },
        boot: () => ({ type: "queued" }),
      },
    });
    const [booted] = rt.init(null);
    expect(booted.lane).toBe("running");
    // `update` reads back with a `string` key here — an imported chart's event
    // alphabet IS `string`, so the mapped type degenerates to an index
    // signature and the lookup is genuinely partial. That is the imported
    // door's whole bargain, stated in the one place a reader meets it.
    const cell = (rt.update as Record<string, unknown>)["t1.GO"];
    expect(typeof cell).toBe("function");
    const [next] = rt.update["t1.GO"]?.(booted, { type: "t1.GO" }) ?? [booted];
    expect(next.lane).toBe("complete");
  });
});
