/// <reference types="@cloudflare/workers-types" />
/**
 * The runtime→SSE plumbing — the hub, its projection expression, and the
 * semantic-event adapter. See `./host` for the transport-model rationale.
 */

import { AGENT_EVENT_TYPES, type AgentEvent } from "../agent/index";
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

/**
 * The SSE fields one event is written as, per the event stream format of the
 * HTML Living Standard ("Server-sent events").
 *
 *   - `event` becomes the `event:` field, so a browser `EventSource` delivers
 *     the frame to `addEventListener(event)` instead of `onmessage`. Leave it
 *     out for an unnamed `message` event.
 *   - `data` becomes one `data:` line per line of the string. The client joins
 *     those lines with `\n`, so every line break in `data` (`\n`, `\r\n` or
 *     `\r`) arrives as `\n`.
 *   - `id` becomes the `id:` field, the client's last event ID.
 *
 * `event` and `id` hold no line break, and `id` holds no NUL: a frame that
 * breaks either rule throws {@link SseFrameError} out of `emit` or `open`.
 */
export interface SseFrame {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
}

/** Thrown when an {@link SseFrame} has a field the event stream cannot carry. */
export class SseFrameError extends Error {
  /** The field that cannot be written. */
  readonly field: "event" | "id";

  constructor(field: "event" | "id", reason: string) {
    super(`SSE frame field "${field}" ${reason}`);
    this.name = "SseFrameError";
    this.field = field;
  }
}

/**
 * Options for {@link sseHub}. Every option is optional; with none the hub
 * writes exactly what it always has: `data: <json>\n\n` per event.
 */
export interface SseHubOptions<E> {
  /**
   * Map an event to its SSE fields. Defaults to `{ data: JSON.stringify(event) }`.
   * A throw from it, or an {@link SseFrameError} for the fields it returns,
   * propagates out of `emit` or `open` to the host, and the event reaches no
   * stream and no registered sink.
   */
  readonly frame?: (event: E) => SseFrame;
  /**
   * Write a comment frame (`: keepalive`) to each open stream every
   * `keepaliveMs` milliseconds, so a proxy does not close an idle stream. The
   * hub owns one interval per open stream and clears it when that stream is
   * cancelled or the hub is closed. While a stream's client is not reading,
   * no further comment is queued for it. Off when left out; anything but a
   * number above 0 and at most 2147483647 (the longest timer delay) makes
   * `sseHub` throw a `RangeError`.
   */
  readonly keepaliveMs?: number;
  /**
   * The events a client that connects now receives before any live event,
   * asked for each time a stream opens (and each time `register` is called).
   * Which events it holds is the host's decision; the hub keeps no buffer of
   * its own. It is called synchronously in the same step that subscribes the
   * new stream, so every event emitted before `open` belongs in the snapshot
   * and every event emitted after reaches the stream live. An event emitted
   * while the snapshot is being taken is delivered live, after the snapshot.
   */
  readonly snapshot?: () => Iterable<E>;
}

/**
 * An {@link SseHub} that can also end every stream it has opened. What
 * {@link sseHub} returns.
 */
export interface SseStreamHub<E> extends SseHub<E> {
  /**
   * End every open stream and drop every registered sink. After `close`,
   * `emit` reaches no one, `open` returns a stream that carries the snapshot
   * and then ends, and `register` hands the sink the snapshot and subscribes
   * nothing. Called from a registered sink while an event is being delivered,
   * it lets that event reach every stream and sink first, then ends them.
   * Calling it again does nothing.
   */
  close(): void;
  /** Whether {@link SseStreamHub.close} has been called. */
  readonly closed: boolean;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

const KEEPALIVE_FRAME = ": keepalive\n\n";

function checkField(field: "event" | "id", value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new SseFrameError(field, "must not contain a line break");
  }
  if (field === "id" && value.includes("\0")) {
    throw new SseFrameError(field, "must not contain NUL");
  }
}

function writeFrame(frame: SseFrame): string {
  let text = "";
  if (frame.event !== undefined) {
    checkField("event", frame.event);
    text += `event: ${frame.event}\n`;
  }
  if (frame.id !== undefined) {
    checkField("id", frame.id);
    text += `id: ${frame.id}\n`;
  }
  for (const line of frame.data.split(/\r\n|\r|\n/)) {
    text += `data: ${line}\n`;
  }
  return `${text}\n`;
}

type Target<E> = {
  readonly deliver: (event: E, bytes: Uint8Array | null) => void;
  readonly end: () => void;
};

const MAX_TIMER_MS = 2_147_483_647;

type Delivery<E> = { readonly event: E; readonly bytes: Uint8Array | null };

type Opening<E> = { readonly pending: Delivery<E>[] };

/**
 * Build an SSE hub for event type `E` (the consumer's domain event shape).
 *
 * With no options it writes `data: <json>\n\n` per event, as it always has.
 * {@link SseHubOptions} adds named frames, a keepalive comment, a replay
 * snapshot for a late client, and {@link SseStreamHub.close} ends every stream.
 *
 * @example
 * ```ts
 * import { sseHub } from "@demlik/tea/do";
 *
 * type RunEvent =
 *   | { kind: "turn"; turn: number }
 *   | { kind: "status"; status: string };
 *
 * const turns: RunEvent[] = [];
 * let status: RunEvent | null = null;
 * const hub = sseHub<RunEvent>({
 *   frame: (e) => ({ event: e.kind, data: JSON.stringify(e) }),
 *   keepaliveMs: 15_000,
 *   snapshot: () => (status === null ? turns : [...turns, status]),
 * });
 * const record = (e: RunEvent): void => {
 *   if (e.kind === "turn") turns.push(e);
 *   else status = e;
 *   hub.emit(e);
 * };
 * record({ kind: "turn", turn: 1 });
 * const sseRoute = (): Response => hub.open();
 * const onRunEnd = (): void => hub.close();
 * ```
 */
export function sseHub<E>(options: SseHubOptions<E> = {}): SseStreamHub<E> {
  const { frame, keepaliveMs, snapshot } = options;
  if (
    keepaliveMs !== undefined &&
    !(
      Number.isFinite(keepaliveMs) &&
      keepaliveMs > 0 &&
      keepaliveMs <= MAX_TIMER_MS
    )
  ) {
    throw new RangeError(
      `sseHub keepaliveMs must be a number above 0 and at most ${MAX_TIMER_MS}, got ${keepaliveMs}`,
    );
  }
  const targets = new Set<Target<E>>();
  const streams = new Set<Target<E>>();
  const sinks = new Map<(event: E) => void, Target<E>>();
  const openings = new Set<Opening<E>>();
  const encoder = new TextEncoder();
  let closed = false;
  let delivering = 0;

  const encode = (event: E): Uint8Array | null => {
    if (frame !== undefined) return encoder.encode(writeFrame(frame(event)));
    try {
      return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      return null;
    }
  };

  const join = (
    fromSnapshot: (event: E) => void,
    fromLive: (delivery: Delivery<E>) => void,
    subscribe: () => void,
  ): void => {
    const opening: Opening<E> = { pending: [] };
    openings.add(opening);
    try {
      const events = snapshot === undefined ? [] : [...snapshot()];
      for (const event of events) fromSnapshot(event);
      for (
        let next = opening.pending.shift();
        next !== undefined;
        next = opening.pending.shift()
      ) {
        fromLive(next);
      }
    } finally {
      openings.delete(opening);
    }
    if (!closed) subscribe();
  };

  const fanOut = (event: E): void => {
    const bytes =
      frame !== undefined || streams.size > 0 || openings.size > 0
        ? encode(event)
        : null;
    for (const opening of openings) opening.pending.push({ event, bytes });
    const list = snapshot === undefined ? targets : [...targets];
    delivering += 1;
    try {
      for (const target of list) {
        if (targets.has(target)) target.deliver(event, bytes);
      }
    } finally {
      delivering -= 1;
      if (closed && delivering === 0) endAll();
    }
  };

  const endAll = (): void => {
    for (const target of [...targets]) target.end();
    targets.clear();
    streams.clear();
    sinks.clear();
  };

  return {
    get closed() {
      return closed;
    },
    emit(event) {
      if (closed) return;
      fanOut(event);
    },
    open() {
      let live: Target<E> | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let unread = false;
      const stop = (): void => {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        if (live !== undefined) {
          targets.delete(live);
          streams.delete(live);
        }
      };
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const put = (bytes: Uint8Array | null): void => {
            if (bytes !== null) controller.enqueue(bytes);
          };
          join(
            (event) => put(encode(event)),
            (delivery) => put(delivery.bytes),
            () => {
              live = {
                deliver: (_event, chunk) => {
                  if (chunk === null) return;
                  try {
                    controller.enqueue(chunk);
                  } catch {
                    stop();
                  }
                },
                end: () => {
                  stop();
                  try {
                    controller.close();
                  } catch {}
                },
              };
              targets.add(live);
              streams.add(live);
              if (keepaliveMs === undefined) return;
              const comment = encoder.encode(KEEPALIVE_FRAME);
              timer = setInterval(() => {
                const room = controller.desiredSize;
                if (room === null) {
                  stop();
                  return;
                }
                if (room <= 0 && unread) return;
                unread = true;
                try {
                  controller.enqueue(comment);
                } catch {
                  stop();
                }
              }, keepaliveMs);
            },
          );
          if (closed) controller.close();
        },
        pull: () => {
          unread = false;
        },
        cancel: stop,
      });
      return new Response(body, { headers: SSE_HEADERS });
    },
    register(sink) {
      join(
        sink,
        (delivery) => sink(delivery.event),
        () => {
          if (sinks.has(sink)) return;
          const target: Target<E> = {
            deliver: (event) => {
              try {
                sink(event);
              } catch {}
            },
            end: () => {},
          };
          sinks.set(sink, target);
          targets.add(target);
        },
      );
      return () => {
        const target = sinks.get(sink);
        if (target === undefined) return;
        sinks.delete(sink);
        targets.delete(target);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      if (delivering === 0) endAll();
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
 * ```ts
 * import type { Runtime } from "@demlik/tea";
 * import {
 *   driveProjections,
 *   projectionRegistry,
 *   sseHub,
 *   sseProjection,
 * } from "@demlik/tea/do";
 *
 * type MyState = { readonly turns: number };
 * type MyMsg = { _tag: "turn_done"; turn: number } | { _tag: "tick" };
 * type MyEvent = { kind: "turn"; turn: number };
 * declare const runtime: Runtime<MyState, MyMsg>;
 *
 * const hub = sseHub<MyEvent>();
 * const registry = projectionRegistry<MyState, MyMsg>();
 * registry.register(sseProjection(hub, (msg: MyMsg | null) =>
 *   msg?._tag === "turn_done" ? { kind: "turn", turn: msg.turn } : null,
 * ));
 * driveProjections(registry, runtime); // SSE is now one projection
 * // /sse route unchanged:
 * const sseRoute = (): Response => hub.open();
 * ```
 */
export function sseProjection<Model, Msg extends { _tag: string }, E>(
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
// sseFromAgentEvents — drive an SseHub off the SEMANTIC AgentEvent stream.
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
 * Wire an {@link SseHub} to a runtime's semantic {@link AgentEvent} stream.
 * For each event `_tag` the runtime can emit, subscribes via `runtime.on` and
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
 * ```ts
 * import type { Runtime } from "@demlik/tea";
 * import type { AgentEndedStatus, AgentEvent } from "@demlik/tea/agent";
 * import { sseFromAgentEvents, sseHub } from "@demlik/tea/do";
 *
 * type MyFrame = { kind: "ended"; status: AgentEndedStatus };
 * // Built with `run(machine, { ctx, events: agentEvents() }).ready`.
 * declare const runtime: Runtime<unknown, { _tag: string }, AgentEvent<string>>;
 *
 * const hub = sseHub<MyFrame>();
 * const off = sseFromAgentEvents(runtime, hub, (e) =>
 *   e._tag === "RunDone" ? { kind: "ended", status: e.status } : null,
 * );
 * // /sse route unchanged:
 * const sseRoute = (): Response => hub.open();
 * ```
 */
export function sseFromAgentEvents<R, Frame>(
  runtime: {
    on<K extends AgentEvent<R>["_tag"]>(
      type: K,
      handler: (event: Extract<AgentEvent<R>, { _tag: K }>) => void,
    ): () => void;
  },
  hub: SseHub<Frame>,
  toFrame: (event: AgentEvent<R>) => Frame | null,
): () => void {
  const push = (event: AgentEvent<R>): void => {
    const frame = toFrame(event);
    if (frame !== null) hub.emit(frame);
  };
  // One subscription per event type, off the one list that is checked against
  // the `AgentEvent` union, so a new variant reaches `toFrame` without an edit
  // here.
  const offs = AGENT_EVENT_TYPES.map((type) => runtime.on(type, push));
  return () => {
    for (const off of offs) off();
  };
}
