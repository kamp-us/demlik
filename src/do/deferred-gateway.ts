/**
 * The deferred-tool gateway + its durable wrappers — the Promise-owning half of
 * the `@demlik/tea/do` transport. See `./host` for the transport-model
 * rationale (ONE Sub type, gateway-bridged I/O).
 */

import type {
  EffectConfirmed,
  EffectOwed,
  PendingEffectsRecorder,
} from "./durable-effects";

// ─────────────────────────────────────────────────────────────────────────────
// deferredGateway — the deferred-tool gateway (HEADLINE).
//
// Lifts the consumer's `pending` Map + `awaitClient` + `Promise.race` timeout +
// settle-on-reply. A tool's interpret cell calls `gateway.await(callId, send,
// deadlineMs)`: the gateway registers the round-trip, fires `send`, and returns
// a Promise the transport settles via `gateway.settle(callId, result)` (or that
// the deadline rejects). The cell awaits it and maps Ok/Err to
// `agent_tool_ok` / `agent_tool_err` — that is ALL the consumer's tool cell does
// after this.
// ─────────────────────────────────────────────────────────────────────────────

/** A single in-flight tool round-trip, keyed by `callId`. */
interface PendingCall<R> {
  resolve(result: R): void;
  reject(reason: Error): void;
  readonly promise: Promise<R>;
}

/**
 * The deferred-tool gateway. `R` is the consumer's tool-result type (what
 * `agent_tool_ok` carries).
 *
 *   - `await(callId, send, deadlineMs)` — register the round-trip, fire `send`,
 *     return the Promise the reply (or the deadline) settles. Idempotent per
 *     `callId`: a second call for an in-flight id returns the SAME promise
 *     without re-firing `send` (the boot-reconcile re-fire is a no-op at the
 *     gateway, mirroring the agent's idempotent boot).
 *   - `settle(callId, result)` — the transport calls this on a reply; resolves
 *     the awaited promise. A settle for an unknown / already-settled id is a
 *     no-op (the callId guard the consumer used to keep in its pending Map).
 *   - `fail(callId, reason)` — settle the round-trip as an error on demand
 *     (e.g. a transport-level close). Same unknown-id no-op.
 *   - `inFlight()` — the callIds with an open round-trip (tests / introspection).
 *
 * The deadline → reject path is what makes "timeout is data": the tool cell's
 * `catch` maps the rejection to `agent_tool_err`, recorded on the conversation,
 * never a hang.
 */
export interface DeferredGateway<R> {
  await(callId: string, send: () => void, deadlineMs: number): Promise<R>;
  settle(callId: string, result: R): void;
  fail(callId: string, reason: string): void;
  inFlight(): readonly string[];
}

/**
 * Build a deferred-tool gateway. No clock / RNG captured at construction — the
 * deadline is per-call (`await(..., deadlineMs)`), so one gateway serves every
 * tool family with its own timeout.
 *
 * Deletes from the consumer: the `pending` Map, the `Pending` interface, the
 * `awaitClient` method, the `forceTimeout` plumbing, and the `deliverResult`
 * callId-guard body — all of it collapses to this object plus the tool cell's
 * `await` + try/catch.
 */
export function deferredGateway<R>(): DeferredGateway<R> {
  const pending = new Map<string, PendingCall<R>>();

  return {
    await(callId, send, deadlineMs) {
      const existing = pending.get(callId);
      // Idempotent re-fire (boot reconcile re-issues the same callId): return
      // the open promise, do NOT re-fire `send`.
      if (existing !== undefined) return existing.promise;

      let resolve!: (r: R) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<R>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const timer = setTimeout(() => {
        if (pending.delete(callId)) {
          reject(new Error(`deadline_exceeded after ${deadlineMs}ms`));
        }
      }, deadlineMs);
      pending.set(callId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        promise,
      });
      send();
      return promise;
    },

    settle(callId, result) {
      const entry = pending.get(callId);
      if (entry === undefined) return; // unknown / stale / already settled.
      pending.delete(callId);
      entry.resolve(result);
    },

    fail(callId, reason) {
      const entry = pending.get(callId);
      if (entry === undefined) return;
      pending.delete(callId);
      entry.reject(new Error(reason));
    },

    inFlight() {
      return [...pending.keys()];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// durableDeferredGateway — bridge `deferredGateway` to the durable ledger.
//
// `deferredGateway` is volatile: its `pending` Map lives in the isolate and is
// LOST on hibernation, so a tool round-trip in flight when the DO sleeps is
// gone — exactly the durable-effects tax (ADR 0003 #1). This bridge makes the
// round-trip a DURABLE owed effect WITHOUT changing the gateway's fast path:
//
//   - the in-memory `await`/`settle`/`fail`/`inFlight` behavior is untouched
//     (the Promise the interpret cell awaits is still resolved in-isolate);
//   - around it, `await` records an `effect_owed` event and `settle`/`fail`
//     record an `effect_confirmed`, which the consumer PERSISTS into the same
//     event log the actor replays. On the next activation the rebuilt ledger's
//     `survivingEffects` are the round-trips to re-fire — idempotent by id.
//
// It is OPT-IN and ADDITIVE: a consumer that wants only the volatile gateway
// keeps calling `deferredGateway()` directly; one that wants durability wraps
// it here. The `record*` callbacks hand the consumer the events to persist (the
// host does not own the consumer's log, so it cannot persist them itself —
// keeping the bridge pure of storage and faithful to "persist the intent before
// deliver").
// ─────────────────────────────────────────────────────────────────────────────

/** A `callId`-keyed durable round-trip: maps the gateway's string id to the
 *  ledger's monotonic delivery id so a `settle(callId)` finds the owed entry. */
interface DurableDeferredGateway<R> extends DeferredGateway<R> {
  /** The ledger recorder this gateway feeds (for `surviving()` on activation). */
  readonly recorder: PendingEffectsRecorder<{ callId: string }>;
}

/**
 * Wrap a `DeferredGateway<R>` so every round-trip is also recorded in a durable
 * `PendingEffectsRecorder`. The in-memory gateway is the fast path; the recorder
 * is the durability slice.
 *
 *   - `recordOwed(callId, event)` — fires from `await`, BEFORE `send`, carrying
 *     the `effect_owed` event the consumer must persist (then deliver).
 *   - `recordConfirmed(callId, event)` — fires from `settle`/`fail` for a known
 *     id, carrying the `effect_confirmed` event to persist.
 *   - `reissue(callId, send, deadlineMs)` — re-arm a surviving round-trip on
 *     activation. Idempotent: the gateway's own `await` returns the open promise
 *     without re-firing `send` for an in-flight `callId`, so re-issuing an id
 *     that is somehow still pending is a no-op (mirrors the boot-reconcile
 *     re-fire). The effect is already owed, so no second `effect_owed` is
 *     recorded.
 *
 * The effect payload the ledger stores is the `callId` (the correlation key the
 * consumer round-trips); the consumer maps it back to its tool-call context.
 */
export function durableDeferredGateway<R>(
  inner: DeferredGateway<R>,
  recorder: PendingEffectsRecorder<{ callId: string }>,
  hooks: {
    recordOwed(callId: string, event: EffectOwed<{ callId: string }>): void;
    recordConfirmed(callId: string, event: EffectConfirmed): void;
  },
): DurableDeferredGateway<R> {
  // callId → ledger deliveryId, so settle/fail can confirm the right entry.
  const idByCallId = new Map<string, number>();

  return {
    recorder,

    await(callId, send, deadlineMs) {
      // Already owed (re-entrant await for an in-flight id) → don't re-owe;
      // delegate so the gateway returns the SAME open promise without re-send.
      if (!idByCallId.has(callId)) {
        const { id, event } = recorder.owe({ callId });
        idByCallId.set(callId, id);
        // Persist the intent BEFORE the send fires (which `inner.await` does).
        hooks.recordOwed(callId, event);
      }
      return inner.await(callId, send, deadlineMs);
    },

    settle(callId, result) {
      confirm(callId);
      inner.settle(callId, result);
    },

    fail(callId, reason) {
      confirm(callId);
      inner.fail(callId, reason);
    },

    inFlight() {
      return inner.inFlight();
    },
  };

  function confirm(callId: string): void {
    const id = idByCallId.get(callId);
    if (id === undefined) return; // unknown / already confirmed — no-op.
    idByCallId.delete(callId);
    const { event } = recorder.confirm(id);
    hooks.recordConfirmed(callId, event);
  }
}

/**
 * The durable command carrier — a {@link DurableDeferredGateway} whose every
 * tool round-trip is also a durable owed effect.
 *
 * A consumer's tool interpret cell still calls `carrier.await(callId, send,
 * deadlineMs)` and awaits the Promise (mapping Ok/Err to `agent_tool_ok` /
 * `agent_tool_err`) — the SAME fast path as the volatile gateway. The addition
 * is durability: `await` hands the consumer an `effect_owed` event (via
 * `recordOwed`) to PERSIST before the send, and `settle`/`fail` hand it an
 * `effect_confirmed` (via `recordConfirmed`) to persist. On the next activation
 * the consumer reads its persisted ledger events back and calls
 * `reissueSurvivingEffects` (see `./resume`) to re-fire the survivors.
 *
 * It extends `DurableDeferredGateway` (so it is a drop-in for the gateway the
 * interpret cell already awaits) and exposes the underlying `recorder` for a
 * host that wants to read `surviving()` directly.
 */
export interface DurableCommandCarrier<R> extends DeferredGateway<R> {
  /** The ledger recorder backing this carrier (for `surviving()` introspection). */
  readonly recorder: PendingEffectsRecorder<{ callId: string }>;
}

/**
 * Build a durable command carrier over a (volatile) `DeferredGateway<R>` and a
 * `PendingEffectsRecorder`. Thin assembly over {@link durableDeferredGateway}:
 * it names the #91 piece — "the command carrier whose round-trips survive
 * eviction" — and keeps the recorder reachable for the activation-time re-emit.
 *
 *   - `inner` — the volatile gateway whose in-isolate Promise the interpret cell
 *     awaits (typically `deferredGateway<R>()`).
 *   - `recorder` — the durable-effects recorder (typically
 *     `pendingEffectsLedger({ events, lastId })` rehydrated from the persisted
 *     log on a wake, or a fresh `pendingEffectsLedger()` on a cold boot).
 *   - `hooks.recordOwed` / `hooks.recordConfirmed` — the persist callbacks the
 *     consumer points at its event log (so the ledger survives eviction).
 *
 * The carrier never persists anything itself (it does not own the consumer's
 * log) — it hands the consumer the events, faithful to "persist the intent
 * before deliver".
 */
export function durableCommandCarrier<R>(
  inner: DeferredGateway<R>,
  recorder: PendingEffectsRecorder<{ callId: string }>,
  hooks: {
    recordOwed(callId: string, event: EffectOwed<{ callId: string }>): void;
    recordConfirmed(callId: string, event: EffectConfirmed): void;
  },
): DurableCommandCarrier<R> {
  return durableDeferredGateway(inner, recorder, hooks);
}
