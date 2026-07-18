/**
 * Cockatiel timeout test vectors (T1–T6) ported against tea's `deadline` Sub.
 *
 * Source canon: `.patterns/cockatiel/timeout-vectors.md` (cockatiel
 * `src/TimeoutPolicy.test.ts`). ADR rationale:
 * `.decisions/0001-no-offtheshelf-resilience.md`, consequence #1 —
 * tea reuses cockatiel's battle-tested timeout EDGE CASES without cloning
 * cockatiel.
 *
 * This brick is deliberately LOWER-yield than the breaker/retry ports: several
 * cockatiel timeout behaviors live at the EFFECT BOUNDARY (AbortSignal,
 * abort-on-return, listener accounting, parent-signal linking), which have no
 * pure-reducer / Sub counterpart in tea. Those are flagged as `it.todo` GAPs
 * below rather than force-fit into a Sub test.
 *
 * What tea's `deadline` Sub models is the RACE OUTCOME — fire vs. resolve-first
 * — against an ABSOLUTE `atMs`. cockatiel arms a RELATIVE countdown at execute
 * time; to replay a `timeout(ms)` here, set `atMs = subscribeTime + ms`.
 *
 * Relationship to `index.test.ts`: T3 (past deadline → next tick) and T4 (late
 * subscribe recomputes from current clock) are tea-NATIVE invariants and are
 * ALREADY covered there. This file PORTS the cockatiel-derived race vectors T1
 * and T2 (which `index.test.ts` does not frame as cockatiel ports), and adds
 * cross-reference assertions for T3/T4 that re-pin the cockatiel-relevant edge
 * (no synchronous dispatch; absolute target survives a late subscribe) WITHOUT
 * duplicating the native tests — see the comments on each.
 *
 * Style matches `index.test.ts`: vitest fake timers (`vi.useFakeTimers()` /
 * `vi.setSystemTime` / `vi.advanceTimersByTime`) so the absolute-deadline
 * arithmetic is deterministic without injecting a clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeadlineExceeded,
  deadlineExceeded,
  deadlineSub,
  subscribeDeadline,
} from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// A base wall-clock instant so `atMs` targets are readable epoch numbers,
// matching `index.test.ts`.
const BASE = 1_000_000;

describe("cockatiel timeout vectors → tea deadline", () => {
  // ───────────────────────────────────────────────────────────────────────
  // T1 — no timeout: the guarded work finishes before the deadline.
  //
  // cockatiel `it('works when no timeout happens')`:
  //   const policy = timeout(1000, TimeoutStrategy.Cooperative);
  //   expect(await policy.execute(() => 42)).to.equal(42);  // fast fn, no fire
  //
  // tea replay: the "work finished" signal is the consumer DROPPING the Sub
  // from `subscriptions(state)`, which makes the reconcile pass run the
  // cleanup — clearing the pending timer before `atMs`. We model that here by
  // invoking the cleanup the subscribe cell returns, then advancing the clock
  // well past `atMs`. Assert `deadline_exceeded` is NEVER dispatched.
  // ───────────────────────────────────────────────────────────────────────
  describe("T1 — fast work, deadline never fires", () => {
    it("does not dispatch when the Sub is dropped before atMs (work resolved first)", () => {
      vi.setSystemTime(BASE);
      const dispatched: DeadlineExceeded[] = [];
      // timeout(1000) ⇒ atMs = subscribeTime + 1000.
      const sub = deadlineSub("t", BASE + 1000);

      const cleanup = subscribeDeadline(sub, undefined, (m) =>
        dispatched.push(m),
      );

      // Work resolves at now + ε (ε < 1000): consumer drops the Sub, reconcile
      // clears the timer. We advance just shy of the deadline first to prove
      // nothing has fired, then disarm.
      vi.advanceTimersByTime(999);
      expect(dispatched).toEqual([]);

      cleanup(); // the Sub left subscriptions(state) — timer is cleared.

      // Push the clock far past the original atMs: still no fire.
      vi.advanceTimersByTime(10_000);
      expect(dispatched).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // T2 — deadline crosses: the timer fires (the core race).
  //
  // cockatiel `it('emits a timeout event (aggressive)')` — fn slower than the
  // timeout ⇒ rejects with TaskCancelledError, onTimeout/onFailure called.
  // cockatiel `it('emits a timeout event (cooperative)')` — fires the timeout
  // event but STILL returns the eventual value (slow call allowed to finish).
  //
  // INTENTIONAL DIVERGENCE: tea has NO Cooperative/Aggressive split. The
  // `deadline` Sub always fires `deadline_exceeded` when the wall clock crosses
  // `atMs`; what the consumer does with the still-in-flight work (abort it vs.
  // let it finish and join the late value) is a CONSUMER REDUCER choice, not
  // the Sub's. So tea ports the FIRE semantics — equivalent to cockatiel's
  // Aggressive "timer fires regardless". The Cooperative "fire-but-still-
  // succeed" half is the consumer-side join and is flagged out-of-scope below.
  // ───────────────────────────────────────────────────────────────────────
  describe("T2 — deadline crosses, fires exactly once", () => {
    it("dispatches exactly one deadline_exceeded when the clock crosses atMs (Aggressive fire semantics)", () => {
      vi.setSystemTime(BASE);
      const dispatched: DeadlineExceeded[] = [];
      // timeout(2) ⇒ atMs = BASE + 2. The "work" (never resolved here) is
      // slower than the deadline, so the deadline must win the race.
      const sub = deadlineSub("t", BASE + 2);

      subscribeDeadline(sub, undefined, (m) => dispatched.push(m));

      // Just before: the race is still open, nothing fired.
      vi.advanceTimersByTime(1);
      expect(dispatched).toEqual([]);

      // Cross atMs: the deadline fires.
      vi.advanceTimersByTime(1);
      expect(dispatched).toEqual([deadlineExceeded("t", BASE + 2)]);

      // Exactly once — no double-fire as the clock keeps moving (the timer is
      // one-shot; cockatiel's onTimeout is likewise called once).
      vi.advanceTimersByTime(10_000);
      expect(dispatched).toHaveLength(1);
    });

    // cockatiel's Cooperative strategy fires the timeout event AND still
    // surfaces the eventual value. tea has no such split: the Sub fires, and
    // joining the late value is the consumer's reducer choice (let-finish vs.
    // abort), which lives at the effect boundary, not in the Sub. No verb to
    // port. See `.patterns/cockatiel/gaps.md` G-TO1.
    it.todo(
      "T2-coop: fire-but-still-succeed — GAP (no Cooperative/Aggressive split; consumer-side join at effect boundary), see gaps.md G-TO1",
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // T3 — past deadline fires on the NEXT tick, not synchronously.
  //
  // ALREADY COVERED in `index.test.ts`:
  //   it("a deadline already in the past fires on the NEXT tick, not
  //       synchronously")
  // That native test pins the invariant directly (remainingMs clamps to 0 ⇒
  // setTimeout(fn, 0) ⇒ async next-tick fire). We DO NOT duplicate it. The
  // cross-reference assertion below re-pins only the cockatiel-relevant edge
  // the port cares about: NO dispatch happens synchronously inside the
  // subscribe/reconcile call itself — even for an already-expired deadline.
  // ───────────────────────────────────────────────────────────────────────
  describe("T3 — past deadline → next tick (cross-ref: covered in index.test.ts)", () => {
    it("never dispatches synchronously inside subscribe, even for a deadline already in the past", () => {
      vi.setSystemTime(BASE);
      const dispatched: DeadlineExceeded[] = [];
      // atMs 5s in the PAST — the degenerate race cockatiel arms with
      // setTimeout; tea clamps remainingMs to 0.
      const sub = deadlineSub("t", BASE - 5000);

      subscribeDeadline(sub, undefined, (m) => dispatched.push(m));

      // The substrate must finish wiring all subs before any Msg lands: the
      // dispatch is NOT synchronous, even though the deadline is already past.
      expect(dispatched).toEqual([]);

      // A single tick of the (delay-0) timer lands exactly one dispatch.
      vi.advanceTimersByTime(0);
      expect(dispatched).toEqual([deadlineExceeded("t", BASE - 5000)]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // T4 — late subscribe after rehydrate fires at the correct ABSOLUTE moment.
  //
  // ALREADY COVERED in `index.test.ts`:
  //   it("recomputes remaining delay from the current clock (late subscribe
  //       still hits the absolute target)")
  // tea's key differentiator over cockatiel: cockatiel's RELATIVE timeout would
  // re-arm a fresh full countdown on resume and MIS-FIRE; tea recomputes
  // `remainingMs = atMs - now` from the current clock, so it fires at the right
  // absolute instant. We don't duplicate the native test; the cross-reference
  // below makes the cockatiel-vs-tea contrast explicit and load-bearing — it
  // proves the deadline fires at the ABSOLUTE T, NOT at now + (original full
  // span), which is exactly where a naive relative re-arm would mis-fire.
  // ───────────────────────────────────────────────────────────────────────
  describe("T4 — late subscribe / rehydrate (cross-ref: covered in index.test.ts)", () => {
    it("fires at the absolute target on a late subscribe, not at now + the original full span", () => {
      // Scenario: a 5s deadline was set at BASE (atMs = BASE + 5000). The page
      // reloaded and the machine resumed (subscribed) 3s later, at BASE + 3000.
      const atMs = BASE + 5000;
      const ORIGINAL_FULL_SPAN = 5000;
      vi.setSystemTime(BASE + 3000); // late subscribe, 3s after the deadline was set
      const dispatched: DeadlineExceeded[] = [];
      const sub = deadlineSub("guard", atMs);

      subscribeDeadline(sub, undefined, (m) => dispatched.push(m));

      // A naive RELATIVE re-arm (cockatiel's failure mode) would fire only
      // after the ORIGINAL full span from NOW — i.e. at BASE + 3000 + 5000.
      // Advance to just past the absolute target (remaining = 2000) but still
      // well short of that naive relative point: tea MUST have fired already.
      vi.advanceTimersByTime(2000);
      expect(dispatched).toEqual([deadlineExceeded("guard", atMs)]);

      // Sanity: the absolute fire (at +2000) happened strictly BEFORE the
      // naive relative re-arm would have (at +5000), proving recompute-from-
      // current-clock, not re-arm-full-span.
      expect(2000).toBeLessThan(ORIGINAL_FULL_SPAN);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // OUT-OF-SCOPE / EFFECT-BOUNDARY VECTORS — flagged, not force-fit.
  // These have NO pure-reducer / Sub counterpart in tea. The Sub lifecycle's
  // `clearTimeout` cleanup (exercised by T1 above) is the only structural
  // analogue of "don't leak", but signal abort + listener accounting + parent
  // linking live entirely at cockatiel's effect boundary. See
  // `.patterns/cockatiel/gaps.md` G-TO2.
  // ───────────────────────────────────────────────────────────────────────
  describe("out-of-scope (effect boundary) — flagged GAPs", () => {
    it.todo(
      "T5: abort-on-return — GAP (effect boundary; tea Sub has no AbortSignal), see gaps.md G-TO2",
    );
    it.todo(
      "T5: does-not-leak-abort-listeners (#81) — GAP (effect boundary; tea's timer-leak analogue is the dropped-Sub cleanup, covered by T1), see gaps.md G-TO2",
    );
    it.todo(
      "T6: parent cancellation links through — GAP (signal composition at effect boundary; the own-deadline-still-fires half IS T2 and is ported above), see gaps.md G-TO2",
    );
  });
});
