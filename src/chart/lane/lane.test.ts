// The lane structure and the lane inspector, over a REAL multi-phase document.
//
// The lane under test is not drawn here: `__fixtures__/epic.ts` hands a
// `## Dependencies` block to fabrika's own vendored `lane emit` and imports
// what it wrote. So nothing below may name a state of the epic machine —
// phoenix #5800 is rewriting exactly those — and everything is asserted through
// the grammar instead (phase order, task sets, final polarity, standings).
import { describe, expect, it } from "vitest";
import { lane as coderChart } from "../__fixtures__/lane";
import {
  EPIC_LANE,
  EPIC_RUN_COMPLETE,
  EPIC_RUN_TRIPPED,
} from "../report/__fixtures__/epic";
import { coder } from "../report/__fixtures__/templates";
import {
  chartFromWorkflow,
  type ImportedChart,
  statesOf,
} from "../report/workflow";
import { inspectLane } from "./inspect";
import { defineLane, LaneShapeError, laneShape } from "./structure";

// Both malformed charts below are typed `ImportedChart` on purpose. These are
// the imported door's defects — the door whose charts CANNOT be asked in the
// type layer — and that is the whole reason `defineLane` still checks them at
// runtime. Written as literals they would be caught one layer earlier, by
// `__laneTaskChartMarksNoInitialState` / `__laneTaskChartDeclaresNoFinal`,
// which `markers.test-d.ts` pins.
const NO_INITIAL: ImportedChart = { events: {}, states: { g: { s: {} } } };
const NO_FINAL: ImportedChart = {
  events: { GO: { scope: "edges" } },
  states: { g: { a: { initial: true, on: { GO: { target: "a" } } } } },
};

const coderLane = chartFromWorkflow(coder);
const CODER_CHART = coderLane.charts.issue;
if (CODER_CHART === undefined)
  throw new Error("the coder template lost `issue`");

describe("defineLane — the authoring door", () => {
  const lane = defineLane({
    id: "epic-1",
    phases: {
      phase1: { issue_1: CODER_CHART, issue_2: CODER_CHART },
      phase2: { issue_3: CODER_CHART },
    },
    terminals: { complete: "complete", tripped: "tripped" },
    retries: { issue_3: 5 },
  });

  it("derives the phase order and each phase's task set from the nesting", () => {
    expect(lane.phases).toEqual([
      { name: "phase1", tasks: ["issue_1", "issue_2"] },
      { name: "phase2", tasks: ["issue_3"] },
    ]);
  });

  it("produces the SAME value `chartFromWorkflow` does — one representation", () => {
    // The proof that there is no second code path: an authored lane folds,
    // derives and draws through the imported lane's functions untouched.
    expect(Object.keys(lane.charts).sort()).toEqual([
      "issue_1",
      "issue_2",
      "issue_3",
    ]);
    expect(lane.terminals).toEqual({
      complete: "complete",
      tripped: "tripped",
    });
    expect(lane.context.issue_1?.maxRetries).toBe(2);
    expect(lane.context.issue_3?.maxRetries).toBe(5);
  });

  it("refuses a chart with no initial state — a runtime check, by necessity", () => {
    expect(() =>
      defineLane({
        phases: { p1: { t: NO_INITIAL } },
        terminals: { complete: "complete", tripped: "tripped" },
      }),
    ).toThrow(LaneShapeError);
  });

  it("refuses a chart with no final — its phase could never complete", () => {
    expect(() =>
      defineLane({
        phases: { p1: { t: NO_FINAL } },
        terminals: { complete: "complete", tripped: "tripped" },
      }),
    ).toThrow(LaneShapeError);
  });

  it("refuses two terminals spelled the same way", () => {
    expect(() =>
      defineLane({
        phases: { p1: { t: CODER_CHART } },
        terminals: { complete: "over", tripped: "over" },
      }),
    ).toThrow(LaneShapeError);
  });

  it("names EVERY defect, never a half-lane", () => {
    try {
      defineLane({
        phases: { p1: { t: NO_INITIAL } },
        terminals: { complete: "over", tripped: "over" },
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(LaneShapeError);
      expect((error as LaneShapeError).defects).toHaveLength(3);
    }
  });
});

describe("defineLane — the TYPED door", () => {
  // The same `defineChart` literal the rest of `src/chart` is written against.
  // Before this, putting it in a lane took a cast: `phases` took an
  // `ImportedChart` and erased every literal type the chart module exists to
  // preserve. What is asserted here is the other half of that fix — the VALUE.
  const typed = defineLane({
    id: "epic-typed",
    phases: { phase1: { issue_1: coderChart } },
    terminals: { complete: "complete", tripped: "tripped" },
  });

  const states = () => {
    const chart = typed.charts.issue_1;
    if (chart === undefined) throw new Error("the lane lost `issue_1`");
    return statesOf(chart);
  };

  it("lowers every authored edge form to the ONE the fold reads", () => {
    expect(states().get("queued")).toEqual({
      initial: true,
      on: { WIP: { target: "build" }, BLOCKED: { target: "blocked" } },
    });
    // the guarded edge keeps BOTH arms and the guard name — the fold reads all
    // three, and a lowering that dropped `otherwise` would silently make the
    // retry budget unspendable.
    expect(states().get("review")?.on?.FAIL).toEqual({
      target: "build",
      when: "retriesRemaining",
      otherwise: "frozen",
    });
    // `resume` is a property of the EDGE, and survives as one.
    expect(states().get("blocked")?.on?.UNBLOCKED).toEqual({
      resume: { fallback: "queued" },
    });
  });

  it("keeps final polarity — the two endings are not the same ending", () => {
    expect(states().get("shipped")?.end).toBe(true);
    expect(states().get("frozen")?.end).toBe("error");
    const shape = laneShape(typed);
    expect(shape.tasks[0]?.successFinals).toEqual(["shipped"]);
    expect(shape.tasks[0]?.errorFinals).toEqual(["frozen"]);
    expect(shape.tasks[0]?.initial).toBe("queued");
  });

  it("folds and inspects through the IMPORTED functions, untouched", () => {
    const view = inspectLane(typed, [
      { task: "issue_1", event: "WIP", at: "2024-01-01T00:00:00Z" },
      { task: "issue_1", event: "DONE", at: "2024-01-01T00:01:00Z" },
      { task: "issue_1", event: "PASS", at: "2024-01-01T00:02:00Z" },
      { task: "issue_1", event: "DONE", at: "2024-01-01T00:03:00Z" },
    ]);
    expect(view.phases[0]?.tasks[0]?.state).toBe("shipped");
    expect(view.status).toBe("done");
    expect(view.terminal).toBe("complete");
  });

  it("is the IDENTITY on an imported chart — a lowering, not a rewrite", () => {
    // The proof that the imported door goes through the same lowering and comes
    // out the value it went in as. One representation, two doors, no fork.
    const imported = defineLane({
      phases: { phase1: { issue_1: CODER_CHART } },
      terminals: { complete: "complete", tripped: "tripped" },
    });
    expect(imported.charts.issue_1).toEqual(CODER_CHART);
  });
});

describe("laneShape — the reading door, over an emitted lane", () => {
  const shape = laneShape(EPIC_LANE);

  it("chains the phases: each hands off to the next, the last to `complete`", () => {
    const names = EPIC_LANE.phases.map((p) => p.name);
    expect(shape.phases.map((p) => p.next)).toEqual([
      ...names.slice(1),
      EPIC_LANE.terminals.complete,
    ]);
    expect(shape.phases.map((p) => p.index)).toEqual(
      names.map((_, index) => index),
    );
  });

  it("splits each task's finals by polarity, off the charts", () => {
    for (const task of shape.tasks) {
      expect(task.successFinals.length).toBeGreaterThan(0);
      expect(task.errorFinals.length).toBeGreaterThan(0);
      // Disjoint by construction: a state has ONE `end`.
      expect(
        task.successFinals.filter((s) => task.errorFinals.includes(s)),
      ).toEqual([]);
    }
    expect(shape.cannotTrip).toEqual([]);
  });

  it("names each task's siblings — the regions running beside it", () => {
    for (const task of shape.tasks) {
      const phase = EPIC_LANE.phases.find((p) => p.name === task.phase);
      expect([...task.siblings, task.id].sort()).toEqual(
        [...(phase?.tasks ?? [])].sort(),
      );
      expect(task.siblings).not.toContain(task.id);
    }
  });

  it("reads each task's initial off `initial: true`, not off a phase order", () => {
    for (const task of shape.tasks) {
      expect(task.initial).not.toBe("");
    }
  });
});

describe("inspectLane", () => {
  it("is `done` on a completed run, with the complete terminal named", () => {
    const view = inspectLane(EPIC_LANE, EPIC_RUN_COMPLETE);
    expect(view.status).toBe("done");
    expect(view.terminal).toBe(EPIC_LANE.terminals.complete);
    expect(view.activePhase).toBeNull();
    expect(view.tripped).toEqual([]);
    expect(view.stuck).toEqual([]);
    expect(view.phases.map((p) => p.standing)).toEqual(
      EPIC_LANE.phases.map(() => "complete"),
    );
  });

  it("names the tripped task, the tripped phase, and the phases that never ran", () => {
    const view = inspectLane(EPIC_LANE, EPIC_RUN_TRIPPED);
    expect(view.status).toBe("done");
    expect(view.terminal).toBe(EPIC_LANE.terminals.tripped);
    expect(view.tripped).toHaveLength(1);

    const standings = view.phases.map((p) => p.standing);
    expect(standings.filter((s) => s === "tripped")).toHaveLength(1);
    // Positional, not local: everything after the trip is `waiting`, whatever
    // its regions happen to read.
    const trippedAt = standings.indexOf("tripped");
    for (const standing of standings.slice(trippedAt + 1)) {
      expect(standing).toBe("waiting");
    }
    for (const standing of standings.slice(0, trippedAt)) {
      expect(standing).toBe("complete");
    }
    expect(view.stuck.map((s) => s.reason.kind)).toEqual(["tripped"]);
  });

  it("walks the whole run: one phase is active at a time, and they advance", () => {
    const seen: string[] = [];
    for (let k = 0; k <= EPIC_RUN_COMPLETE.length; k++) {
      const view = inspectLane(EPIC_LANE, EPIC_RUN_COMPLETE.slice(0, k));
      const active = view.phases.filter((p) => p.standing === "active");
      expect(active.length).toBeLessThanOrEqual(1);
      if (view.activePhase !== null && seen.at(-1) !== view.activePhase) {
        seen.push(view.activePhase);
      }
    }
    expect(seen).toEqual(EPIC_LANE.phases.map((p) => p.name));
  });

  it("answers, per task, what it is waiting on and which events are legal", () => {
    const view = inspectLane(EPIC_LANE, []);
    const first = view.phases[0]?.tasks[0];
    if (first === undefined) throw new Error("no task in the first phase");
    expect(first.state).toBe(
      laneShape(EPIC_LANE).tasks.find((t) => t.id === first.task)?.initial,
    );
    expect(first.waitingOn).not.toBeNull();
    expect(first.legal.length).toBeGreaterThan(0);
    // Legal + refused is the WHOLE alphabet — a refusal is a control with a
    // reason, never a missing one.
    expect(first.legal.length + first.refusals.length).toBe(
      first.events.length,
    );
  });

  it("refuses over a final for BEING a final, in both polarities", () => {
    for (const entries of [EPIC_RUN_COMPLETE, EPIC_RUN_TRIPPED]) {
      const view = inspectLane(EPIC_LANE, entries);
      for (const phase of view.phases) {
        for (const task of phase.tasks) {
          if (task.endPolarity === false) continue;
          expect(task.legal).toEqual([]);
          for (const refusal of task.refusals) {
            expect(refusal.reason.kind).toBe("end");
          }
        }
      }
    }
  });

  it("calls a spent retry budget stuck — the door that is about to be one-way", () => {
    // Drive one task to the last retry without spending it, off the grammar:
    // the prefix just before the tripped run's final event is the task sitting
    // at `retries === maxRetries`.
    const brink = EPIC_RUN_TRIPPED.slice(0, EPIC_RUN_TRIPPED.length - 1);
    const view = inspectLane(EPIC_LANE, brink);
    const spent = view.stuck.filter((s) => s.reason.kind === "budget-spent");
    expect(spent).toHaveLength(1);
    const reason = spent[0]?.reason;
    if (reason?.kind !== "budget-spent") throw new Error("expected the budget");
    // It lands on an ERROR final — which is why it is worth saying out loud.
    const task = laneShape(EPIC_LANE).tasks.find(
      (t) => t.id === spent[0]?.task,
    );
    expect(task?.errorFinals).toContain(reason.landsOn);
  });
});
