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

import type { AgentMachineMsg, AgentState, AgentTurn } from "../agent/index";
import { isAgentTurn } from "../agent/index";
import type { Runtime } from "../index";
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
 * tools) — the resumable case `agent_boot` re-fires. This is the agent's own
 * suspend predicate, lifted out of the consumer so it stops re-deriving the
 * `awaiting.kind === "tools"` shape by hand.
 */
export function agentIsResumable<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(state: AgentState<Stage, P, O, R>): boolean {
  return (
    state.run.phase === "running" &&
    state.conversation !== null &&
    state.conversation.awaiting.kind === "tools"
  );
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
  runtime: Runtime<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>>,
  now: () => number = Date.now,
): Promise<void> {
  await runtime.ready;
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
// captureLastTurn — clean terminal-output access (seam E).
//
// CAUSE: the agent's `advanceStage` clears `conversation` to `null` when a stage
// retires (and the whole pipeline finishes `done`), so a consumer that reads
// `state.conversation` after the run completes sees nothing — it was forced to
// scrape the verdict off the transition stream (`lastVerdict`).
//
// FIX (host-side, no agent change): the agent already RE-ENTERS every brain turn
// as a `resilient_ok` Msg whose `result.output` is the parsed `AgentTurn`. That
// Msg fires on the runtime's observe channel BEFORE `succeed` advances + clears
// the conversation. So the host attaches one `observe` hook that snapshots the
// last `AgentTurn` the agent produced — the run's terminal output survives the
// stage retire. The consumer reads `lastTurn()` instead of scraping the stream.
//
// (We keep the fix in the host rather than the agent: clearing `conversation`
// on retire is correct durability hygiene — a finished stage's transcript is not
// live state. The right place to PRESERVE a terminal read is the observability
// layer the host already owns, not the durable slice.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture the last `AgentTurn` an agent runtime produces, off its `resilient_ok`
 * settle Msg. Returns `{ last, stop }`:
 *   - `last()` — the most recent `AgentTurn` the brain produced, or `null` before
 *     the first turn settles. Survives the conversation clear on stage retire.
 *   - `stop()` — detach the observer (idempotent).
 *
 * Deletes the consumer's `lastVerdict` field + the `resilient_ok` branch in its
 * `streamTransition` that snapshotted it. The consumer maps the captured turn to
 * its own terminal shape (e.g. a verdict = the turn with no tool calls).
 */
export function captureLastTurn<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(
  runtime: Runtime<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>>,
): { last(): AgentTurn | null; stop(): void } {
  let lastTurn: AgentTurn | null = null;
  const unobserve = runtime.observe((msg) => {
    if (msg !== null && msg.type === "resilient_ok") {
      // `result.output` is the parsed brain turn (the agentic purpose's output
      // is an `AgentTurn` per the agent's config contract). Validate rather than
      // cast — this is the one spot that reads an unknown off the settle Msg, so
      // it uses the exported `isAgentTurn` witness instead of trusting the shape.
      const output: unknown = msg.result.output;
      if (isAgentTurn(output)) lastTurn = output;
    }
  });
  let stopped = false;
  return {
    last: () => lastTurn,
    stop: () => {
      if (stopped) return;
      stopped = true;
      unobserve();
    },
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
