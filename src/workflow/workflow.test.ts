/**
 * Durable-workflow runtime core — property + example tests (#124).
 *
 * One suite, one acceptance criterion per `describe` (vitest globals are NOT
 * enabled in vitest.config.ts — describe/it/expect are imported explicitly,
 * matching the rest of the package; fast-check's seed + numRuns are pinned by
 * `src/test-setup.ts`, so any latent counterexample fails deterministically):
 *
 *   - "advance + next Cmd" .......... AC2: a result Msg advances the workflow
 *                                     and emits the next activity Cmd.
 *   - "owed/confirmed ledger" ....... AC3: owed recorded before dispatch,
 *                                     confirmed on result, re-emit-on-wake
 *                                     idempotent by delivery id.
 *   - "replay byte-identity" ........ AC4: two replays of the same event log →
 *                                     deeply-equal + JSON-identical state.
 *   - "completed at sequence end" ... reaching `completed` carrying the final
 *                                     result.
 *   - "discriminated-union invariant" AC1: the current activity exists ONLY
 *                                     while running.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ActivityCmd,
  type ActivityErr,
  type ActivityOk,
  createWorkflow,
  type EffectLedgerEvent,
  foldWorkflow,
  type WorkflowMsg,
  type WorkflowStep,
} from "./index";

// ── The opaque payloads. A workflow of named string-activities producing
//    string results; a string failure. Small structured values so equality
//    checks are meaningful. ────────────────────────────────────────────────
type Activity = string;
type Result = string;
type Failure = string;

const STEPS: readonly WorkflowStep<Activity>[] = [
  { name: "reserve", activity: "reserve-seat" },
  { name: "charge", activity: "charge-card" },
  { name: "ticket", activity: "issue-ticket" },
];

/** An arbitrary non-empty workflow definition (1..6 named steps). */
const arbSteps: fc.Arbitrary<readonly WorkflowStep<Activity>[]> = fc
  .array(fc.record({ name: fc.string(), activity: fc.string() }), {
    minLength: 1,
    maxLength: 6,
  })
  .map((xs) => xs);

/** A success result for the in-flight step's id. */
function ok(id: number, result: Result): ActivityOk<Result> {
  return { type: "activity_ok", id, result };
}
/** A failure for the in-flight step's id. */
function err(id: number, failure: Failure): ActivityErr<Failure> {
  return { type: "activity_err", id, failure };
}

/**
 * Drive a workflow to completion (or failure) by always answering the
 * in-flight activity with its own id. Returns the ordered Msg log + final
 * state — the log is what a consumer would persist and replay. `outcome` picks
 * success-everywhere or a failure at a chosen step.
 */
function driveToEnd(
  steps: readonly WorkflowStep<Activity>[],
  failAt: number | null,
): {
  readonly msgs: WorkflowMsg<Result, Failure>[];
  readonly finalState: ReturnType<
    typeof foldWorkflow<Activity, Result, Failure>
  >;
} {
  const wf = createWorkflow<Activity, Result, Failure>();
  let { state } = wf.init(steps);
  const msgs: WorkflowMsg<Result, Failure>[] = [];

  // Walk while running: answer current.id; stop at the first failure.
  let guard = 0;
  while (state.status === "running" && guard++ < 100) {
    const { id, index } = state.current;
    if (failAt !== null && index === failAt) {
      const m = err(id, `fail@${index}`);
      msgs.push(m);
      state = wf.onActivityErr(state, m).state;
    } else {
      const m = ok(id, `result@${index}`);
      msgs.push(m);
      state = wf.onActivityOk(state, m).state;
    }
  }
  return {
    msgs,
    finalState: foldWorkflow<Activity, Result, Failure>(steps, msgs),
  };
}

// ───────────────────────────────────────────────────────────────────────────
describe("workflow advance + next Cmd (AC2)", () => {
  it("init owes + dispatches the first activity", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    const { state, ledger, cmds } = wf.init(STEPS);

    expect(state.status).toBe("running");
    if (state.status !== "running") throw new Error("unreachable");
    expect(state.current.index).toBe(0);
    expect(state.current.step).toEqual(STEPS[0]);
    expect(state.completed).toEqual([]);

    // Owed BEFORE dispatch: one effect_owed event, one matching dispatch Cmd.
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("effect_owed");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toEqual<ActivityCmd<Activity>>({
      type: "workflow_activity",
      index: 0,
      id: state.current.id,
      activity: STEPS[0].activity,
    });
  });

  it("an activity-result Msg advances the workflow and emits the next activity Cmd", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    const started = wf.init(STEPS);
    const id0 = (started.state as { current: { id: number } }).current.id;

    const step = wf.onActivityOk(started.state, ok(id0, "seat-12A"));

    // Advanced to step 1, recorded step 0's result.
    expect(step.state.status).toBe("running");
    if (step.state.status !== "running") throw new Error("unreachable");
    expect(step.state.current.index).toBe(1);
    expect(step.state.completed).toEqual([
      { step: STEPS[0], result: "seat-12A" },
    ]);

    // Emitted the NEXT activity Cmd, and the ledger confirms step 0 + owes step 1.
    expect(step.cmds).toHaveLength(1);
    expect(step.cmds[0].index).toBe(1);
    expect(step.cmds[0].activity).toBe(STEPS[1].activity);
    expect(step.ledger.map((e) => e.type)).toEqual([
      "effect_confirmed",
      "effect_owed",
    ]);
  });

  it("PBT: each non-final success advances index by 1 and emits exactly one next Cmd", () => {
    fc.assert(
      fc.property(arbSteps, (steps) => {
        const wf = createWorkflow<Activity, Result, Failure>();
        let state = wf.init(steps).state;
        for (let i = 0; i < steps.length - 1; i++) {
          if (state.status !== "running") throw new Error("expected running");
          const prevIndex = state.current.index;
          const step = wf.onActivityOk(state, ok(state.current.id, `r${i}`));
          expect(step.state.status).toBe("running");
          if (step.state.status !== "running") throw new Error("unreachable");
          expect(step.state.current.index).toBe(prevIndex + 1);
          expect(step.cmds).toHaveLength(1);
          expect(step.cmds[0].index).toBe(prevIndex + 1);
          state = step.state;
        }
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("owed/confirmed ledger invariant (AC3)", () => {
  it("owed is recorded BEFORE the dispatch Cmd, confirmed on the result", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    const started = wf.init(STEPS);
    // init: owed precedes dispatch — the ledger event is present and the Cmd
    // carries the same id, so a host persisting `ledger` before `cmds` records
    // the owe before performing the activity.
    expect(started.ledger[0].type).toBe("effect_owed");
    const owedEvent = started.ledger[0] as Extract<
      EffectLedgerEvent<ActivityCmd<Activity>>,
      { type: "effect_owed" }
    >;
    expect(owedEvent.id).toBe(started.cmds[0].id);
    expect(owedEvent.effect).toEqual(started.cmds[0]);

    // On result: the same id is confirmed.
    const id0 = (started.state as { current: { id: number } }).current.id;
    const step = wf.onActivityOk(started.state, ok(id0, "x"));
    const confirms = step.ledger.filter((e) => e.type === "effect_confirmed");
    expect(confirms).toHaveLength(1);
    expect((confirms[0] as { id: number }).id).toBe(id0);
  });

  it("re-emit-on-wake re-fires the SAME id; a duplicate result is idempotent (no-op)", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    const started = wf.init(STEPS);
    const id0 = (started.state as { current: { id: number } }).current.id;

    // Cold wake: fold ONLY the owed event (the result never persisted) → the
    // surviving dispatch re-fires with the identical id + payload.
    const survivors = wf.survivingActivities(started.ledger);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toEqual(started.cmds[0]);
    expect(survivors[0].id).toBe(id0);

    // Advance once. A duplicate (re-emitted) result for the now-confirmed id is
    // a no-op: state unchanged, no effects — idempotent by delivery id.
    const advanced = wf.onActivityOk(started.state, ok(id0, "first"));
    const dup = wf.onActivityOk(advanced.state, ok(id0, "again"));
    expect(dup.state).toBe(advanced.state);
    expect(dup.ledger).toEqual([]);
    expect(dup.cmds).toEqual([]);
  });

  it("after both owe + confirm are folded, no activity survives (nothing re-emitted)", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    const started = wf.init([STEPS[0]]); // single-step workflow
    const id0 = (started.state as { current: { id: number } }).current.id;
    const done = wf.onActivityOk(started.state, ok(id0, "only"));
    expect(done.state.status).toBe("completed");

    // The full ledger log: owe (from init) then confirm (from the result).
    const log = [...started.ledger, ...done.ledger];
    expect(wf.survivingActivities(log)).toEqual([]);
  });

  it("PBT: at every point at most ONE activity is owed-but-unconfirmed", () => {
    fc.assert(
      fc.property(arbSteps, (steps) => {
        const wf = createWorkflow<Activity, Result, Failure>();
        const started = wf.init(steps);
        let state = started.state;
        let log: EffectLedgerEvent<ActivityCmd<Activity>>[] = [
          ...started.ledger,
        ];
        // After init, exactly one is owed.
        expect(wf.survivingActivities(log)).toHaveLength(1);

        while (state.status === "running") {
          const step = wf.onActivityOk(state, ok(state.current.id, "r"));
          log = [...log, ...step.ledger];
          state = step.state;
          // Mid-sequence: exactly one owed (confirm prior + owe next); at the
          // end: zero (the final confirm with no further owe).
          const surviving = wf.survivingActivities(log).length;
          expect(surviving === 0 || surviving === 1).toBe(true);
          if (state.status === "completed") expect(surviving).toBe(0);
          else expect(surviving).toBe(1);
        }
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("replay byte-identity (AC4 — the determinism contract)", () => {
  it("two replays of the same event log produce deeply-equal + JSON-identical state", () => {
    const { msgs } = driveToEnd(STEPS, null);
    const a = foldWorkflow<Activity, Result, Failure>(STEPS, msgs);
    const b = foldWorkflow<Activity, Result, Failure>(STEPS, msgs);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.status).toBe("completed");
  });

  it("PBT: replay is byte-identical for any schedule (success-only and with a failure)", () => {
    fc.assert(
      fc.property(
        arbSteps,
        // failAt: null (all succeed) or an in-range step index to fail at.
        fc.option(fc.nat(), { nil: null }),
        (steps, rawFailAt) => {
          const failAt = rawFailAt === null ? null : rawFailAt % steps.length;
          const { msgs } = driveToEnd(steps, failAt);
          const a = foldWorkflow<Activity, Result, Failure>(steps, msgs);
          const b = foldWorkflow<Activity, Result, Failure>(steps, msgs);
          // Byte-identity: the determinism contract.
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
          // And the outcome matches the schedule.
          if (failAt === null) expect(a.status).toBe("completed");
          else expect(a.status).toBe("failed");
        },
      ),
    );
  });

  it("cold-wake == never-evicted: re-folding the persisted Msg log mid-workflow matches", () => {
    // Drive two of three steps, then 'evict' and replay the persisted Msg log.
    const wf = createWorkflow<Activity, Result, Failure>();
    let state = wf.init(STEPS).state;
    const msgs: WorkflowMsg<Result, Failure>[] = [];
    for (let i = 0; i < 2; i++) {
      if (state.status !== "running") throw new Error("expected running");
      const m = ok(state.current.id, `r${i}`);
      msgs.push(m);
      state = wf.onActivityOk(state, m).state;
    }
    // The never-evicted live state vs the cold-wake fold of the same Msg log.
    const rebuilt = foldWorkflow<Activity, Result, Failure>(STEPS, msgs);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(state));
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("reaching completed at the end of the sequence", () => {
  it("the final step's result becomes the workflow output", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    let state = wf.init(STEPS).state;
    let lastResult = "";
    while (state.status === "running") {
      lastResult = `out@${state.current.index}`;
      state = wf.onActivityOk(state, ok(state.current.id, lastResult)).state;
    }
    expect(state.status).toBe("completed");
    if (state.status !== "completed") throw new Error("unreachable");
    expect(state.output).toBe(lastResult);
    expect(state.completed).toHaveLength(STEPS.length);
    expect(state.completed.map((c) => c.step)).toEqual(STEPS);
  });

  it("a single-step workflow completes on its first result", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    const started = wf.init([STEPS[0]]);
    const id0 = (started.state as { current: { id: number } }).current.id;
    const done = wf.onActivityOk(started.state, ok(id0, "the-output"));
    expect(done.state.status).toBe("completed");
    if (done.state.status !== "completed") throw new Error("unreachable");
    expect(done.state.output).toBe("the-output");
    expect(done.cmds).toEqual([]); // terminal: no further dispatch
  });

  // An empty step sequence is no longer a runtime throw — `init` takes a
  // non-empty `WorkflowSteps` tuple, so `wf.init([])` is a COMPILE error. The
  // invariant is pinned by the type-level test `steps-nonempty.test-d.ts`.
});

// ───────────────────────────────────────────────────────────────────────────
describe("discriminated-union invariant (AC1)", () => {
  it("the current activity is reachable ONLY on the running variant", () => {
    // running carries `current`; the type narrows so `current` is accessible.
    const wf = createWorkflow<Activity, Result, Failure>();
    const running = wf.init(STEPS).state;
    expect(running.status).toBe("running");
    if (running.status === "running") {
      expect(running.current).toBeDefined();
    }

    // completed carries `output`, NOT `current`.
    const completed = foldWorkflow<Activity, Result, Failure>(
      [STEPS[0]],
      [ok(1, "done")],
    );
    expect(completed.status).toBe("completed");
    expect("current" in completed).toBe(false);

    // failed carries `failure` + `failedStep`, NOT `current`.
    const failed = foldWorkflow<Activity, Result, Failure>(
      [STEPS[0]],
      [err(1, "boom")],
    );
    expect(failed.status).toBe("failed");
    expect("current" in failed).toBe(false);
    if (failed.status === "failed") {
      expect(failed.failure).toBe("boom");
      expect(failed.failedStep).toEqual(STEPS[0]);
    }
  });

  it("a failure transitions to failed forward-only and preserves completed history (#125 seam)", () => {
    // Succeed step 0, fail step 1: the failed state keeps step 0's completed
    // record (the history #125's reverse-order compensation will roll back).
    const { finalState } = driveToEnd(STEPS, 1);
    expect(finalState.status).toBe("failed");
    if (finalState.status !== "failed") throw new Error("unreachable");
    expect(finalState.completed).toHaveLength(1);
    expect(finalState.completed[0].step).toEqual(STEPS[0]);
    expect(finalState.failedStep).toEqual(STEPS[1]);
    // Forward-only: no compensation Cmds emitted in #124.
  });

  it("PBT: a running state always has completed.length === current.index", () => {
    fc.assert(
      fc.property(arbSteps, (steps) => {
        const wf = createWorkflow<Activity, Result, Failure>();
        let state = wf.init(steps).state;
        while (state.status === "running") {
          expect(state.completed.length).toBe(state.current.index);
          state = wf.onActivityOk(state, ok(state.current.id, "r")).state;
        }
      }),
    );
  });
});
