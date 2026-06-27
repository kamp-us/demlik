/// <reference types="@cloudflare/workers-types" />
/**
 * `@demlik/tea/do` — the durable-timer / alarm-carrier port (#180).
 *
 * Every native-DO grain that wants a wall-clock tick hand-rolls the SAME
 * eviction-safe pattern: compute the next absolute deadline off the live state,
 * push it to `ctx.storage.setAlarm`, and — when the DO `alarm()` lifecycle hook
 * fires — map that fire back to a Msg, then re-arm off the post-fire state. The
 * `raft/do.ts` election/heartbeat deadline does it (`rearmAlarm` + `onAlarm`),
 * and the vortex arena tick (`room.ts` `armTick` + `onTick`) replicates the
 * exact shape for the 18 Hz game clock. The two old `do_alarm`/`do_ws` Subs were
 * dropped (see `./index`'s historical note) because `toMachine` fixes the agent
 * machine's Sub type to `DeadlineSub`, so they could never union into a grain's
 * Sub set — leaving the alarm re-arm a HOST concern with no first-class home.
 *
 * {@link durableTimer} is that home: a tiny, transport- and Msg-agnostic helper
 * that owns the three repeated responsibilities and nothing else —
 *
 *   1. **Compute-next-deadline → `setAlarm`.** {@link DurableTimer.rearm} calls
 *      the injected {@link DurableTimerConfig.nextDeadline}, and arms the alarm
 *      at the returned absolute epoch-ms target.
 *   2. **Idle-when-no-work.** `nextDeadline` returns `null` when there is nothing
 *      to schedule (an empty room, a node with no pending election/heartbeat),
 *      and `rearm` then arms NOTHING — the DO is allowed to go idle / hibernate
 *      instead of spinning the alarm forever. Re-arming is a positive act gated
 *      on real work, never an unconditional reschedule.
 *   3. **Fire → Msg → re-arm.** {@link DurableTimer.onAlarm} is the body the DO
 *      `alarm()` hook calls: it runs the injected {@link DurableTimerConfig.onFire}
 *      (the consumer dispatches its timer Msg there — a `Tick`, a re-derived
 *      deadline Msg) and THEN re-arms off the now-advanced state. Re-arm always
 *      follows the fire, so a still-active grain keeps ticking and an idle one
 *      stops by construction.
 *
 * **Eviction-safe across hibernation.** A DO alarm is the one timer that
 * survives eviction (an isolate `setInterval` dies the moment the isolate
 * sleeps), so the same `durableTimer` re-armed on a cold wake resumes the
 * schedule that a never-evicted instance would have held. The recovery contract
 * is just: after the host rebuilds state (`store.load()` → `replay`), call
 * {@link DurableTimer.rearm} once — it recomputes `nextDeadline` off the
 * recovered state and re-arms (or idles) identically to the live path. The timer
 * holds no in-memory schedule of its own; the deadline is always a pure function
 * of the persisted state, which is what makes the cold-wake re-arm correct.
 *
 * **Dependency-injected / testable.** The alarm arrives as a {@link AlarmStorage}
 * port — the SAME minimal `setAlarm` slice `stepHost` already takes (a real
 * `DurableObjectStorage` satisfies it structurally; a test supplies a fake with
 * no live Workers runtime), mirroring how `event-sourced-store.ts` takes its
 * storage. `nextDeadline` and `onFire` are injected thunks, so the whole timer
 * unit-tests with a faked alarm + a faked clock and no `cloudflare:workers`
 * import. See `.patterns/tea-do/recovery.md` for the cold-wake replay contract
 * the re-arm rides on.
 */

import type { AlarmStorage } from "./step-host";

// Re-export the alarm port under this module too, so a `durableTimer` consumer
// can name the carrier it injects from the same import as the timer itself. It
// stays the ONE `setAlarm` slice the `/do` surface defines (no parallel type).
export type { AlarmStorage };

/**
 * The construction inputs for {@link durableTimer} — the impure edges the grain
 * injects, kept out of the pure reducer exactly like raft/do's
 * `RaftGrainCtx`/room's `ArenaPorts`.
 */
export interface DurableTimerConfig {
  /**
   * The DO alarm carrier. `setAlarm(atMs)` schedules the next fire at an
   * absolute epoch-ms target. A real `DurableObjectStorage` satisfies this
   * structurally; a test supplies a fake. Only `setAlarm` is read — never the
   * whole `DurableObjectStorage`.
   */
  readonly alarm: AlarmStorage;
  /**
   * Compute the next absolute deadline (epoch ms) off the live state, or `null`
   * when there is no work to schedule. Returning `null` is the idle signal:
   * {@link DurableTimer.rearm} arms nothing and the DO is free to hibernate.
   *
   * Called fresh on every `rearm` (including the post-fire re-arm and the
   * cold-wake re-arm), so it MUST read live state / the injected clock each call
   * — that freshness is what keeps the schedule a pure function of the persisted
   * state and the re-arm eviction-safe. Examples:
   *   - raft: `node.subs(state, now())[0]?.atMs ?? null` (election XOR heartbeat).
   *   - vortex: `connectionCount() > 0 ? now() + TICK_INTERVAL_MS : null`.
   */
  nextDeadline(): number | null | Promise<number | null>;
  /**
   * Run the timer's effect when the alarm fires — the consumer dispatches its
   * timer Msg here (a `Tick`, a re-derived deadline Msg) and persists/broadcasts
   * as its grain requires. {@link DurableTimer.onAlarm} awaits this BEFORE it
   * re-arms, so the re-arm sees the post-fire state.
   */
  onFire(): void | Promise<void>;
}

/**
 * The activated durable timer. Two methods, both idempotent to call from the
 * host edge:
 *   - {@link DurableTimer.rearm} — recompute + (re-)arm or idle. Call it once
 *     after cold-wake recovery, and after any state transition that can change
 *     whether/when the next deadline should fire.
 *   - {@link DurableTimer.onAlarm} — the DO `alarm()` body: fire, then re-arm.
 */
export interface DurableTimer {
  /**
   * Recompute {@link DurableTimerConfig.nextDeadline} off the live state and arm
   * the alarm at it — or, when it returns `null`, arm nothing (idle). Safe to
   * call repeatedly; arming the same absolute target twice is a harmless
   * overwrite on the DO alarm API.
   */
  rearm(): Promise<void>;
  /**
   * The body the DO `alarm()` lifecycle hook delegates to: run
   * {@link DurableTimerConfig.onFire}, then {@link DurableTimer.rearm} off the
   * post-fire state. A still-active grain keeps ticking; an idle one (its
   * `nextDeadline` now `null`) stops here.
   */
  onAlarm(): Promise<void>;
}

/**
 * Build a {@link DurableTimer} over an injected alarm carrier, a next-deadline
 * computation, and a fire handler. The returned timer owns the
 * compute-next-deadline → `setAlarm` → `alarm()` → fire → re-arm loop and holds
 * no schedule of its own (the deadline is always recomputed from live state),
 * which is what makes it eviction-safe across hibernation.
 */
export function durableTimer(config: DurableTimerConfig): DurableTimer {
  const { alarm, nextDeadline, onFire } = config;
  const timer: DurableTimer = {
    async rearm() {
      // Re-arm is a POSITIVE act gated on work: a `null` deadline means idle, so
      // we touch the alarm only when there is a concrete target to schedule.
      const at = await nextDeadline();
      if (at !== null) await alarm.setAlarm(at);
    },
    async onAlarm() {
      // Fire first (the consumer dispatches its timer Msg), THEN re-arm off the
      // now-advanced state — so a still-active grain keeps ticking and an idle
      // one stops because its `nextDeadline` has gone `null`.
      await onFire();
      await timer.rearm();
    },
  };
  return timer;
}
