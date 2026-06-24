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
 * ## The Sub-composition decision (why this host has no `do_ws` / `do_alarm`)
 *
 * `createAgent().toMachine()` fixes the machine's Sub type to `DeadlineSub` —
 * the agent owns the retry + watchdog timers and nothing else. The DO-native
 * `do_ws` / `do_alarm` subs in `./index` therefore CANNOT union into an agent
 * machine's Sub set without the consumer hand-rolling a wider machine.
 *
 * This host RESOLVES the seam by sidestepping it: the deferred-tool gateway
 * already owns each tool round-trip as a Promise the interpret cell awaits, and
 * the per-tool deadline is a `setTimeout`. So the host needs NEITHER `do_ws`
 * (inbound frames are bridged straight into `gateway.settle(...)` from the DO's
 * `webSocketMessage`, no Sub) NOR `do_alarm` (the deadline is a timer, not a DO
 * alarm). The agent's Sub type stays exactly `DeadlineSub`; the transport lives
 * outside the Sub system entirely, bridged into `dispatch` by the gateway. This
 * is the documented, deliberate choice over widening the agent's Sub union.
 */

import { type AgentMachineMsg, type AgentState, status } from "../agent/index";
import type { BootingRuntime, Runtime } from "../index";
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
>(
  booting: BootingRuntime<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>>,
  now: () => number = Date.now,
): Promise<void> {
  // `await ready` is the single boot gate (issue #45): it resolves to the
  // booted `Runtime` whose `getState()` is total. Reading the rehydrated slice
  // off `run()`'s synchronous handle is no longer possible — and that is the
  // point: we cannot inspect state before boot has populated it.
  const runtime = await booting.ready;
  if (agentIsResumable(runtime.getState())) {
    await runtime.dispatch({ type: "agent_boot", at: now() });
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
