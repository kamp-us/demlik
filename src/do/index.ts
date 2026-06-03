/// <reference types="@cloudflare/workers-types" />
/**
 * @demlik/tea/do — Durable Object adapter for `@demlik/tea`.
 *
 * Two exports drive the integration:
 *
 *   1. `doStore<S>(storage, parse, key?)` — `Store<S>` impl backed by
 *      `DurableObjectStorage`. JSON-stringifies on save, JSON-parses on load
 *      and returns `unknown` (invariant-8 boundary); the substrate then calls
 *      `migrate(raw)` (which forwards to `parse`) to turn it into `S | null`.
 *      Returns `null` (typed as `unknown`) when the key is absent. Structural
 *      JSON malformation throws at load — `run()`'s boot path surfaces that
 *      (PRD throw-semantics table: "store.load throw at boot → run() throws
 *      synchronously"). Shape mismatch is NOT a throw — `parse` returns
 *      `null` and the substrate boots fresh.
 *
 *   2. `doSubscribe<M, Ctx>()` — handler registry for the two DO-native sub
 *      types this package owns:
 *        - `do_alarm` — schedules a real DO alarm via `state.storage.setAlarm`;
 *          the cooperating DO's `alarm()` lifecycle method dispatches the sub's
 *          msg. Cleanup clears the alarm.
 *        - `do_ws`   — registers a WebSocket-id'd listener in a per-DO registry
 *          that the cooperating DO's `webSocketMessage()` consults. Cleanup
 *          deregisters.
 *
 * BOTH `do_alarm` and `do_ws` rely on the host DO cooperating: alarm and
 * webSocketMessage are DO lifecycle methods, not JS events the handler can
 * subscribe to from the outside. The cooperating DO must:
 *
 *   - Maintain a `Ctx` that exposes `state: DurableObjectState` AND the
 *     subscriber registries (`wsRegistry`, `alarmRegistry`). The handlers read
 *     from `ctx`.
 *   - Forward `alarm()` callbacks into the alarm registry by id, dispatching
 *     the registered msg.
 *   - Forward `webSocketMessage(ws, data)` callbacks into the ws registry,
 *     dispatching `sub.msg(data)` for matching `socketId`s.
 *
 * `src/test-worker.ts` is the canonical example of this cooperation. See
 * `test/README.md` for the convention.
 */

import type { Store, Sub, SubId } from "../index";

// ─────────────────────────────────────────────────────────────────────────────
// doStore — `Store<S>` over DurableObjectStorage.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STATE_KEY = "@@state";

/**
 * `Store<S>` over `DurableObjectStorage`.
 *
 * `parse` is REQUIRED because DO storage is a real serialization boundary —
 * the bytes that come back through `JSON.parse` are structurally `unknown`,
 * and the caller (the DO that owns `S`) is the only party with enough
 * information to validate the shape. Returning `null` from `parse` means
 * "no usable persisted state" — the substrate boots `init` with `loaded =
 * null`, a known-good fresh-boot path. `parse` must NOT throw per the
 * `Store<S>.migrate` contract; shape mismatch is a value (null), not a
 * panic.
 *
 * Structural malformations (the stored cell isn't even JSON) still throw at
 * `load()` — that's an infrastructure error, distinct from a schema
 * mismatch. The substrate surfaces it via `runtime.ready` rejection.
 *
 * Concrete bite this closes: when a `State` variant is renamed between
 * deploys, the DO's new code previously received a value typed as the new
 * `S` that held a runtime string from the old `S` — silent undefined
 * behavior in `init`/`update`. After this, the boundary parse rejects the
 * old shape (returns null) and the DO boots fresh, picking up its new
 * schema from the next dispatch onward.
 */
export function doStore<S>(
  storage: DurableObjectStorage,
  parse: (raw: unknown) => S | null,
  key: string = DEFAULT_STATE_KEY,
): Store<S> {
  return {
    async load(): Promise<unknown> {
      const raw = await storage.get<string>(key);
      if (raw === undefined || raw === null) return null;
      // JSON.parse throws on malformed — propagate per PRD throw-semantics.
      // The decoded value is intentionally returned as `unknown`; the
      // substrate's `migrate` callback (forwarded from `parse`) is the
      // boundary parse that turns it into `S | null`.
      return JSON.parse(raw);
    },
    async save(state: S): Promise<void> {
      await storage.put(key, JSON.stringify(state));
    },
    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DoSub — the two DO-native subscription variants, locked in the PRD.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A DO alarm sub: fires `msg` at `firesAt` (epoch ms). The substrate diffs
 * subs by `id`; same id across transitions = same alarm. To reschedule, emit
 * a DIFFERENT id (e.g., `audit-timeout-v2`).
 */
export type DoAlarmSub<M> = { id: SubId; type: "do_alarm"; firesAt: number; msg: M };

/**
 * A DO WebSocket sub: routes incoming messages on `socketId` through
 * `sub.msg(data)` to dispatch.
 */
export type DoWsSub<M> = {
  id: SubId;
  type: "do_ws";
  socketId: string;
  msg: (data: string) => M;
};

export type DoSub<M> = DoAlarmSub<M> | DoWsSub<M>;

// Compile-time guarantee: `DoSub<M>` is structurally a `Sub` (has `id`+`type`).
// Erased at runtime — the `extends Sub` constraint on the alias's type
// parameter fails to compile if `DoSub` ever drifts off the `Sub` shape.
export type AssertDoSubIsSub<T extends Sub = DoSub<unknown>> = T;

// ─────────────────────────────────────────────────────────────────────────────
// Ctx contract — what the cooperating DO must expose to `doSubscribe`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry of pending alarm dispatches keyed by sub `id`. The cooperating DO's
 * `alarm()` lifecycle method drains this and dispatches each msg.
 *
 * One alarm-queue cell at a time per DO (DO has exactly one alarm slot). We
 * still key by `id` so multiple alarm subs scheduled in the same reconcile
 * pass don't clobber each other — the earliest `firesAt` wins (DO native
 * behavior) and `alarm()` drains everything due by the fire time.
 */
export type DoAlarmRegistry<M> = Map<string, { firesAt: number; msg: M }>;

/**
 * Registry of WebSocket message subscribers keyed by sub `id`. The cooperating
 * DO's `webSocketMessage(ws, data)` consults this and dispatches
 * `sub.msg(data)` for entries matching the incoming `socketId`.
 */
export type DoWsRegistry<M> = Map<string, { socketId: string; msg: (data: string) => M }>;

/**
 * Minimum shape a cooperating DO must put on its `Ctx` for `doSubscribe`
 * handlers to wire up. Users may extend with anything else they like.
 */
export interface DoSubscribeCtx<M> {
  state: DurableObjectState;
  alarmRegistry: DoAlarmRegistry<M>;
  wsRegistry: DoWsRegistry<M>;
}

// ─────────────────────────────────────────────────────────────────────────────
// doSubscribe — the handler registry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `subscribe` handler registry for `do_alarm` and `do_ws` subs.
 *
 * Returned object shape matches `Machine#subscribe`'s `[K in U['type']]:
 * (sub, ctx, dispatch) => () => void` contract for `U = DoSub<M>`.
 *
 * Generic `Ctx` is user-defined and must extend `DoSubscribeCtx<M>` so handlers
 * can reach `state.storage`, `alarmRegistry`, and `wsRegistry`.
 */
export function doSubscribe<M, Ctx extends DoSubscribeCtx<M>>(): {
  do_alarm: (sub: DoAlarmSub<M>, ctx: Ctx, dispatch: (msg: M) => void) => () => void;
  do_ws: (sub: DoWsSub<M>, ctx: Ctx, dispatch: (msg: M) => void) => () => void;
} {
  return {
    do_alarm: (sub, ctx, _dispatch) => {
      // Register the msg so the DO's `alarm()` lifecycle method can find it.
      // `dispatch` itself is not captured here — the DO's alarm() drains the
      // registry and calls dispatch via the runtime it owns. That keeps the
      // cleanup race-free: clearing the registry entry is the only thing
      // cleanup needs to do.
      ctx.alarmRegistry.set(sub.id, { firesAt: sub.firesAt, msg: sub.msg });

      // Recompute the next alarm wall-clock target. DO supports exactly one
      // alarm slot; the earliest firesAt across all registered subs wins.
      const earliest = earliestFiresAt(ctx.alarmRegistry);
      // `earliestFiresAt` returns null only when the registry is empty, which
      // cannot happen here (we just inserted). The null branch is for cleanup.
      if (earliest !== null) {
        // `setAlarm` is a Promise; we don't await — the substrate's subscribe
        // signature is sync. Attach `.catch` so an unhandled rejection doesn't
        // tear down the DO isolate silently (DO isolates terminate on
        // unhandled rejections — silent failure in an alarm scheduler would
        // vanish without trace otherwise).
        ctx.state.storage
          .setAlarm(earliest)
          .catch((err) => console.error("[tea-do] setAlarm failed", err));
      }

      return () => {
        ctx.alarmRegistry.delete(sub.id);
        const nextEarliest = earliestFiresAt(ctx.alarmRegistry);
        if (nextEarliest === null) {
          // No registered alarms left — clear the slot. `deleteAlarm` returns
          // a Promise we don't await for the same reason as above; `.catch`
          // for the same isolate-safety reason.
          ctx.state.storage
            .deleteAlarm()
            .catch((err) => console.error("[tea-do] deleteAlarm failed", err));
        } else {
          ctx.state.storage
            .setAlarm(nextEarliest)
            .catch((err) => console.error("[tea-do] setAlarm failed", err));
        }
      };
    },

    do_ws: (sub, ctx, _dispatch) => {
      ctx.wsRegistry.set(sub.id, { socketId: sub.socketId, msg: sub.msg });
      return () => {
        ctx.wsRegistry.delete(sub.id);
      };
    },
  };
}

// Pure utility: lowest `firesAt` in a non-empty alarm registry, or `null`.
function earliestFiresAt<M>(registry: DoAlarmRegistry<M>): number | null {
  let earliest: number | null = null;
  for (const { firesAt } of registry.values()) {
    if (earliest === null || firesAt < earliest) earliest = firesAt;
  }
  return earliest;
}
