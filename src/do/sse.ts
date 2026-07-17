/// <reference types="@cloudflare/workers-types" />
/**
 * The runtime→SSE plumbing — the hub, its projection expression, and the
 * semantic-event adapter. See `./host` for the transport-model rationale.
 */

import type { AgentEvent } from "../agent/index";
import type { Projection } from "./projection";

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
