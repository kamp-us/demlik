import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine } from "../index";
import { bindMachine } from "../testing";
import {
  createSaga,
  initSaga,
  isAborted,
  isCommitted,
  isCompensationFailed,
  isSettled,
  type SagaState,
} from "./index";

// === Fixtures ===
//
// A three-step booking saga: book a flight, charge the card, reserve a hotel.
// Each forward Cmd has a matching compensating Cmd. The Cmds carry no payload
// beyond their tag — the saga drives ORDER, not data, so a plain `type` is
// enough to assert which step's effect was emitted.
type Forward = Cmd<"book_flight"> | Cmd<"charge_card"> | Cmd<"reserve_hotel">;
type Undo = Cmd<"cancel_flight"> | Cmd<"refund_card"> | Cmd<"release_hotel">;

const bookFlight: Forward = { type: "book_flight" };
const chargeCard: Forward = { type: "charge_card" };
const reserveHotel: Forward = { type: "reserve_hotel" };
const cancelFlight: Undo = { type: "cancel_flight" };
const refundCard: Undo = { type: "refund_card" };
const releaseHotel: Undo = { type: "release_hotel" };

const threeSteps = {
  steps: [
    { do: bookFlight, undo: cancelFlight },
    { do: chargeCard, undo: refundCard },
    { do: reserveHotel, undo: releaseHotel },
  ],
} as const;

/** The status of every ledger record, in step order — for partition assertions. */
function statuses(state: SagaState): string[] {
  return state.items.map((i) => i.status);
}

describe("initSaga / createSaga shape", () => {
  it("starts idle with an empty ledger and no compensation log", () => {
    const s = initSaga();
    expect(s).toEqual({
      position: 0,
      done: [],
      compensating: false,
      phase: "idle",
      items: [],
    });
    expect(isSettled(s)).toBe(false);
  });

  it("exposes the uniform combinator contract (init + five verbs + derived reads)", () => {
    const saga = createSaga(threeSteps);
    expect(typeof saga.init).toBe("function");
    expect(typeof saga.start).toBe("function");
    expect(typeof saga.stepOk).toBe("function");
    expect(typeof saga.stepErr).toBe("function");
    expect(typeof saga.undoOk).toBe("function");
    expect(typeof saga.undoErr).toBe("function");
    expect(typeof saga.isCommitted).toBe("function");
    expect(typeof saga.isAborted).toBe("function");
    expect(typeof saga.isCompensationFailed).toBe("function");
    expect(typeof saga.isSettled).toBe("function");
    // Pure-ops module: no timers, no I/O ports.
    expect("subs" in saga).toBe(false);
    expect("handlers" in saga).toBe(false);
  });
});

describe("start — stamp the ledger and launch step 0", () => {
  it("marks step 0 running and emits its do Cmd", () => {
    const saga = createSaga(threeSteps);
    const [state, cmds] = saga.start(initSaga());

    expect(state.phase).toBe("running");
    expect(state.position).toBe(0);
    expect(cmds).toEqual([bookFlight]);
    expect(statuses(state)).toEqual(["running", "pending", "pending"]);
  });

  it("an empty saga commits immediately with no Cmd", () => {
    const saga = createSaga({ steps: [] });
    const [state, cmds] = saga.start(initSaga());
    expect(state.phase).toBe("committed");
    expect(isCommitted(state)).toBe(true);
    expect(cmds).toEqual([]);
  });

  it("re-start on an already-running saga is a no-op", () => {
    const saga = createSaga(threeSteps);
    const [s0] = saga.start(initSaga());
    const [s1, cmds] = saga.start(s0);
    expect(s1).toBe(s0);
    expect(cmds).toEqual([]);
  });

  it("does not mutate the input slice", () => {
    const saga = createSaga(threeSteps);
    const before = Object.freeze(initSaga());
    const [after] = saga.start(before);
    expect(before.phase).toBe("idle");
    expect(after).not.toBe(before);
  });
});

describe("stepOk — advance forward", () => {
  it("advances to the next step and emits its do Cmd", () => {
    const saga = createSaga(threeSteps);
    const [s0] = saga.start(initSaga());
    const [s1, cmds] = saga.stepOk(s0);

    expect(s1.phase).toBe("running");
    expect(s1.position).toBe(1);
    expect(s1.done).toEqual([0]);
    expect(cmds).toEqual([chargeCard]);
    expect(statuses(s1)).toEqual(["done", "running", "pending"]);
  });

  it("committing the last step transitions to committed with no Cmd", () => {
    const saga = createSaga(threeSteps);
    let [state] = saga.start(initSaga());
    [state] = saga.stepOk(state); // step 0 done → step 1 running
    [state] = saga.stepOk(state); // step 1 done → step 2 running
    const [final, cmds] = saga.stepOk(state); // step 2 done → committed

    expect(final.phase).toBe("committed");
    expect(isCommitted(final)).toBe(true);
    expect(final.done).toEqual([0, 1, 2]);
    expect(cmds).toEqual([]);
    expect(statuses(final)).toEqual(["done", "done", "done"]);
  });

  it("stepOk while not running is a no-op (stale success Msg)", () => {
    const saga = createSaga(threeSteps);
    const idle = initSaga();
    const [s0, cmds0] = saga.stepOk(idle); // idle → no-op
    expect(s0).toBe(idle); // returns its own input reference, untouched
    expect(cmds0).toEqual([]);

    let [state] = saga.start(initSaga());
    [state] = saga.stepErr(state, "boom"); // pivot to compensating
    const [s1, cmds1] = saga.stepOk(state); // not running → no-op
    expect(s1).toBe(state);
    expect(cmds1).toEqual([]);
  });
});

describe("stepErr — pivot into compensation", () => {
  it("the first step failing aborts immediately (nothing to undo)", () => {
    const saga = createSaga(threeSteps);
    const [s0] = saga.start(initSaga());
    const [state, cmds] = saga.stepErr(s0, "flight sold out");

    expect(state.phase).toBe("aborted");
    expect(isAborted(state)).toBe(true);
    expect(state.compensating).toBe(true);
    expect(state.error).toBe("flight sold out");
    expect(cmds).toEqual([]);
    expect(statuses(state)).toEqual(["failed", "pending", "pending"]);
  });

  it("a mid-saga failure compensates the most-recently-completed step first", () => {
    const saga = createSaga(threeSteps);
    let [state] = saga.start(initSaga()); // step 0 running
    [state] = saga.stepOk(state); // step 0 done, step 1 running
    const [comp, cmds] = saga.stepErr(state, "card declined"); // step 1 fails

    expect(comp.phase).toBe("compensating");
    expect(comp.compensating).toBe(true);
    expect(comp.error).toBe("card declined");
    // Compensation begins with step 0's undo (the only completed step).
    expect(comp.position).toBe(0);
    expect(cmds).toEqual([cancelFlight]);
    // Step 1 is failed; step 0 is still `done` (not yet rolled back).
    expect(statuses(comp)).toEqual(["done", "failed", "pending"]);
  });

  it("the last step failing rolls back in reverse order", () => {
    const saga = createSaga(threeSteps);
    let [state] = saga.start(initSaga());
    [state] = saga.stepOk(state); // 0 done
    [state] = saga.stepOk(state); // 1 done, 2 running
    const [comp, cmds] = saga.stepErr(state, "no rooms"); // step 2 fails

    // Most-recently-completed is step 1 → refund first.
    expect(comp.position).toBe(1);
    expect(cmds).toEqual([refundCard]);
    expect(comp.done).toEqual([0, 1]);
  });

  it("stepErr while not running is a no-op", () => {
    const saga = createSaga(threeSteps);
    let [state] = saga.start(initSaga());
    [state] = saga.stepErr(state, "first boom"); // first step → aborted
    const [s1, cmds] = saga.stepErr(state, "second boom"); // terminal → no-op
    expect(s1).toBe(state);
    expect(cmds).toEqual([]);
    expect(s1.error).toBe("first boom"); // original error stands
  });
});

describe("undoOk — drive the rollback in reverse", () => {
  it("emits the next undo in reverse until the log is empty", () => {
    const saga = createSaga(threeSteps);
    let [state] = saga.start(initSaga());
    [state] = saga.stepOk(state); // 0 done, 1 running
    [state] = saga.stepOk(state); // 1 done, 2 running
    [state] = saga.stepErr(state, "no rooms"); // 2 fails → compensating, refund first

    // First undo done: refund (step 1) → next undo cancel flight (step 0).
    const [u1, cmds1] = saga.undoOk(state);
    expect(u1.phase).toBe("compensating");
    expect(u1.position).toBe(0);
    expect(cmds1).toEqual([cancelFlight]);
    expect(u1.done).toEqual([0]);
    expect(statuses(u1)).toEqual(["done", "cancelled", "failed"]);

    // Second undo done: cancel flight → fully unwound → aborted.
    const [u2, cmds2] = saga.undoOk(u1);
    expect(u2.phase).toBe("aborted");
    expect(isAborted(u2)).toBe(true);
    expect(cmds2).toEqual([]);
    expect(u2.done).toEqual([]);
    expect(statuses(u2)).toEqual(["cancelled", "cancelled", "failed"]);
  });

  it("undoOk while not compensating is a no-op", () => {
    const saga = createSaga(threeSteps);
    const [s0] = saga.start(initSaga()); // running, not compensating
    const [s1, cmds] = saga.undoOk(s0);
    expect(s1).toBe(s0);
    expect(cmds).toEqual([]);
  });
});

describe("undoErr — a failing compensation becomes visible terminal state", () => {
  it("a failed undo settles compensation_failed, leaving the un-undone steps in the log", () => {
    const saga = createSaga(threeSteps);
    let [state] = saga.start(initSaga());
    [state] = saga.stepOk(state); // 0 done, 1 running
    [state] = saga.stepOk(state); // 1 done, 2 running
    [state] = saga.stepErr(state, "no rooms"); // 2 fails → compensating, refund (step 1) first
    expect(state.phase).toBe("compensating");
    expect(state.position).toBe(1);

    // The refund (step 1's undo) ITSELF fails — the bank bounced the refund.
    const [stuck, cmds] = saga.undoErr(state, "refund bounced");

    // Terminal, but NOT aborted: the rollback is unfinished.
    expect(stuck.phase).toBe("compensation_failed");
    expect(isCompensationFailed(stuck)).toBe(true);
    expect(isAborted(stuck)).toBe(false);
    expect(isSettled(stuck)).toBe(true);
    // No further Cmd: the saga halts, it does not keep emitting undos.
    expect(cmds).toEqual([]);

    // Both failures are visible and distinct.
    expect(stuck.error).toBe("no rooms"); // the forward failure that started rollback
    expect(stuck.compensationError).toBe("refund bounced"); // the undo that bounced

    // The log is LEFT INTACT — `undoErr` halts WITHOUT popping, so both step 1
    // (undo bounced) and step 0 (never attempted) remain in the log for hand
    // reconciliation. Step 1's undo failed so its record is `failed`, not
    // `cancelled`.
    expect(stuck.done).toEqual([0, 1]);
    // step0 still `done` (never rolled back), step1 `failed` (undo bounced), step2 `failed` (forward).
    expect(statuses(stuck)).toEqual(["done", "failed", "failed"]);
  });

  it("a failed undo at the LAST compensation step still settles compensation_failed", () => {
    const saga = createSaga(threeSteps);
    let [state] = saga.start(initSaga());
    [state] = saga.stepOk(state); // 0 done, 1 running
    [state] = saga.stepErr(state, "card declined"); // 1 fails → compensating, cancel (step 0)
    expect(state.position).toBe(0);

    // The only outstanding undo (cancel flight) fails.
    const [stuck, cmds] = saga.undoErr(state, "airline unreachable");
    expect(stuck.phase).toBe("compensation_failed");
    expect(stuck.compensationError).toBe("airline unreachable");
    expect(stuck.done).toEqual([0]); // step 0 still needs undoing by hand
    expect(statuses(stuck)).toEqual(["failed", "failed", "pending"]);
    expect(cmds).toEqual([]);
  });

  it("undoErr while not compensating is a no-op (stale undo-failure Msg)", () => {
    const saga = createSaga(threeSteps);

    // While running: not compensating → no-op.
    const [s0] = saga.start(initSaga());
    const [r0, c0] = saga.undoErr(s0, "late");
    expect(r0).toBe(s0);
    expect(c0).toEqual([]);

    // While idle: no-op.
    const idle = initSaga();
    const [r1, c1] = saga.undoErr(idle, "late");
    expect(r1).toBe(idle);
    expect(c1).toEqual([]);

    // After it already settled compensation_failed: a second undo-failure Msg
    // must not re-pivot the terminal saga.
    let [state] = saga.start(initSaga());
    [state] = saga.stepOk(state); // 0 done
    [state] = saga.stepErr(state, "boom"); // 1 fails → compensating
    const [settled] = saga.undoErr(state, "first bounce");
    const [r2, c2] = saga.undoErr(settled, "second bounce");
    expect(r2).toBe(settled);
    expect(c2).toEqual([]);
    expect(r2.compensationError).toBe("first bounce"); // original stands
  });
});

// === Machine-level integration ===
//
// The saga threaded through a real reducer, asserted with the testing helpers.
// The machine folds the verbs into a single saga slice; `replay` reconstructs
// the exact sequence the runtime would, pinning the knob's contract at the
// machine boundary (durable + replayable).
interface MachineState {
  readonly saga: SagaState;
}
type Msg =
  | { type: "begin" }
  | { type: "step_ok" }
  | { type: "step_err"; error: string }
  | { type: "undo_ok" }
  | { type: "undo_err"; error: string };

const machineSaga = createSaga(threeSteps);

function lift(
  s: MachineState,
  [saga, cmds]: readonly [SagaState, readonly (Forward | Undo)[]],
): readonly [MachineState, readonly (Forward | Undo)[]] {
  return [{ ...s, saga }, cmds];
}

const machine = defineMachine<
  MachineState,
  Msg,
  Forward | Undo,
  never,
  undefined
>({
  init: (loaded) =>
    loaded !== null ? [loaded, []] : [{ saga: initSaga() }, []],
  update: {
    begin: (s) => lift(s, machineSaga.start(s.saga)),
    step_ok: (s) => lift(s, machineSaga.stepOk(s.saga)),
    step_err: (s, m) => lift(s, machineSaga.stepErr(s.saga, m.error)),
    undo_ok: (s) => lift(s, machineSaga.undoOk(s.saga)),
    undo_err: (s, m) => lift(s, machineSaga.undoErr(s.saga, m.error)),
  },
  interpret: {
    // The do/undo effects are performed by the consumer; here they are inert
    // (replay never runs interpret). Declared to satisfy the exhaustive map.
    book_flight: async () => {},
    charge_card: async () => {},
    reserve_hotel: async () => {},
    cancel_flight: async () => {},
    refund_card: async () => {},
    release_hotel: async () => {},
  },
});

describe("machine integration", () => {
  const bound = bindMachine(machine, undefined);

  it("emits one do Cmd per forward step, in order, across a happy-path commit", () => {
    bound.expectCmdSequence(
      {
        msgs: [
          { type: "begin" },
          { type: "step_ok" },
          { type: "step_ok" },
          { type: "step_ok" },
        ],
      },
      [bookFlight, chargeCard, reserveHotel],
    );
  });

  it("drives the slice to committed on a full happy path", () => {
    const { state } = bound.replay({
      msgs: [
        { type: "begin" },
        { type: "step_ok" },
        { type: "step_ok" },
        { type: "step_ok" },
      ],
    });
    expect(state.saga.phase).toBe("committed");
    expect(state.saga.done).toEqual([0, 1, 2]);
  });

  it("compensates in reverse and aborts on a mid-saga failure", () => {
    const { state, cmds } = bound.replay({
      msgs: [
        { type: "begin" }, // book_flight
        { type: "step_ok" }, // step 0 done → charge_card
        { type: "step_ok" }, // step 1 done → reserve_hotel
        { type: "step_err", error: "no rooms" }, // step 2 fails → refund_card
        { type: "undo_ok" }, // refund done → cancel_flight
        { type: "undo_ok" }, // cancel done → aborted
      ],
    });

    expect(state.saga.phase).toBe("aborted");
    // Forward Cmds then compensating Cmds in reverse — refund (step 1) before
    // cancel (step 0).
    expect(cmds).toEqual([
      bookFlight,
      chargeCard,
      reserveHotel,
      refundCard,
      cancelFlight,
    ]);
  });

  it("halts in compensation_failed when an undo bounces mid-rollback", () => {
    const { state, cmds } = bound.replay({
      msgs: [
        { type: "begin" }, // book_flight
        { type: "step_ok" }, // step 0 done → charge_card
        { type: "step_ok" }, // step 1 done → reserve_hotel
        { type: "step_err", error: "no rooms" }, // step 2 fails → refund_card
        { type: "undo_err", error: "refund bounced" }, // refund fails → compensation_failed
        { type: "undo_ok" }, // stale Msg against a terminal saga → no-op
      ],
    });

    expect(state.saga.phase).toBe("compensation_failed");
    expect(state.saga.error).toBe("no rooms");
    expect(state.saga.compensationError).toBe("refund bounced");
    // The log is left intact: step 1 (undo bounced) and step 0 (never attempted)
    // both remain for hand reconciliation.
    expect(state.saga.done).toEqual([0, 1]);
    // The rollback emitted the refund Cmd, then nothing once it bounced — the
    // stale undo_ok produced no further Cmd.
    expect(cmds).toEqual([bookFlight, chargeCard, reserveHotel, refundCard]);
  });
});

// === Property tests ===
//
// Invariants the verbs must hold across ANY step count + any first-failure
// position. The model walks the saga forward, optionally fails at a chosen
// step, then drains the compensation, asserting the structural laws each time.

describe("saga invariants (property)", () => {
  const stepCount = fc.integer({ min: 1, max: 12 });

  /** Build an n-step saga whose do/undo Cmds tag their positional index. */
  function makeSaga(n: number) {
    const steps = Array.from({ length: n }, (_v, i) => ({
      do: { type: "do", i } as Cmd<"do"> & { i: number },
      undo: { type: "undo", i } as Cmd<"undo"> & { i: number },
    }));
    return createSaga({ steps });
  }

  it("a happy path emits every do Cmd in forward order, then commits", () => {
    fc.assert(
      fc.property(stepCount, (n) => {
        const saga = makeSaga(n);
        let [state, cmds] = saga.start(saga.init());
        const dos: number[] = cmds.map((c) => (c as { i: number }).i);

        while (state.phase === "running") {
          let stepCmds: readonly Cmd[];
          [state, stepCmds] = saga.stepOk(state);
          for (const c of stepCmds) dos.push((c as { i: number }).i);
        }

        expect(state.phase).toBe("committed");
        expect(state.done).toEqual(Array.from({ length: n }, (_v, i) => i));
        // Each step's `do` fired exactly once, in order 0..n-1.
        expect(dos).toEqual(Array.from({ length: n }, (_v, i) => i));
        return true;
      }),
    );
  });

  it("a failure at step k undoes exactly steps k-1..0, in reverse, then aborts", () => {
    fc.assert(
      fc.property(
        stepCount.chain((n) =>
          fc.tuple(fc.constant(n), fc.integer({ min: 0, max: n - 1 })),
        ),
        ([n, failAt]) => {
          const saga = makeSaga(n);
          let [state] = saga.start(saga.init());

          // Advance forward to `failAt`.
          for (let i = 0; i < failAt; i++) {
            [state] = saga.stepOk(state);
          }
          expect(state.position).toBe(failAt);

          // Fail the step at `failAt`.
          const stepErrResult = saga.stepErr(state, "boom");
          state = stepErrResult[0];
          const cmds = stepErrResult[1];
          expect(state.error).toBe("boom");

          const undos: number[] = cmds.map((c) => (c as { i: number }).i);
          // Drain compensation.
          while (state.phase === "compensating") {
            let stepCmds: readonly Cmd[];
            [state, stepCmds] = saga.undoOk(state);
            for (const c of stepCmds) undos.push((c as { i: number }).i);
          }

          // Terminal: always aborted, the compensation log fully drained.
          expect(state.phase).toBe("aborted");
          expect(isAborted(state)).toBe(true);
          expect(state.done).toEqual([]);

          // Undo order is exactly the completed prefix in reverse: failAt-1 .. 0.
          const expectedUndos = Array.from(
            { length: failAt },
            (_v, i) => failAt - 1 - i,
          );
          expect(undos).toEqual(expectedUndos);

          // The failed step's record is `failed`; every completed step is now
          // `cancelled`; steps never reached stay `pending`. Asserting the whole
          // status vector at once is both stronger and free of index assertions.
          const expectedStatuses = Array.from({ length: n }, (_v, i) => {
            if (i < failAt) return "cancelled";
            if (i === failAt) return "failed";
            return "pending";
          });
          expect(statuses(state)).toEqual(expectedStatuses);
          return true;
        },
      ),
    );
  });

  it("once settled, every verb is inert (no further Cmds, slice unchanged)", () => {
    fc.assert(
      fc.property(stepCount, fc.boolean(), (n, commit) => {
        const saga = makeSaga(n);
        let [state] = saga.start(saga.init());

        if (commit) {
          while (state.phase === "running") [state] = saga.stepOk(state);
        } else {
          // Fail step 0 immediately → aborted with nothing to undo.
          [state] = saga.stepErr(state, "boom");
        }
        expect(isSettled(state)).toBe(true);

        const terminal = state;
        for (const verb of [
          () => saga.start(terminal),
          () => saga.stepOk(terminal),
          () => saga.stepErr(terminal, "late"),
          () => saga.undoOk(terminal),
          () => saga.undoErr(terminal, "late"),
        ]) {
          const [s, cmds] = verb();
          expect(s).toBe(terminal);
          expect(cmds).toEqual([]);
        }
        return true;
      }),
    );
  });

  // === Durability guard (package-wide invariant) ===
  //
  // Every reachable TERMINAL slice must round-trip through JSON unchanged: a DO
  // eviction/reload reconstructs the slice via JSON.parse(JSON.stringify(...)),
  // and the resurrected slice must deep-equal what was saved. This is the
  // package's "Durable" canon; the saga carries its share for all three of its
  // terminal phases — committed, aborted, and compensation_failed. Errors must
  // therefore be plain-data sentinels (here plain strings), never Error objects
  // (which stringify to `{}` and carry a non-serializable stack).
  describe("every reachable terminal slice round-trips through JSON unchanged (durable)", () => {
    /** Drive a fresh n-step saga to one of its three terminal phases. */
    function driveToTerminal(
      n: number,
      kind: "committed" | "aborted" | "compensation_failed",
      failAt: number,
    ): SagaState {
      const saga = makeSaga(n);
      let [state] = saga.start(saga.init());

      if (kind === "committed") {
        while (state.phase === "running") [state] = saga.stepOk(state);
        return state;
      }

      // Advance forward to `failAt`, then fail the step there.
      for (let i = 0; i < failAt; i++) [state] = saga.stepOk(state);
      [state] = saga.stepErr(state, "forward boom");

      if (kind === "aborted") {
        // Drain the whole compensation successfully → fully unwound.
        while (state.phase === "compensating") [state] = saga.undoOk(state);
        return state;
      }

      // compensation_failed: if nothing completed forward, stepErr already
      // aborted (no undo to fail), so nudge `failAt` to guarantee a rollback,
      // then bounce the first undo.
      if (state.phase === "compensating") {
        [state] = saga.undoErr(state, "undo boom");
      }
      return state;
    }

    it("committed slices round-trip equal", () => {
      fc.assert(
        fc.property(stepCount, (n) => {
          const slice = driveToTerminal(n, "committed", 0);
          expect(slice.phase).toBe("committed");
          expect(JSON.parse(JSON.stringify(slice))).toEqual(slice);
          return true;
        }),
      );
    });

    it("aborted slices round-trip equal", () => {
      fc.assert(
        fc.property(
          stepCount.chain((n) =>
            fc.tuple(fc.constant(n), fc.integer({ min: 0, max: n - 1 })),
          ),
          ([n, failAt]) => {
            const slice = driveToTerminal(n, "aborted", failAt);
            expect(slice.phase).toBe("aborted");
            expect(JSON.parse(JSON.stringify(slice))).toEqual(slice);
            return true;
          },
        ),
      );
    });

    it("compensation_failed slices round-trip equal", () => {
      fc.assert(
        fc.property(
          // At least 2 steps and failAt ≥ 1 so a completed step exists to
          // compensate, guaranteeing the saga reaches `compensating` before the
          // undo bounces.
          fc
            .integer({ min: 2, max: 12 })
            .chain((n) =>
              fc.tuple(fc.constant(n), fc.integer({ min: 1, max: n - 1 })),
            ),
          ([n, failAt]) => {
            const slice = driveToTerminal(n, "compensation_failed", failAt);
            expect(slice.phase).toBe("compensation_failed");
            expect(isCompensationFailed(slice)).toBe(true);
            expect(JSON.parse(JSON.stringify(slice))).toEqual(slice);
            return true;
          },
        ),
      );
    });
  });
});
