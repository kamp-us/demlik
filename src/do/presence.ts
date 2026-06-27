/// <reference types="@cloudflare/workers-types" />
/**
 * @demlik/tea/do — generic hibernatable PRESENCE + BROADCAST for a NATIVE
 * (non-agent) Durable-Object grain.
 *
 * ## The gap this fills
 *
 * `./host` ships `acceptCommandSocket` / `acceptDurableCommandSocket` /
 * `broadcast` / `broadcastHibernatable`, but those are framed for — and live
 * alongside — the LLM-agent **deferred-tool gateway** (`createAgentHost`): the
 * socket is "the command-runner socket", the frame is "a command", and the
 * fan-out is the agent's `sendCommand` loop. A plain realtime grain — a game
 * room, a presence list, a collab document — does not have an agent, a gateway,
 * or commands. It just wants to accept hibernatable client sockets and fan a
 * frame out to whoever is connected. Today every such grain (vortex's
 * `ArenaGrain`, #162) hand-rolls the same `ctx.acceptWebSocket(server)` +
 * `for (const ws of ctx.getWebSockets()) ws.send(...)` boilerplate (#181).
 *
 * This module lifts exactly that, decoupled from the agent host:
 *
 *   - {@link broadcastFrame} — the fan-out, with the **socket set as the input**
 *     (not a `ctx`), so it is a pure function testable with fake sockets and
 *     reusable over any iterable (`ctx.getWebSockets()`, a filtered subset, a
 *     test array). It serializes once, sends to every OPEN socket, and skips a
 *     closed/errored one — returning a {@link BroadcastReport} count rather than
 *     swallowing the skip silently (errors are data).
 *   - {@link registerHibernatableSocket} — register an already-created server
 *     socket on the DO via the Cloudflare **Hibernation API**
 *     (`ctx.acceptWebSocket`), optionally tagging it and persisting a
 *     per-socket attachment that survives eviction. Pure over the `ctx` +
 *     socket seam, so the registration logic is testable with fakes.
 *   - {@link acceptPresenceSocket} — the full upgrade: build the
 *     `WebSocketPair`, register the server end, and return the `server` socket
 *     plus the 101 upgrade `Response`. The one piece that touches the
 *     runtime-only `WebSocketPair` (so it is exercised by type, not by a unit
 *     test without workerd) — the registration it delegates to *is* unit-tested.
 *   - {@link presenceCount} — the live connection count off `ctx.getWebSockets`,
 *     the trivial roster-size lift a presence grain reaches for.
 *
 * It is transport/Msg-agnostic: `frame` is `unknown` (JSON-serialized by
 * default, or via a caller `serialize`), and nothing here references an agent,
 * a gateway, a Sub, or a Msg. It is ADDITIVE — `./host`'s agent-coupled
 * helpers keep working untouched for the agent consumer.
 */

/**
 * The minimal "send a string frame" surface {@link broadcastFrame} needs. A real
 * Cloudflare `WebSocket` satisfies it structurally (its `send` accepts a string
 * and it carries a numeric `readyState`), so `ctx.getWebSockets()` flows in
 * directly; a test supplies a fake with just `send` (and optionally
 * `readyState`).
 *
 * `readyState` is OPTIONAL: when present and not {@link WS_READY_STATE_OPEN},
 * the socket is skipped WITHOUT calling `send`; when absent, `send` is attempted
 * and a throw is caught (a fake that models only liveness via a throwing `send`
 * needs no `readyState`).
 */
export interface PresenceSocket {
  send(message: string): void;
  readonly readyState?: number;
}

/**
 * The Hibernation slice of `DurableObjectState` a presence grain needs — the
 * accept that hands the socket to the runtime (surviving eviction) and the
 * getter that repopulates the live set after a wake. A real `DurableObjectState`
 * satisfies this structurally; a test supplies a fake (no live Workers runtime
 * needed to exercise the accept/registry seam).
 */
export interface PresenceCtx {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

/**
 * The OPEN `readyState` value (`WebSocket.READY_STATE_OPEN` in the Cloudflare
 * runtime). Named here so {@link broadcastFrame} can skip a non-open socket
 * without referencing the runtime constant (keeping the fold pure + testable).
 */
export const WS_READY_STATE_OPEN = 1;

/**
 * What a {@link broadcastFrame} fan-out did, surfaced rather than swallowed:
 * `sent` is the number of sockets the frame reached; `skipped` is the number
 * passed over (not OPEN, errored on `send`, or the `except` socket). A caller
 * can log or assert these — a silent fan-out hides a room going dark.
 */
export interface BroadcastReport {
  readonly sent: number;
  readonly skipped: number;
}

/** Optional knobs for {@link broadcastFrame}. */
export interface BroadcastOptions<S extends PresenceSocket> {
  /**
   * A socket to exclude from the fan-out — typically the sender, so a collab /
   * chat frame is not echoed back to its originator. Compared by identity.
   */
  readonly except?: S;
  /**
   * How to turn `frame` into the wire string. Defaults to `JSON.stringify`.
   * Override for a non-JSON wire format (e.g. a pre-encoded string passthrough).
   */
  readonly serialize?: (frame: unknown) => string;
}

/**
 * Serialize `frame` ONCE and send it to every OPEN socket in `sockets`, skipping
 * any that is closed, errors on `send`, or is the `except` socket. The socket
 * set is the INPUT (not a `ctx`), so this is a pure function: pass
 * `ctx.getWebSockets()` in a live grain, a filtered subset for a targeted
 * fan-out, or a fake array in a test.
 *
 * Skip semantics (a dead socket never crashes the broadcast):
 *   - `readyState` present and not {@link WS_READY_STATE_OPEN} → skipped, `send`
 *     not called;
 *   - `send` throws (a socket closing mid-fan-out) → skipped, the throw is
 *     caught (the close lifecycle reaps it);
 *   - the `except` socket → skipped.
 *
 * Returns a {@link BroadcastReport} of `{ sent, skipped }` — the skip is data,
 * not silence.
 */
export function broadcastFrame<S extends PresenceSocket>(
  sockets: Iterable<S>,
  frame: unknown,
  options?: BroadcastOptions<S>,
): BroadcastReport {
  const serialize = options?.serialize ?? JSON.stringify;
  const except = options?.except;
  const json = serialize(frame);
  let sent = 0;
  let skipped = 0;
  for (const ws of sockets) {
    if (except !== undefined && ws === except) {
      skipped++;
      continue;
    }
    if (ws.readyState !== undefined && ws.readyState !== WS_READY_STATE_OPEN) {
      skipped++;
      continue;
    }
    try {
      ws.send(json);
      sent++;
    } catch {
      // A socket closing mid-broadcast is reaped by its close lifecycle; the
      // failed send is safe to drop here, surfaced as a skip rather than a throw.
      skipped++;
    }
  }
  return { sent, skipped };
}

/** Optional knobs for {@link registerHibernatableSocket} / {@link acceptPresenceSocket}. */
export interface RegisterOptions<A> {
  /**
   * Hibernation tags for the socket — the same strings `ctx.getWebSockets(tag)`
   * filters on, so a grain can fan out to a subset (e.g. a team, a channel).
   */
  readonly tags?: readonly string[];
  /**
   * A per-socket value to persist via `server.serializeAttachment` so it
   * survives DO eviction (e.g. the player/session id the grain re-reads in
   * `webSocketMessage`/`webSocketClose`). Omitted ⇒ no attachment written.
   */
  readonly attachment?: A;
}

/**
 * The subset of `WebSocket` {@link registerHibernatableSocket} writes to — the
 * attachment serializer. A real server `WebSocket` satisfies it; a test supplies
 * a fake that records the serialized attachment.
 */
export interface AttachableSocket {
  serializeAttachment(value: unknown): void;
}

/**
 * Register an already-created `server` socket on the DO via the Cloudflare
 * **Hibernation API**: `ctx.acceptWebSocket(server, tags)` hands the socket to
 * the runtime (it survives eviction and re-delivers inbound frames to the DO's
 * `webSocketMessage` lifecycle method), and — when an `attachment` is supplied —
 * persists it via `server.serializeAttachment` so it survives the wake.
 *
 * Pure over the `ctx` + socket seam (no `WebSocketPair` construction), so the
 * registration logic — that accept is called with the right tags, that the
 * attachment is serialized iff present — is unit-testable with fakes.
 * {@link acceptPresenceSocket} is the thin wrapper that also builds the pair.
 */
export function registerHibernatableSocket<S extends AttachableSocket, A>(
  ctx: PresenceCtx,
  server: S,
  options?: RegisterOptions<A>,
): void {
  // The Hibernation API accept: the runtime owns the socket across eviction; no
  // isolate-resident `message`/`close` listeners (those are lost on eviction) —
  // inbound frames arrive via the DO's `webSocketMessage` lifecycle method.
  ctx.acceptWebSocket(
    server as unknown as WebSocket,
    options?.tags === undefined ? undefined : [...options.tags],
  );
  if (options?.attachment !== undefined) {
    server.serializeAttachment(options.attachment);
  }
}

/** What {@link acceptPresenceSocket} hands back: the live server end (to send
 *  initial frames on) and the 101 upgrade `Response` (to return from `fetch`). */
export interface PresenceUpgrade {
  /** The server end of the pair — send the welcome / initial snapshot on it. */
  readonly server: WebSocket;
  /** The 101 Switching-Protocols upgrade response carrying the client end. */
  readonly response: Response;
}

/**
 * Accept a client WebSocket upgrade on a native DO and register it for
 * hibernation. Builds the `WebSocketPair`, registers the server end via
 * {@link registerHibernatableSocket} (tags + optional attachment), and returns
 * the `server` socket plus the 101 upgrade {@link PresenceUpgrade.response}.
 *
 * The caller's `fetch` collapses to: send any initial frames on `server`
 * (welcome, current roster/snapshot), then `return upgrade.response`. This lifts
 * the `new WebSocketPair()` + `ctx.acceptWebSocket` + `serializeAttachment` +
 * `new Response(null, { status: 101, webSocket })` boilerplate a presence grain
 * hand-rolls.
 *
 * NOTE: `WebSocketPair` is a runtime-only global (no workerd in unit tests), so
 * this assembly is exercised by TYPE here; its registration seam is unit-tested
 * via {@link registerHibernatableSocket}.
 *
 * @example
 *   async fetch(request: Request): Promise<Response> {
 *     if (request.headers.get("Upgrade") !== "websocket") {
 *       return new Response("expected a websocket upgrade", { status: 426 });
 *     }
 *     const { server, response } = acceptPresenceSocket(this.ctx, {
 *       attachment: { playerId },
 *     });
 *     server.send(JSON.stringify(welcome));
 *     server.send(JSON.stringify(room.snapshot()));
 *     return response;
 *   }
 */
export function acceptPresenceSocket<A>(
  ctx: PresenceCtx,
  options?: RegisterOptions<A>,
): PresenceUpgrade {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  registerHibernatableSocket(ctx, server, options);
  return {
    server,
    response: new Response(null, { status: 101, webSocket: client }),
  };
}

/**
 * The live connection count for a presence grain — `ctx.getWebSockets(tag)
 * .length`, repopulated by the runtime after a wake. Pass a `tag` to count only
 * the sockets registered under it. The trivial roster-size lift a presence /
 * game grain reaches for (vortex's `connectionCount`).
 */
export function presenceCount(ctx: PresenceCtx, tag?: string): number {
  return ctx.getWebSockets(tag).length;
}
