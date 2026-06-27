/**
 * `reconcile(machine, authoritativeState, lastAppliedSeq, pending)` — the
 * client prediction/reconciliation helper (#214, epic #186).
 *
 * The payoff of the prediction epic: it generalizes the Gambetta/Valve
 * authoritative-server loop vortex hand-rolled. Given the latest authoritative
 * snapshot, the server's `lastAppliedSeq` ack, and the client's buffer of
 * seq-tagged pending inputs, it drops the inputs the server has already applied
 * (`seq <= lastAppliedSeq`) and replays ONLY the un-acked tail
 * (`seq > lastAppliedSeq`) over the authoritative state — yielding the corrected
 * predicted state.
 *
 * It is composed, not re-derived: the drop is `partitionByAck` (#212) and the
 * replay is `foldMsgs` (#211, `@demlik/tea/pure`) — no second copy of the
 * partition, no second copy of the fold.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, foldMsgs, type Reducer } from "../index";
import { ack, reconcile, type SeqTagged, tagSeq } from "./index";

// A counter whose every Msg adds a delta — a stand-in for any client-predicted
// command. Order-sensitive enough to prove the replay tail is folded, simple
// enough to compute the expected state by hand.
type CounterState = { readonly count: number };
type CounterMsg = { readonly type: "add"; readonly n: number };
const add = (n: number): CounterMsg => ({ type: "add", n });

function counterMachine() {
  const update: Reducer<CounterState, CounterMsg, never> = {
    add: (s, m) => [{ count: s.count + m.n }, []],
  };
  return defineMachine<CounterState, CounterMsg, never, never, undefined>({
    init: () => [{ count: 0 }, []],
    update,
  });
}

// A seq-ordered buffer: seq = index + 1, value carries the delta.
const bufOf = (deltas: readonly number[]): readonly SeqTagged<CounterMsg>[] =>
  deltas.map((n, i) => tagSeq(i + 1, add(n)));

describe("reconcile", () => {
  const m = counterMachine();

  it("replays only the un-acked tail (seq > lastAppliedSeq) over the authoritative state", () => {
    const auth: CounterState = { count: 100 };
    const buffer = bufOf([1, 10, 100]); // seqs 1,2,3
    // ack 1 → drop seq 1, replay seqs 2 & 3 → 100 + 10 + 100
    expect(reconcile(m, auth, ack(1), buffer)).toEqual({ count: 210 });
  });

  it("drops inputs with seq <= lastAppliedSeq before replay", () => {
    const auth: CounterState = { count: 0 };
    const buffer = bufOf([5, 5, 5, 5]); // seqs 1..4
    // ack 2 → only seqs 3 & 4 replay → 0 + 5 + 5
    expect(reconcile(m, auth, ack(2), buffer)).toEqual({ count: 10 });
  });

  it("accepts a bare lastAppliedSeq number equivalently to an Ack", () => {
    const auth: CounterState = { count: 7 };
    const buffer = bufOf([1, 2, 3]);
    expect(reconcile(m, auth, 1, buffer)).toEqual(
      reconcile(m, auth, ack(1), buffer),
    );
  });

  it("returns the authoritative state unchanged when the buffer is empty", () => {
    const auth: CounterState = { count: 42 };
    expect(reconcile(m, auth, ack(0), [])).toEqual(auth);
  });

  // ── Convergence properties (AC3) ──

  it("property: no pending inputs ⇒ result equals the authoritative state", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.integer({ min: -50, max: 50 })),
        (authCount, deltas) => {
          const auth: CounterState = { count: authCount };
          const buffer = bufOf(deltas);
          // ack at/above the highest seq ⇒ every input acked ⇒ nothing to replay
          const allAcked = ack(deltas.length);
          expect(reconcile(m, auth, allAcked, buffer)).toEqual(auth);
        },
      ),
    );
  });

  it("property: reconciling is idempotent given the same inputs (referentially transparent)", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.integer({ min: -50, max: 50 })),
        fc.nat(),
        (authCount, deltas, lastSeq) => {
          const auth: CounterState = { count: authCount };
          const buffer = bufOf(deltas);
          const once = reconcile(m, auth, ack(lastSeq), buffer);
          const twice = reconcile(m, auth, ack(lastSeq), buffer);
          expect(twice).toEqual(once);
        },
      ),
    );
  });

  it("property: replaying-all-then-acking-all equals the authoritative state", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1 }),
        (authCount, deltas) => {
          const auth: CounterState = { count: authCount };
          const buffer = bufOf(deltas);
          const maxSeq = deltas.length; // highest seq present
          expect(reconcile(m, auth, ack(maxSeq), buffer)).toEqual(auth);
        },
      ),
    );
  });

  it("property: server-applied-prefix + reconciled-suffix == full client prediction (the Gambetta convergence)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.array(fc.integer({ min: -50, max: 50 })),
        fc.nat(),
        (baseCount, deltas, ackRaw) => {
          const base: CounterState = { count: baseCount };
          const buffer = bufOf(deltas);
          // server acked the prefix seqs <= k; authoritative = fold of that prefix
          const k = deltas.length === 0 ? 0 : ackRaw % (deltas.length + 1);
          const ackedMsgs = buffer
            .filter((t) => t.seq <= k)
            .map((t) => t.value);
          const authoritative = foldMsgs(m, base, ackedMsgs);
          // reconciling the authoritative snapshot against the same ack and the
          // full buffer must reproduce the client's full prediction over base
          const fullPredict = foldMsgs(
            m,
            base,
            buffer.map((t) => t.value),
          );
          expect(reconcile(m, authoritative, ack(k), buffer)).toEqual(
            fullPredict,
          );
        },
      ),
    );
  });
});
