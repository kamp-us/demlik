/**
 * Saga compensation on the durable-workflow runtime — property + example tests
 * (#125, Phase-2 of epic #118).
 *
 * #125 maps `@demlik/tea/saga`'s forward-then-compensate transaction onto the
 * workflow engine's failure path: a step may declare a compensation (its
 * inverse activity), and a forward failure unwinds the COMPLETED steps' declared
 * compensations in strict REVERSE order, each a durable owed effect on the same
 * #67 ledger. These tests pin the saga semantics the brief requires the
 * workflow to align with (NOT a divergent rollback):
 *
 *   - "reverse-order compensation" .... completed [s0,s1,s2], fail → undo
 *                                       s2,s1,s0 in that exact order (AC1).
 *   - "durable compensation" .......... each compensation owed before dispatch,
 *                                       re-emitted idempotently on eviction
 *                                       mid-rollback (AC2).
 *   - "empty rollback" ................ fail with zero completed (or zero
 *                                       compensable) steps → `failed`, no
 *                                       compensation Cmd (AC3).
 *   - "failed_compensated settle" ..... compensating → all confirmed →
 *                                       `failed_compensated`.
 *   - "compensation_failed terminal" .. a compensation itself fails → terminal
 *                                       `compensation_failed`, never wedged.
 *   - "replay byte-identity" .......... two replays across a failure+
 *                                       compensation sequence are JSON-identical
 *                                       (AC4).
 *
 * vitest globals are NOT enabled — describe/it/expect imported explicitly;
 * fast-check seed + numRuns pinned by `src/test-setup.ts`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ActivityErr,
  type ActivityOk,
  type CompensationCmd,
  type CompensationErr,
  type CompensationOk,
  createWorkflow,
  foldWorkflow,
  type WorkflowMsg,
  type WorkflowState,
  type WorkflowStep,
} from "./index";

type Activity = string;
type Result = string;
type Failure = string;

/** Three fully-reversible steps (each declares a compensation). */
const STEPS: readonly WorkflowStep<Activity>[] = [
  { name: "reserve", activity: "reserve-seat", compensation: "release-seat" },
  { name: "charge", activity: "charge-card", compensation: "refund-card" },
  { name: "ticket", activity: "issue-ticket", compensation: "void-ticket" },
];

function ok(id: number, result: Result): ActivityOk<Result> {
  return { type: "activity_ok", id, result };
}
function err(id: number, failure: Failure): ActivityErr<Failure> {
  return { type: "activity_err", id, failure };
}
function compOk(id: number): CompensationOk {
  return { type: "compensation_ok", id };
}
function compErr(id: number, failure: Failure): CompensationErr<Failure> {
  return { type: "compensation_err", id, failure };
}

/**
 * Drive a workflow forward, fail at `failAt`, then answer every emitted
 * compensation with success (unless `failCompAt` names a step whose
 * compensation should itself fail). Always answers the in-flight effect with its
 * own id. Returns the ordered Msg log (what a consumer persists + replays) and
 * the live final state. `guard` bounds the loop against a logic bug.
 */
function driveWithCompensation(
  steps: readonly WorkflowStep<Activity>[],
  failAt: number,
  failCompAt: number | null = null,
): {
  readonly msgs: WorkflowMsg<Result, Failure>[];
  readonly compCmdIndices: number[];
  readonly finalState: WorkflowState<Activity, Result, Failure>;
} {
  const wf = createWorkflow<Activity, Result, Failure>();
  let { state } = wf.init(steps);
  const msgs: WorkflowMsg<Result, Failure>[] = [];
  const compCmdIndices: number[] = [];

  let guard = 0;
  while (
    (state.status === "running" || state.status === "compensating") &&
    guard++ < 200
  ) {
    if (state.status === "running") {
      const { id, index } = state.current;
      if (index === failAt) {
        const m = err(id, `fail@${index}`);
        msgs.push(m);
        state = wf.onActivityErr(state, m).state;
      } else {
        const m = ok(id, `result@${index}`);
        msgs.push(m);
        state = wf.onActivityOk(state, m).state;
      }
    } else {
      // compensating — record which step the in-flight compensation undoes.
      const { id, index } = state.current;
      compCmdIndices.push(index);
      if (failCompAt !== null && index === failCompAt) {
        const m = compErr(id, `comp-fail@${index}`);
        msgs.push(m);
        state = wf.onCompensationErr(state, m).state;
      } else {
        const m = compOk(id);
        msgs.push(m);
        state = wf.onCompensationOk(state, m).state;
      }
    }
  }

  return {
    msgs,
    compCmdIndices,
    finalState: foldWorkflow<Activity, Result, Failure>(steps, msgs),
  };
}

// ───────────────────────────────────────────────────────────────────────────
describe("reverse-order compensation (#125 AC1)", () => {
  it("completed [s0,s1,s2], fail step 3 → compensations emitted s2, s1, s0", () => {
    // Four steps: 0,1,2 complete, step 3 fails. The reverse walk must undo
    // 2, then 1, then 0 — strict reverse of completion order.
    const four: readonly WorkflowStep<Activity>[] = [
      ...STEPS,
      { name: "notify", activity: "notify", compensation: "un-notify" },
    ];
    const wf = createWorkflow<Activity, Result, Failure>();
    let state = wf.init(four).state;

    // Complete steps 0,1,2.
    for (let i = 0; i < 3; i++) {
      if (state.status !== "running") throw new Error("expected running");
      state = wf.onActivityOk(state, ok(state.current.id, `r${i}`)).state;
    }
    // Fail step 3 → pivot to compensating, first compensation is step 2's.
    if (state.status !== "running") throw new Error("expected running");
    const pivot = wf.onActivityErr(state, err(state.current.id, "boom"));
    expect(pivot.state.status).toBe("compensating");
    if (pivot.state.status !== "compensating") throw new Error("unreachable");
    expect(pivot.state.current.index).toBe(2);
    expect(pivot.cmds).toHaveLength(1);
    expect(pivot.cmds[0].type).toBe("workflow_compensation");
    expect((pivot.cmds[0] as CompensationCmd<Activity>).compensation).toBe(
      "void-ticket",
    );
    expect(pivot.state.failedStep).toEqual(four[3]);

    // Confirm the rest and assert the emitted order is exactly [2, 1, 0].
    const emitted: number[] = [2];
    state = pivot.state;
    while (state.status === "compensating") {
      const step = wf.onCompensationOk(state, compOk(state.current.id));
      state = step.state;
      if (state.status === "compensating") emitted.push(state.current.index);
    }
    expect(emitted).toEqual([2, 1, 0]);
    expect(state.status).toBe("failed_compensated");
  });

  it("PBT: the compensation order is the strict reverse of the compensable completed steps", () => {
    fc.assert(
      fc.property(
        // 2..6 steps each independently reversible-or-not; fail the last one.
        fc.array(fc.boolean(), { minLength: 2, maxLength: 6 }),
        (reversible) => {
          const steps: readonly WorkflowStep<Activity>[] = reversible.map(
            (rev, i) => ({
              name: `s${i}`,
              activity: `do${i}`,
              ...(rev ? { compensation: `undo${i}` } : {}),
            }),
          );
          const failAt = steps.length - 1;
          const { compCmdIndices, finalState } = driveWithCompensation(
            steps,
            failAt,
          );
          // Expected: indices of completed (0..failAt-1) steps that declare a
          // compensation, in strict reverse order.
          const expected: number[] = [];
          for (let i = failAt - 1; i >= 0; i--) {
            if (reversible[i]) expected.push(i);
          }
          expect(compCmdIndices).toEqual(expected);
          // Settles failed_compensated iff at least one compensation ran,
          // else failed (empty rollback).
          expect(finalState.status).toBe(
            expected.length > 0 ? "failed_compensated" : "failed",
          );
        },
      ),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("each compensation is a durable owed effect (#125 AC2)", () => {
  it("a compensation is owed BEFORE its dispatch Cmd, confirmed on its result", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    let state = wf.init(STEPS).state;
    if (state.status !== "running") throw new Error("expected running");
    state = wf.onActivityOk(state, ok(state.current.id, "r0")).state; // s0 done
    if (state.status !== "running") throw new Error("expected running");

    // Fail s1 → pivot. Ledger owes the compensation for s0; the Cmd carries the
    // same id; owed precedes dispatch in the ledger array.
    const pivot = wf.onActivityErr(state, err(state.current.id, "boom"));
    const owed = pivot.ledger.filter((e) => e.type === "effect_owed");
    expect(owed).toHaveLength(1);
    expect(pivot.cmds).toHaveLength(1);
    expect((owed[0] as { id: number }).id).toBe(pivot.cmds[0].id);
    expect((owed[0] as { effect: unknown }).effect).toEqual(pivot.cmds[0]);

    // On the compensation result, the same id is confirmed.
    if (pivot.state.status !== "compensating") throw new Error("unreachable");
    const compId = pivot.state.current.id;
    const settled = wf.onCompensationOk(pivot.state, compOk(compId));
    const confirms = settled.ledger.filter(
      (e) => e.type === "effect_confirmed",
    );
    expect(confirms).toHaveLength(1);
    expect((confirms[0] as { id: number }).id).toBe(compId);
  });

  it("eviction mid-rollback: the owed compensation re-fires with the SAME id; a duplicate result is a no-op", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    const started = wf.init(STEPS);
    let live = started.state;
    // Accumulate the full persisted ledger log as a host would.
    let allEvents = [...started.ledger];

    // s0, s1 complete.
    for (let i = 0; i < 2; i++) {
      if (live.status !== "running") throw new Error("expected running");
      const step = wf.onActivityOk(live, ok(live.current.id, `r${i}`));
      allEvents = [...allEvents, ...step.ledger];
      live = step.state;
    }
    // s2 fails → pivot to compensating, first compensation (s1) owed.
    if (live.status !== "running") throw new Error("expected running");
    const pivot = wf.onActivityErr(live, err(live.current.id, "boom"));
    allEvents = [...allEvents, ...pivot.ledger];
    live = pivot.state;
    if (live.status !== "compensating") throw new Error("unreachable");
    const compCmd = pivot.cmds[0];

    // COLD WAKE mid-rollback: the compensation is owed but unconfirmed (its
    // result was never persisted). The surviving dispatch re-fires identically.
    const survivors = wf.survivingActivities(allEvents);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toEqual(compCmd);
    expect(survivors[0].type).toBe("workflow_compensation");

    // Confirm once, then a duplicate (re-emitted) compensation result is a
    // no-op: state unchanged, no effects.
    const advanced = wf.onCompensationOk(live, compOk(live.current.id));
    const dup = wf.onCompensationOk(advanced.state, compOk(compCmd.id));
    expect(dup.state).toBe(advanced.state);
    expect(dup.ledger).toEqual([]);
    expect(dup.cmds).toEqual([]);
  });

  it("PBT: across a full failure+compensation sequence, at most ONE effect is owed-but-unconfirmed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (n) => {
        const steps: readonly WorkflowStep<Activity>[] = Array.from(
          { length: n },
          (_, i) => ({
            name: `s${i}`,
            activity: `do${i}`,
            compensation: `undo${i}`,
          }),
        );
        const wf = createWorkflow<Activity, Result, Failure>();
        const started = wf.init(steps);
        let state = started.state;
        let log = [...started.ledger];
        expect(wf.survivingActivities(log)).toHaveLength(1);

        const failAt = n - 1;
        while (state.status === "running") {
          const { id, index } = state.current;
          const step =
            index === failAt
              ? wf.onActivityErr(state, err(id, "x"))
              : wf.onActivityOk(state, ok(id, "r"));
          log = [...log, ...step.ledger];
          state = step.state;
          const surviving = wf.survivingActivities(log).length;
          expect(surviving === 0 || surviving === 1).toBe(true);
        }
        while (state.status === "compensating") {
          const step = wf.onCompensationOk(state, compOk(state.current.id));
          log = [...log, ...step.ledger];
          state = step.state;
          const surviving = wf.survivingActivities(log).length;
          expect(surviving === 0 || surviving === 1).toBe(true);
        }
        // Fully settled: nothing owed.
        expect(wf.survivingActivities(log)).toHaveLength(0);
        expect(state.status).toBe("failed_compensated");
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("empty rollback → failed directly (#125 AC3)", () => {
  it("failing the first activity (zero completed) settles `failed`, no compensation Cmd", () => {
    const wf = createWorkflow<Activity, Result, Failure>();
    const started = wf.init(STEPS);
    if (started.state.status !== "running") throw new Error("expected running");
    const step = wf.onActivityErr(
      started.state,
      err(started.state.current.id, "boom"),
    );
    expect(step.state.status).toBe("failed");
    expect(step.cmds).toEqual([]); // nothing to unwind
    if (step.state.status !== "failed") throw new Error("unreachable");
    expect(step.state.completed).toEqual([]);
    expect(step.state.failedStep).toEqual(STEPS[0]);
  });

  it("completed steps that declare NO compensation contribute nothing → `failed`", () => {
    // Two irreversible steps complete; the third fails. Nothing compensable.
    const irreversible: readonly WorkflowStep<Activity>[] = [
      { name: "a", activity: "send-email" },
      { name: "b", activity: "log-event" },
      { name: "c", activity: "charge" },
    ];
    const { finalState, compCmdIndices } = driveWithCompensation(
      irreversible,
      2,
    );
    expect(compCmdIndices).toEqual([]);
    expect(finalState.status).toBe("failed");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("compensating → failed_compensated settle", () => {
  it("all compensations confirm → terminal `failed_compensated`, no further effects", () => {
    const { finalState } = driveWithCompensation(STEPS, 2);
    expect(finalState.status).toBe("failed_compensated");
    if (finalState.status !== "failed_compensated")
      throw new Error("unreachable");
    // Two steps (0,1) completed before the failure; both compensated.
    expect(finalState.completed).toHaveLength(2);
    expect(finalState.failedStep).toEqual(STEPS[2]);
    expect(finalState.failure).toBe("fail@2");
    // Terminal: a late activity result is a no-op.
    const wf = createWorkflow<Activity, Result, Failure>();
    const lateOk = wf.onActivityOk(finalState, ok(999, "late"));
    expect(lateOk.state).toBe(finalState);
    expect(lateOk.cmds).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("a compensation itself fails → compensation_failed terminal", () => {
  it("the rollback halts; `compensated` is intact, the bounced step + failure surfaced", () => {
    // s0, s1 complete; s2 fails → compensate s1 (ok), then s0's compensation
    // itself FAILS. Terminal compensation_failed.
    const { finalState } = driveWithCompensation(STEPS, 2, /*failCompAt*/ 0);
    expect(finalState.status).toBe("compensation_failed");
    if (finalState.status !== "compensation_failed")
      throw new Error("unreachable");
    // s1 was rolled back before s0's compensation bounced.
    expect(finalState.compensated.map((c) => c.step)).toEqual([STEPS[1]]);
    expect(finalState.failedCompensationStep).toEqual(STEPS[0]);
    expect(finalState.compensationFailure).toBe("comp-fail@0");
    // The forward failure is preserved, distinct from the compensation failure.
    expect(finalState.failure).toBe("fail@2");
    expect(finalState.failedStep).toEqual(STEPS[2]);
  });

  it("compensation_failed is terminal — a late compensation result is a no-op (never re-pivots)", () => {
    const { finalState } = driveWithCompensation(STEPS, 2, 0);
    const wf = createWorkflow<Activity, Result, Failure>();
    const late = wf.onCompensationOk(finalState, compOk(1));
    expect(late.state).toBe(finalState);
    expect(late.cmds).toEqual([]);
  });

  it("the FIRST compensation failing halts immediately with nothing compensated", () => {
    // s0,s1 complete; s2 fails → first compensation (s1) itself fails.
    const { finalState } = driveWithCompensation(STEPS, 2, /*failCompAt*/ 1);
    expect(finalState.status).toBe("compensation_failed");
    if (finalState.status !== "compensation_failed")
      throw new Error("unreachable");
    expect(finalState.compensated).toEqual([]);
    expect(finalState.failedCompensationStep).toEqual(STEPS[1]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("replay byte-identity across failure+compensation (#125 AC4)", () => {
  it("two replays of a failure+compensation Msg log are deeply-equal + JSON-identical", () => {
    const { msgs } = driveWithCompensation(STEPS, 2);
    const a = foldWorkflow<Activity, Result, Failure>(STEPS, msgs);
    const b = foldWorkflow<Activity, Result, Failure>(STEPS, msgs);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.status).toBe("failed_compensated");
  });

  it("cold-wake == never-evicted: re-folding mid-rollback matches the live state", () => {
    // Drive to mid-compensation, then replay the persisted Msg log so far.
    const wf = createWorkflow<Activity, Result, Failure>();
    let state = wf.init(STEPS).state;
    const msgs: WorkflowMsg<Result, Failure>[] = [];
    // s0, s1 done; s2 fail; compensate s1 (one undo), then stop mid-rollback.
    for (let i = 0; i < 2; i++) {
      if (state.status !== "running") throw new Error("expected running");
      const m = ok(state.current.id, `r${i}`);
      msgs.push(m);
      state = wf.onActivityOk(state, m).state;
    }
    if (state.status !== "running") throw new Error("expected running");
    const f = err(state.current.id, "boom");
    msgs.push(f);
    state = wf.onActivityErr(state, f).state;
    if (state.status !== "compensating") throw new Error("expected comp");
    const c = compOk(state.current.id);
    msgs.push(c);
    state = wf.onCompensationOk(state, c).state;

    const rebuilt = foldWorkflow<Activity, Result, Failure>(STEPS, msgs);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(state));
    expect(rebuilt.status).toBe("compensating");
  });

  it("PBT: replay is byte-identical for any reversibility profile + any failure point", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
        fc.nat(),
        fc.option(fc.nat(), { nil: null }),
        (reversible, rawFailAt, rawFailCompAt) => {
          const steps: readonly WorkflowStep<Activity>[] = reversible.map(
            (rev, i) => ({
              name: `s${i}`,
              activity: `do${i}`,
              ...(rev ? { compensation: `undo${i}` } : {}),
            }),
          );
          const failAt = rawFailAt % steps.length;
          // failCompAt: pick a completed compensable step's index, or null.
          const failCompAt =
            rawFailCompAt === null ? null : rawFailCompAt % steps.length;
          const { msgs } = driveWithCompensation(steps, failAt, failCompAt);
          const a = foldWorkflow<Activity, Result, Failure>(steps, msgs);
          const b = foldWorkflow<Activity, Result, Failure>(steps, msgs);
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
          // Terminal in one of the failure-path states (or completed if failAt
          // is unreachable because an earlier compensation failed — but here
          // failAt is always reached first since it fails forward).
          expect(
            ["failed", "failed_compensated", "compensation_failed"].includes(
              a.status,
            ),
          ).toBe(true);
        },
      ),
    );
  });
});
