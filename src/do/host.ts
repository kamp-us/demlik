/// <reference types="@cloudflare/workers-types" />
/**
 * @demlik/tea/do — the minimum-viable Durable-Object HOST for a `@demlik/tea`
 * `createAgent` runtime.
 *
 * `doStore` (in `./index`) is the durability half. This file is the rest of the
 * boilerplate a DO consumer hand-rolls every time it drives a tea agent over a
 * remote transport: the deferred-tool gateway, auto-boot on rehydrate, the
 * command-runner WS accept, the runtime→SSE plumbing, and a clean read of a
 * run's terminal output. Each export below names exactly the hand-rolled piece
 * it deletes from the consumer.
 *
 * ## The transport model: ONE Sub type, gateway-bridged I/O
 *
 * `createAgent().toMachine()` fixes the machine's Sub type to `DeadlineSub` —
 * the agent owns the retry + watchdog timers and nothing else. That is the
 * WHOLE Sub model for a DO-hosted agent, and it is coherent because the
 * transport deliberately does NOT live in the Sub system:
 *
 *   - Inbound WebSocket frames are bridged straight into `gateway.settle(...)`
 *     from the DO's `webSocketMessage` lifecycle method — a direct dispatch,
 *     not a Sub.
 *   - The per-tool deadline is a `setTimeout` inside the gateway — a timer, not
 *     a DO alarm.
 *
 * The deferred-tool gateway owns each tool round-trip as a Promise the interpret
 * cell awaits; the transport bridges results into `dispatch` from outside the
 * Sub system. The agent's Sub type stays exactly `DeadlineSub` — there is no
 * competing DO-native Sub variant to union in, and the host needs none. This is
 * the single transport model for `@demlik/tea/do` (#52); see
 * `.patterns/tea/durable-actors.md` for the host-layer north star.
 */

import {
  type AgentEvent,
  type AgentMachineMsg,
  type AgentState,
  type AgentStatus,
  type AgentTurn,
  agentBootMsg,
  agentEvents,
  status,
} from "../agent/index";
import {
  type BootingRuntime,
  type Machine,
  type Runtime,
  run,
  type Store,
} from "../index";
import type {
  EffectConfirmed,
  EffectOwed,
  PendingEffectsRecorder,
} from "./durable-effects";
import type { Projection } from "./projection";

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

// ─────────────────────────────────────────────────────────────────────────────
// agentIsResumable + autoBoot — auto-boot on rehydrate (seam B).
//
// A run that loaded from storage mid-loop must re-fire its one outstanding
// effect (`agent_boot`). Lift the consumer's `isResumable` predicate + the
// post-`ready` dispatch so the host owns it — no consumer code reaching into
// agent internals.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True iff an agent slice loaded from storage is mid-loop (running + awaiting
 * tools) — the resumable case `agent_boot` re-fires.
 *
 * The resumability question IS "is the run suspended on tools?" — so this
 * delegates to the agent's own typed `status` channel (issue #49) rather than
 * re-deriving the private `run.phase` / `conversation.awaiting` shape by hand.
 * The host no longer leaks the agent's internal slice structure; a change to
 * `Awaiting` surfaces as a compile error in `status`, not a silent break here.
 */
export function agentIsResumable<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(state: AgentState<Stage, P, O, R>): boolean {
  return status(state).kind === "suspended";
}

/**
 * After `runtime.ready`, self-dispatch `agent_boot` iff the rehydrated slice is
 * resumable. On a fresh DO this is a no-op. Call this once right after building
 * the runtime; it replaces the consumer's hand-written
 * `if (this.isResumable(...)) await runtime.dispatch({ type: "agent_boot", ... })`.
 *
 * `now` is injected (the host's only clock read for boot) so a test can pin it.
 */
export async function autoBoot<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
  E extends { type: string } = never,
>(
  booting: BootingRuntime<
    AgentState<Stage, P, O, R>,
    AgentMachineMsg<P, O, R>,
    E
  >,
  now: () => number = Date.now,
): Promise<void> {
  // `await ready` is the single boot gate (issue #45): it resolves to the
  // booted `Runtime` whose `getState()` is total. Reading the rehydrated slice
  // off `run()`'s synchronous handle is no longer possible — and that is the
  // point: we cannot inspect state before boot has populated it.
  const runtime = await booting.ready;
  if (agentIsResumable(runtime.getState())) {
    // Fire through the agent-owned `agentBootMsg` port (issue #60) — the boot
    // Msg shape lives in the agent, not as a raw literal hand-built here.
    await runtime.dispatch(agentBootMsg(now()));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// acceptCommandSocket — WS host + inbound bridge (seam C).
//
// Accept the command-runner socket, keep it in a client registry, and route
// inbound string frames to a handler (which the consumer points at
// `gateway.settle(...)`). Lifts the consumer's `acceptClient` boilerplate.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accept a command-runner WebSocket on the DO's `fetch`. Adds the server end to
 * `clients`, wires `message` → `onFrame(data)` (string frames only) and
 * `close` → deregister, and returns the 101 upgrade Response.
 *
 * The consumer's `onFrame` parses the frame and calls `gateway.settle(callId,
 * result)` — the inbound bridge. Deletes the consumer's `acceptClient` method.
 */
export function acceptCommandSocket(
  clients: Set<WebSocket>,
  onFrame: (data: string) => void,
): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  clients.add(server);
  server.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") onFrame(ev.data);
  });
  server.addEventListener("close", () => clients.delete(server));
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Broadcast a JSON frame to every connected command-runner socket. A dead
 * socket is skipped (dropped on its own `close` event). Lifts the consumer's
 * fan-out loop in `sendCommand`.
 */
export function broadcast(clients: Set<WebSocket>, frame: unknown): void {
  const json = JSON.stringify(frame);
  for (const ws of clients) {
    try {
      ws.send(json);
    } catch {
      /* dead socket — dropped on its close event */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// acceptDurableCommandSocket — a HIBERNATION-AWARE command-runner socket (#91).
//
// `acceptCommandSocket` (above) uses `server.accept()` — the NON-hibernatable
// WebSocket API. The DO must stay resident to keep the socket alive; on eviction
// the runtime tears the socket down (close 1006) and the inbound bridge dies.
// That is half of #91. The other half — the LOAD-BEARING half — is that the
// in-flight tool round-trips themselves are volatile: `deferredGateway`'s
// `pending` Map is isolate-local, so a round-trip awaiting a reply when the DO
// hibernates is lost with the heap, and nothing in replayed state records it is
// still OWED. The durable carrier fixes BOTH:
//
//   - the socket is accepted with `ctx.acceptWebSocket(server)` — the Cloudflare
//     Hibernation API. The runtime may evict the isolate while the socket stays
//     open; on the next inbound frame it re-creates the DO and calls the
//     `webSocketMessage(ws, data)` lifecycle method. The consumer routes that to
//     `onFrame` (which calls `carrier.settle(...)`). No isolate-resident
//     `message` listener to lose.
//   - each round-trip is recorded in the durable-effects ledger via
//     `durableDeferredGateway`, so the consumer PERSISTS an `effect_owed` before
//     the send and an `effect_confirmed` on settle/fail. On wake,
//     `reissueSurvivingEffects(carrier, persistedEvents, reissue)` folds the log
//     and re-fires every owed-but-unconfirmed round-trip — idempotent by the
//     ledger's monotonic `deliveryId`, deduped at the receiver.
//
// The carrier stays OUTSIDE the agent's Sub system (the header rationale): the
// round-trip is still a Promise the interpret cell awaits, bridged into
// `dispatch` by the gateway. The DURABILITY lives in the ledger + the consumer's
// storage, NOT in widening the machine's Sub type. `acceptCommandSocket` keeps
// working untouched for callers that do not need eviction survival.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The slice of `DurableObjectState` the durable carrier needs: the Hibernation
 * API accept + the registry of hibernatable sockets. A real `DurableObjectState`
 * satisfies this structurally; a test supplies a fake (no live Workers runtime
 * needed to exercise the accept/registry seam).
 */
export interface HibernatableCtx {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}

/**
 * Accept a command-runner WebSocket using the Cloudflare **Hibernation API** so
 * the socket survives DO eviction. Unlike {@link acceptCommandSocket}, this does
 * NOT attach an isolate-resident `message` listener (that listener is what dies
 * on eviction) — instead `ctx.acceptWebSocket(server)` hands the socket to the
 * runtime, which re-creates the DO and calls its `webSocketMessage(ws, data)`
 * lifecycle method on the next inbound frame. The consumer routes that method to
 * its `onFrame` (which calls `carrier.settle(callId, result)`).
 *
 * Returns the 101 upgrade Response. There is no `clients` registry to keep — the
 * live sockets are `ctx.getWebSockets()` (see {@link broadcastHibernatable}),
 * which the runtime repopulates after a wake.
 */
export function acceptDurableCommandSocket(ctx: HibernatableCtx): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  // Hibernation API: the runtime owns the socket across eviction; no resident
  // `message`/`close` listeners (they would be lost on eviction). Inbound frames
  // arrive via the DO's `webSocketMessage` lifecycle method instead.
  ctx.acceptWebSocket(server);
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Broadcast a JSON frame to every hibernatable command-runner socket. The live
 * set is read from `ctx.getWebSockets()` (the runtime repopulates it after a
 * wake), NOT a resident `Set<WebSocket>` — so it is correct immediately after an
 * eviction, before any other lifecycle method has run. A dead socket is skipped.
 */
export function broadcastHibernatable(
  ctx: HibernatableCtx,
  frame: unknown,
): void {
  const json = JSON.stringify(frame);
  for (const ws of ctx.getWebSockets()) {
    try {
      ws.send(json);
    } catch {
      /* dead socket — dropped by the runtime on its close */
    }
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
 * {@link reissueSurvivingEffects} to re-fire the survivors.
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

/**
 * RE-EMIT ON ACTIVATION (the #91 wake path). Given a durable carrier whose
 * recorder was rehydrated from the persisted ledger events (e.g.
 * `durableCommandCarrier(deferredGateway(), pendingEffectsLedger({ events }),
 * …)` on a wake), re-fire every owed-but-unconfirmed round-trip via
 * `reissue(callId)` — the consumer's "re-send the command frame for this
 * `callId`" callback. The survivors are read straight off the carrier's own
 * recorder (`recorder.surviving()`), which folded the restore log at
 * construction — the carrier is the single source of the in-flight set, so the
 * caller does not re-fold the log here.
 *
 * Idempotent by construction:
 *   - the ledger's monotonic `deliveryId` is the dedup key the RECEIVER uses, so
 *     a late/duplicate reply for an already-resolved round-trip is absorbed
 *     (at-least-once delivery — see `survivingEffects`);
 *   - re-issuing the SAME survivor twice within one activation re-sends once —
 *     if `reissue` routes through the carrier's `await`, the gateway returns the
 *     open Promise for an in-flight `callId` without re-firing `send`.
 *
 * Returns the `callId`s re-emitted (oldest-first by id) — the host can log /
 * assert the re-emit set. On a fresh or fully-confirmed carrier this is empty
 * (nothing re-fired).
 *
 * Call this once, right after the runtime's boot gate resolves (alongside
 * {@link autoBoot}): `autoBoot` re-fires the agent's own `agent_boot`;
 * `reissueSurvivingEffects` re-fires the in-flight TOOL round-trips. Together
 * they restore a suspended run's full in-flight state after a wake.
 */
export function reissueSurvivingEffects<R>(
  carrier: DurableCommandCarrier<R>,
  reissue: (callId: string) => void,
): readonly string[] {
  const reemitted: string[] = [];
  for (const { effect } of carrier.recorder.surviving()) {
    reissue(effect.callId);
    reemitted.push(effect.callId);
  }
  return reemitted;
}

// ─────────────────────────────────────────────────────────────────────────────
// sseStream — runtime→SSE adapter (seam D).
//
// The sink-set + ReadableStream + encoder + cancel is generic; only the
// Msg→event mapping is domain. Sibling-in-spirit to `@demlik/tea/react`: the
// host owns the plumbing, the consumer supplies the mapping.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A set of SSE sinks plus the plumbing to fan an event out to all of them and
 * to open a `text/event-stream` Response wired to a fresh sink.
 *
 * The consumer:
 *   1. holds one `SseHub<E>` per DO,
 *   2. calls `hub.emit(event)` from its Msg→event mapping (driven off
 *      `runtime.observe`), and
 *   3. returns `hub.open()` from the `/sse` route.
 *
 * `register(sink)` exists for tests: subscribe a sink directly and observe the
 * exact event sequence a live client would receive (a live `text/event-stream`
 * fights vitest-pool-workers teardown). Deletes the consumer's `sseSinks` set,
 * `openSse`, `emitSse`, and `onSseEvent`.
 */
export interface SseHub<E> {
  emit(event: E): void;
  open(): Response;
  register(sink: (event: E) => void): () => void;
}

/** Build an SSE hub for event type `E` (the consumer's domain event shape). */
export function sseHub<E>(): SseHub<E> {
  const sinks = new Set<(event: E) => void>();
  const encoder = new TextEncoder();

  return {
    emit(event) {
      for (const sink of sinks) {
        try {
          sink(event);
        } catch {
          /* broken stream — dropped on its cancel */
        }
      }
    },
    open() {
      let sink!: (event: E) => void;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          sink = (event) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          };
          sinks.add(sink);
        },
        cancel: () => {
          sinks.delete(sink);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    },
    register(sink) {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sseProjection — express `sseHub` as ONE projection over the seam (#69).
//
// `sseHub` (above) is the ad-hoc form: a sink-set the consumer fans
// `runtime.observe` events out to by hand. `sseProjection` names it: the SSE
// view is ONE projection (`name: "sse"`) over the `Projection<Model, View>`
// seam in `./projection`. Its `apply` maps the write-model update to the
// consumer's SSE event shape; its `emit` is `hub.emit` — the SAME hub, the SAME
// public API. Register it on a `projectionRegistry` (driven off `observe`) and
// the host's runtime→SSE plumbing is one projection among many, not a special
// case.
//
// ADDITIVE, not a replacement: `sseHub()` keeps working untouched for every
// existing caller (it is the volatile, offset-free case — a live `/sse` stream
// has no durable read model to resume). `sseProjection` is the seam expression
// of it for a consumer that wants SSE to sit on the same registry as a durable
// report/storage projection.
//
// The SSE view is the most-recently-emitted event (a "latest" read model); the
// fold ignores the previous view and re-derives from each update via
// `toEvent`. `toEvent` returns `null` to SKIP an update the SSE view does not
// care about (the canon's `Future.successful(Done)` skip) — the fold then keeps
// the prior view and does not re-emit.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express an {@link SseHub} as a {@link Projection}. The projection's view is
 * the latest emitted SSE event (or `null` before the first); `apply` maps each
 * write-model update to an event via `toEvent` and emits it through `hub.emit`,
 * so the SSE stream is driven by the SAME hub `sseHub()` returns — no API
 * change for the `/sse` route (`hub.open()`) or any existing caller.
 *
 *   - `toEvent(msg, model)` returns the SSE event for this update, or `null` to
 *     skip it (the view stays, nothing is emitted).
 *   - `name`/`key` default to `"sse"`/`"main"`; override for a second SSE view.
 *
 * @example
 *   const hub = sseHub<MyEvent>();
 *   const registry = projectionRegistry<MyState, MyMsg>();
 *   registry.register(sseProjection(hub, (msg) =>
 *     msg?.type === "turn_done" ? { kind: "turn", ... } : null,
 *   ));
 *   driveProjections(registry, runtime); // SSE is now one projection
 *   // /sse route unchanged:
 *   return hub.open();
 */
export function sseProjection<Model, Msg extends { type: string }, E>(
  hub: SseHub<E>,
  toEvent: (msg: Msg | null, model: Model) => E | null,
  id: { name?: string; key?: string } = {},
): Projection<Model, Msg, E | null> {
  // The SSE view is "the latest event to push, or null when the update was a
  // skip". `apply` derives it; `emit` pushes the non-null case at the hub. The
  // fold stays pure (no side effect in `apply`); the sink stays the hub (no API
  // change). A skip resolves to a `null` view → `emit` pushes nothing.
  return {
    id: { name: id.name ?? "sse", key: id.key ?? "main" },
    initial: null,
    apply(_view, update) {
      // Each SSE update re-derives from the write model — the view is the
      // latest event, not an accumulation, so the prior view is ignored.
      // Idempotent by construction: re-deriving the same update yields the same
      // event (the exclusive-offset guard already drops re-presented offsets).
      return toEvent(update.msg, update.model);
    },
    emit(view) {
      // The runner calls `emit` after every APPLIED update (offset strictly past
      // the stored one). `null` is the skip — push nothing. A real event is
      // pushed through the hub, so `hub.open()` / existing callers are unchanged.
      if (view !== null) hub.emit(view);
    },
  };
}

// captureLastTurn DELETED (issue #46). It existed only to reconstruct the run's
// terminal output off the `observe` firehose — match the private `resilient_ok`
// Msg, validate `result.output`, and snapshot it BEFORE `succeed` cleared the
// conversation on stage retire. The agent now models termination first-class:
// `state.output` holds the terminal turn on `done`, and `Runtime.result()` /
// `Runtime.done()` read it. A consumer reads `runtime.result()?.output` — no
// observer hook, no internal-Msg coupling, no state-clear race.

// ─────────────────────────────────────────────────────────────────────────────
// sseFromAgentEvents — drive an SseHub off the SEMANTIC AgentEvent stream (#47).
//
// The pre-#47 host fanned SSE frames off `runtime.observe` by hand-matching the
// agent's PRIVATE Msg names (`resilient_ok` / `agent_tool_ok`) — coupling the
// transport to the retry/loop plumbing. This wires the hub to `runtime.on`
// instead: the runtime (built with `events: agentEvents()`) projects the public
// `AgentEvent` union, and this helper subscribes ONE `on(type, …)` per event
// type and pushes `toFrame(event)` (or `null` to skip) at the hub. The SSE seam
// now reads the named lifecycle events, never the firehose, never a private Msg.
//
// Built on `runtime.on` (the typed semantic channel) rather than `sseProjection`
// because SSE is the volatile, offset-free case — a live `/sse` stream has no
// durable read model to resume — so the projection-registry's offset machinery
// buys nothing here. A consumer wanting SSE on the SAME registry as a durable
// report projection still uses `sseProjection`; this is the lighter path that
// expresses "SSE = a projection of the semantic event stream" directly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wire an {@link SseHub} to a runtime's semantic {@link AgentEvent} stream (#47).
 * For each event `type` the runtime can emit, subscribes via `runtime.on` and
 * pushes `toFrame(event)` at the hub (returning `null` skips that event). The
 * runtime MUST have been built with `run(machine, { events: agentEvents() })`,
 * which is what makes `on` deliver the `AgentEvent`s. Returns a cleanup that
 * detaches every subscription.
 *
 * This is the runtime→SSE adapter expressed over the typed event channel: no
 * `observe` firehose, no private-Msg coupling. `hub.open()` and every existing
 * `sseHub` caller are unchanged — only the SOURCE of `hub.emit` moves from a
 * hand-rolled Msg switch to `on`.
 *
 * @example
 *   const hub = sseHub<MyFrame>();
 *   const runtime = await run(machine, { ctx, events: agentEvents() }).ready;
 *   const off = sseFromAgentEvents(runtime, hub, (e) =>
 *     e.type === "RunDone" ? { kind: "done", output: e.output } : null,
 *   );
 *   // /sse route unchanged:
 *   return hub.open();
 */
export function sseFromAgentEvents<R, Frame>(
  runtime: {
    on<K extends AgentEvent<R>["type"]>(
      type: K,
      handler: (event: Extract<AgentEvent<R>, { type: K }>) => void,
    ): () => void;
  },
  hub: SseHub<Frame>,
  toFrame: (event: AgentEvent<R>) => Frame | null,
): () => void {
  const push = (event: AgentEvent<R>): void => {
    const frame = toFrame(event);
    if (frame !== null) hub.emit(frame);
  };
  // One subscription per event type — the closed `AgentEvent` union enumerated
  // here so a new variant forces a wiring decision at compile time.
  const offs = [
    runtime.on("TurnSettled", push),
    runtime.on("ToolSettled", push),
    runtime.on("RunDone", push),
  ];
  return () => {
    for (const off of offs) off();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// dispatchToIdle — run-to-quiescence (core lift).
//
// `runtime.dispatch(msg)` resolves when that ONE transition's effects settle,
// but an interpret handler that returns a follow-up Msg enqueues it as a fresh
// transition on the tail — `dispatch` does NOT await that follow-up. This is the
// "dispatch + `runtime.idle()`" pair as one call, so hosts/tests stop pairing
// the two by hand after every kick. Built on the core `runtime.idle()` (added to
// the `Runtime` interface) — no tail-poll hack.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch `msg` and resolve only once the runtime has drained every follow-up
 * Msg the transition (transitively) enqueued — run-to-quiescence. Sugar over
 * `await runtime.dispatch(msg); await runtime.idle();`.
 *
 * Replaces the consumer's / test's `until(() => cond)` poll after a `dispatch`
 * for the common "dispatch, then let the loop settle" case. (A poll is still
 * the right tool when waiting on an EXTERNAL event — e.g. a WS reply — that the
 * runtime cannot enqueue itself.)
 */
export async function dispatchToIdle<M extends { type: string }>(
  runtime: Runtime<unknown, M>,
  msg: M,
): Promise<void> {
  await runtime.dispatch(msg);
  await runtime.idle();
}

// ─────────────────────────────────────────────────────────────────────────────
// createAgentHost — the runtime+events+autoBoot assembly + the test seam, ONCE
// (issue #53).
//
// Every DO that drives a `createAgent` runtime hand-rolls the SAME ordered
// wiring inside its `getRuntime()`: build the machine → `doStore` → `run(...)`
// with `terminal` + `events: agentEvents()` → wire `sseFromAgentEvents` →
// `autoBoot` → `await ready` → cache. And every one re-exposes the SAME
// framework test surface as public methods (`isSuspended` / `runPhase` /
// `verdict` / `settle`). The pieces below (`deferredGateway`, `autoBoot`,
// `sseFromAgentEvents`, …) already lift each STEP; this lifts the ASSEMBLY.
//
// `createAgentHost(config)` owns:
//   - the lazy build-once-boot-once runtime cell (the `if (this.runtime) return`
//     dance + the `await booting.ready` gate),
//   - the `events: agentEvents()` wiring + `sseFromAgentEvents(runtime, hub, …)`
//     so SSE is driven off the SEMANTIC `AgentEvent` stream, never the private
//     Msg firehose,
//   - the `autoBoot` re-fire on a rehydrated suspended run,
//   - the SSE hub (so `host.sse.open()` / `host.sse.register(...)` is the route +
//     the test seam), and
//   - the framework test/lifecycle seam ONCE: `status()`, `result()`, `reset()`.
//
// The consumer supplies ONLY its mappings: how to build the machine, the Store,
// the Ctx, the terminal predicate, and the `AgentEvent → SSE frame` projection.
// Its `getRuntime()` collapses to `host.runtime()`; its `isSuspended` /
// `runPhase` / `verdict` collapse to reads off `host.status()` / `host.result()`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the consumer supplies to {@link createAgentHost} — the domain mappings,
 * nothing of the wiring. `Stage`/`P`/`O`/`R` are the agent slice's type
 * parameters (the consumer names them once); `Frame` is its SSE event shape.
 */
export interface AgentHostConfig<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
> {
  /**
   * Build the wired agent machine. Called once per host build (per activation),
   * AFTER the previous runtime — if any — was torn down. The consumer wires its
   * per-tool interpret here (`agent.toMachine({ toolInterpret })`).
   */
  readonly buildMachine: () => Machine<
    AgentState<Stage, P, O, R>,
    AgentMachineMsg<P, O, R>,
    // The host does not name the consumer's Cmd / Sub / Ctx — `run` infers them
    // from the machine. `never`/`unknown` here keep the host Cmd/Sub-agnostic
    // while the machine itself stays fully typed at the consumer's call site.
    // biome-ignore lint/suspicious/noExplicitAny: host is Cmd/Sub/Ctx-agnostic; the machine carries the real types.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    any,
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    any
  >;
  /** The durable `Store` for the agent slice (typically `doStore(storage, parse)`). */
  readonly store: Store<AgentState<Stage, P, O, R>>;
  /** The Ctx the machine threads to its interpret cells. */
  readonly ctx: unknown;
  /**
   * The run-terminality predicate (#46) — what makes `result()` first-class.
   * Defaults to the agent's own terminal phases (`done` / `failed`).
   */
  readonly terminal?: (state: AgentState<Stage, P, O, R>) => boolean;
  /**
   * Map one semantic {@link AgentEvent} to the consumer's SSE frame, or `null`
   * to skip it. This is the ONLY place the consumer touches the SSE seam — the
   * host owns the subscription wiring (`sseFromAgentEvents`) and the hub.
   */
  readonly toSseFrame: (event: AgentEvent<R>) => Frame | null;
  /** Clock injected for `autoBoot` (the host's only boot clock read). */
  readonly now?: () => number;
}

/**
 * The assembled host: the runtime cell + the SSE hub + the framework test seam,
 * owned ONCE. A DO holds one `AgentHost` and delegates to it; its own surface
 * shrinks to the domain (the gateway, the WS bridge, the command-send mapping).
 *
 * @typeParam Stage Pipeline stage type.
 * @typeParam P     Brain-call purposes.
 * @typeParam O     Per-purpose outputs (bound to {@link AgentTurn}).
 * @typeParam R     Tool result type.
 * @typeParam Frame The consumer's SSE event shape.
 */
export interface AgentHost<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
> {
  /**
   * Get (or build) the booted runtime. Build-once-boot-once: the first call
   * builds the machine, wires SSE off the semantic event stream, awaits the boot
   * gate, runs the `autoBoot` re-fire for a rehydrated suspended run, and caches
   * the booted `Runtime`; subsequent calls return the cached handle. The single
   * assembly every consumer used to hand-roll in `getRuntime()`.
   */
  runtime(): Promise<
    Runtime<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>, AgentEvent<R>>
  >;
  /**
   * The agent's lifecycle status (#49) — the ONE typed channel a consumer reads
   * instead of re-deriving `run.phase` / `awaiting` by hand. Ensures the runtime
   * is built + boot-reconciled first. Replaces the per-consumer `isSuspended` /
   * `runPhase` test methods (read `status().kind`).
   */
  status(): Promise<AgentStatus<Stage>>;
  /**
   * The run's terminal State (#46), or `undefined` while in flight. Read the
   * run's product off it (e.g. `result()?.output`). Replaces the per-consumer
   * `verdict` plumbing's source. Ensures the runtime is built first.
   */
  result(): Promise<AgentState<Stage, P, O, R> | undefined>;
  /**
   * The SSE hub — the route (`host.sse.open()`) AND the test seam
   * (`host.sse.register(sink)`). The host drives `hub.emit` off the semantic
   * event stream; the consumer never touches it except to open / register.
   */
  readonly sse: SseHub<Frame>;
  /**
   * Tear down the cached runtime (drain its tail via `stop()`, drop the handle)
   * so the next `runtime()` rebuilds from storage. The framework `settle` test
   * seam, owned once.
   */
  reset(): Promise<void>;
}

/**
 * Build an {@link AgentHost} from the consumer's domain mappings. Owns the
 * runtime+events+autoBoot assembly and the framework test seam — the wiring
 * issue #53 had every consumer re-write.
 *
 * @example
 *   const host = createAgentHost<Stage, Purpose, Outputs, ClientResult, SseEvent>({
 *     buildMachine: () => agent.toMachine<Ctx>({ toolInterpret }),
 *     store: doStore(storage, parse),
 *     ctx,
 *     toSseFrame: (e) =>
 *       e.type === "ToolSettled" ? { kind: "result", ...} :
 *       e.type === "TurnSettled" && e.turn.toolCalls.length === 0
 *         ? { kind: "verdict", verdict: e.turn.content } :
 *       e.type === "RunDone" ? { kind: "phase", phase: "done" } : null,
 *   });
 *   // route:   return host.sse.open();
 *   // start:   await (await host.runtime()).dispatch({ type: "agent_start", ... });
 *   // test:    (await host.status()).kind === "suspended"
 */
export function createAgentHost<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
>(
  config: AgentHostConfig<Stage, P, O, R, Frame>,
): AgentHost<Stage, P, O, R, Frame> {
  type S = AgentState<Stage, P, O, R>;
  type M = AgentMachineMsg<P, O, R>;
  type E = AgentEvent<R>;

  const sse = sseHub<Frame>();
  const now = config.now ?? Date.now;
  const isTerminal =
    config.terminal ??
    ((s: S) => s.run.phase === "done" || s.run.phase === "failed");

  let cached: Runtime<S, M, E> | null = null;

  async function runtime(): Promise<Runtime<S, M, E>> {
    if (cached !== null) return cached;

    // `run()` hands back a `BootingRuntime` synchronously (#45). Wire the
    // SEMANTIC event projector (#47) so `runtime.on(...)` lights up, then drive
    // the SSE hub off that named stream (never the private-Msg firehose). The
    // `terminal` predicate makes `result()` / `done()` meaningful (#46).
    const booting: BootingRuntime<S, M, E> = run(config.buildMachine(), {
      ctx: config.ctx,
      store: config.store,
      events: agentEvents<Stage, P, O, R>(),
      terminal: isTerminal,
    });

    // SSE off the semantic stream. Subscriptions attach on the booting handle
    // (total before boot), so the hub catches every event from the first
    // transition. The cleanup is implicit: the host tears the whole runtime
    // down in `reset()`, dropping every subscription with it.
    sseFromAgentEvents(booting, sse, config.toSseFrame);

    // Re-fire the one outstanding tool effect IFF this wake rehydrated a
    // suspended run (no-op on a fresh DO). `autoBoot` awaits the same boot gate.
    await autoBoot(booting, now);
    cached = await booting.ready;
    return cached;
  }

  return {
    runtime,
    async status(): Promise<AgentStatus<Stage>> {
      return status((await runtime()).getState());
    },
    async result(): Promise<S | undefined> {
      return (await runtime()).result();
    },
    sse,
    async reset(): Promise<void> {
      if (cached === null) return;
      await cached.stop();
      cached = null;
    },
  };
}
