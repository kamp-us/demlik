// ═══════════════════════════════════════════════════════════════════════════
// THE STUCK LIST, AND WHAT A TASK'S PREVIEW IS TOLD ABOUT ITSELF.
//
// `lane.test.ts` drives `inspectLane` over the fixture epic — the shapes, the
// standings, the three stuck kinds a real lane reaches. This file covers the
// four answers that lane cannot produce, each of which reads as a plausible
// screen while being wrong:
//
//   the FOURTH stuck kind, `dead-end` — a non-final state that routes nothing,
//   which the fixture's chart has no way to reach;
//   the role DE-DUP, which only shows up when one world sends three events;
//   `was`, handed to the per-task preview — without it a parked region's
//   resume points at the fallback rather than at where it was parked from;
//   the refusal's `from`, which is the STATE that refused, not the event.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import type { TaskState } from "../report/fold";
import type { ImportedChart } from "../report/workflow";
import { epic } from "./__fixtures__/epic-run";
import { inspectLane, inspectLaneStates } from "./inspect";
import { defineLane } from "./structure";

const leaf = (state: Partial<TaskState> & { type: string }): TaskState => ({
  retries: 0,
  maxRetries: 2,
  ...state,
});

describe("inspectLane — the fourth stuck kind", () => {
  // A document CAN declare a state that routes nothing and ends nothing. The
  // chart module's totality makes it unreachable through `defineChart`, which
  // is exactly why it is reported rather than swallowed: it arrives through the
  // imported door, from a `workflow.json` this repo has never seen.
  const cul: ImportedChart = {
    events: { GO: { scope: "edges" }, DONE: { scope: "edges" } },
    states: {
      only: {
        queued: { initial: true, on: { GO: { target: "limbo" } } },
        // no `on`, no `end` — a state with no way out and no way to finish.
        limbo: {},
        shipped: { end: true },
      },
    },
  };
  const lane = defineLane({
    phases: { p1: { t1: cul } },
    terminals: { complete: "complete", tripped: "tripped" },
  });

  it("reports a dead end as stuck, rather than as a task that can still move", () => {
    const view = inspectLane(lane, [{ task: "t1", event: "GO", at: "t0" }]);
    expect(view.phases[0]?.tasks[0]?.state).toBe("limbo");
    expect(view.stuck).toEqual([
      { task: "t1", reason: { kind: "dead-end", state: "limbo" } },
    ]);
    // it is NOT tripped: nothing declared this an ending, which is the whole
    // difference between a lane that failed and a lane nobody can finish.
    expect(view.tripped).toEqual([]);
    expect(view.phases[0]?.tasks[0]?.endPolarity).toBe(false);
  });

  it("says nothing is stuck while the same task can still move", () => {
    expect(inspectLane(lane, []).stuck).toEqual([]);
  });
});

describe("inspectLane — awaiting-world", () => {
  const desk: ImportedChart = {
    events: {
      START: { scope: "edges", from: { world: "the operator" } },
      APPROVE: { scope: "edges", from: { world: "the operator" } },
      REJECT: { scope: "edges", from: { world: "the operator" } },
      NUDGE: { scope: "edges", from: { world: "the reviewer" } },
    },
    states: {
      only: {
        queued: { initial: true, on: { START: { target: "waiting" } } },
        waiting: {
          on: {
            APPROVE: { target: "shipped" },
            REJECT: { target: "dropped" },
            NUDGE: { target: "waiting" },
          },
        },
        shipped: { end: true },
        dropped: { end: "error" },
      },
    },
  };
  const lane = defineLane({
    phases: { p1: { t1: desk } },
    terminals: { complete: "complete", tripped: "tripped" },
  });

  it("names each world ONCE, however many events it sends", () => {
    const view = inspectLane(lane, [{ task: "t1", event: "START", at: "t0" }]);
    const reason = view.stuck[0]?.reason;
    expect(reason?.kind).toBe("awaiting-world");
    // three events, two senders — `roles` is who is owed, and a UI renders it
    // as "waiting on the operator or the reviewer". Repeating a role once per
    // event it happens to send renders "the operator or the operator or …".
    expect(reason?.kind === "awaiting-world" ? reason.roles : []).toEqual([
      "the operator",
      "the reviewer",
    ]);
    expect(reason?.kind === "awaiting-world" ? reason.events : []).toEqual([
      "APPROVE",
      "REJECT",
      "NUDGE",
    ]);
  });
});

describe("inspectLaneStates — what the per-task preview is told", () => {
  it("hands the preview `was`, so a parked region resumes where it parked FROM", () => {
    const view = inspectLaneStates(epic, {
      issue_1: leaf({ type: "blocked", was: "build" }),
      issue_2: leaf({ type: "queued" }),
      issue_3: leaf({ type: "queued", maxRetries: 5 }),
    });
    const parked = view.phases[0]?.tasks[0];
    expect(parked?.was).toBe("build");
    const resume = parked?.events.find((e) => e.event === "UNBLOCKED");
    // `queued` is this edge's declared FALLBACK — the answer a preview gives
    // when it was told nothing about where the region came from. `build` is
    // where it will actually land, and it is the one a human reads before
    // pressing the button.
    expect(resume?.resolvedBy).toBe("resume");
    expect(resume?.resolved).toBe("build");
    expect(resume?.targets).toEqual(["build"]);
  });

  it("blames the STATE for a refusal, not the event that was refused", () => {
    const view = inspectLaneStates(epic, {
      issue_1: leaf({ type: "blocked", was: "build" }),
      issue_2: leaf({ type: "queued" }),
      issue_3: leaf({ type: "queued", maxRetries: 5 }),
    });
    const refusals = view.phases[0]?.tasks[0]?.refusals ?? [];
    // every row reads "from `blocked`, event X was refused because …" — `from`
    // is where the lane is standing, and it is the same for every row.
    expect(refusals.map((r) => r.event).sort()).toEqual([
      "BLOCKED",
      "DONE",
      "FAIL",
      "PASS",
      "WIP",
    ]);
    expect(new Set(refusals.map((r) => r.from))).toEqual(new Set(["blocked"]));
    expect(refusals.every((r) => r.from !== r.event)).toBe(true);
  });
});
