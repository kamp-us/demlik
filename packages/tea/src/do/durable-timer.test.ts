/**
 * `durableTimer` (#180) — behavior tests over a FAKED alarm.
 *
 * The helper owns the eviction-safe alarm loop every native-DO grain hand-rolled
 * (raft's deadline, vortex's tick). These tests pin its BEHAVIOR, not its shape:
 *   - it arms the alarm at exactly the deadline `nextDeadline` computes;
 *   - it re-arms after a fire, off the now-advanced state;
 *   - it idles (arms nothing) when there is no work (`nextDeadline` → null);
 *   - it survives a simulated cold wake: a FRESH timer over a fresh alarm
 *     re-arms from the persisted state identically to a never-evicted one.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package's test files. The alarm is a
 * plain in-memory fake (no `cloudflare:workers`), exactly the DI seam the port
 * exists to give: a real `DurableObjectStorage` satisfies `AlarmStorage`
 * structurally, a test supplies this.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type AlarmStorage, durableTimer } from "./durable-timer";

// ── A fake alarm carrier: records every armed target, exposes the latest. ────
// Mirrors the one observable signal a DO alarm gives — the absolute time the
// next fire is scheduled for. `setAlarm` is the ONLY method the port needs.
function fakeAlarm(): AlarmStorage & {
  readonly calls: readonly number[];
  readonly armedAt: number | null;
} {
  const calls: number[] = [];
  return {
    setAlarm(scheduledTime: number) {
      calls.push(scheduledTime);
    },
    get calls() {
      return calls;
    },
    get armedAt() {
      return calls.length === 0 ? null : calls[calls.length - 1];
    },
  };
}

// ── A tiny grain state with a deterministic clock, so `nextDeadline` is a pure
// function of (state, now) exactly like raft's `node.subs(state, now())[0]`. ──
const PERIOD_MS = 56; // ~18 Hz, the vortex tick period

describe("durableTimer", () => {
  it("arms the alarm at exactly the deadline nextDeadline computes", async () => {
    const alarm = fakeAlarm();
    const now = 1_000;
    const timer = durableTimer({
      alarm,
      nextDeadline: () => now + PERIOD_MS,
      onFire: () => {},
    });

    await timer.rearm();

    expect(alarm.calls).toEqual([1_056]);
    expect(alarm.armedAt).toBe(1_056);
  });

  it("re-arms on a fire, off the now-advanced state, and runs the handler first", async () => {
    const alarm = fakeAlarm();
    let now = 1_000;
    const order: string[] = [];
    const timer = durableTimer({
      alarm,
      // Reads the LIVE clock each call, so the post-fire re-arm sees the new now.
      nextDeadline: () => {
        order.push(`compute@${now}`);
        return now + PERIOD_MS;
      },
      onFire: () => {
        order.push(`fire@${now}`);
        now += PERIOD_MS; // the fire advances wall-clock state
      },
    });

    await timer.rearm(); // initial arm at 1056
    await timer.onAlarm(); // fire at 1000→1056, then re-arm at 1112

    // The fire runs BEFORE the re-arm, and the re-arm uses the advanced clock.
    expect(order).toEqual(["compute@1000", "fire@1000", "compute@1056"]);
    expect(alarm.calls).toEqual([1_056, 1_112]);
  });

  it("idles (arms nothing) when there is no work — nextDeadline returns null", async () => {
    const alarm = fakeAlarm();
    let connections = 0; // an empty room: no work to schedule
    const timer = durableTimer({
      alarm,
      nextDeadline: () => (connections > 0 ? 5_000 : null),
      onFire: () => {},
    });

    await timer.rearm();
    expect(alarm.calls).toEqual([]); // never touched the alarm → DO can hibernate

    // Work appears → the next rearm arms; work disappears again → it stops.
    connections = 1;
    await timer.rearm();
    expect(alarm.calls).toEqual([5_000]);

    connections = 0;
    await timer.rearm();
    expect(alarm.calls).toEqual([5_000]); // still just the one arm — idle again
  });

  it("stops ticking when the last work drains: a fire whose state went idle does not re-arm", async () => {
    const alarm = fakeAlarm();
    let connections = 1;
    const timer = durableTimer({
      alarm,
      nextDeadline: () => (connections > 0 ? 9_000 : null),
      // The fire is the moment the last client leaves.
      onFire: () => {
        connections = 0;
      },
    });

    await timer.rearm(); // armed at 9000 while a connection remained
    expect(alarm.calls).toEqual([9_000]);

    await timer.onAlarm(); // fire drains the room → post-fire re-arm is a no-op
    expect(alarm.calls).toEqual([9_000]); // no new arm → the DO idles
  });

  it("survives a simulated cold wake: a fresh timer re-arms from persisted state", async () => {
    // The persisted state a cold DO rebuilds from `store.load()` → `replay`.
    // The deadline is a pure function of it, so a freshly-woken instance must
    // re-arm to the SAME target a never-evicted one holds.
    const persisted = { deadlineAtMs: 4_242 };
    const nextDeadline = () => persisted.deadlineAtMs;

    // (a) never-evicted instance.
    const liveAlarm = fakeAlarm();
    const live = durableTimer({
      alarm: liveAlarm,
      nextDeadline,
      onFire: () => {},
    });
    await live.rearm();

    // (b) cold wake: a BRAND-NEW timer over a fresh alarm, same persisted state,
    // re-arms once on activation (the host's post-recovery `rearm()` call).
    const wokenAlarm = fakeAlarm();
    const woken = durableTimer({
      alarm: wokenAlarm,
      nextDeadline,
      onFire: () => {},
    });
    await woken.rearm();

    expect(wokenAlarm.armedAt).toBe(liveAlarm.armedAt);
    expect(wokenAlarm.armedAt).toBe(4_242);
  });

  it("never re-arms while the handler is mid-flight (fire fully settles before re-arm)", async () => {
    const alarm = fakeAlarm();
    let fireDone = false;
    const timer = durableTimer({
      alarm,
      nextDeadline: () => {
        // If this ran before the (async) fire settled, fireDone would be false.
        expect(fireDone).toBe(true);
        return 2_000;
      },
      onFire: async () => {
        await Promise.resolve();
        fireDone = true;
      },
    });

    await timer.onAlarm();
    expect(alarm.calls).toEqual([2_000]);
  });

  // ── Property: rearm arms IFF there is work, and arms exactly the target. ───
  it("property: rearm arms exactly nextDeadline when non-null, nothing when null", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.integer({ min: 0, max: 2 ** 40 }), fc.constant(null)),
        async (deadline) => {
          const alarm = fakeAlarm();
          const timer = durableTimer({
            alarm,
            nextDeadline: () => deadline,
            onFire: () => {},
          });
          await timer.rearm();
          if (deadline === null) {
            expect(alarm.calls).toEqual([]);
          } else {
            expect(alarm.calls).toEqual([deadline]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
