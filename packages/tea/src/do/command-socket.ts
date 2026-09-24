/// <reference types="@cloudflare/workers-types" />
/**
 * The command-runner WebSocket host + broadcast — the WS half of the
 * `@demlik/tea/do` transport, in both the resident (`acceptCommandSocket`) and
 * hibernation-aware (`acceptDurableCommandSocket`) forms. See `./host` for the
 * transport-model rationale (ONE Sub type, gateway-bridged I/O).
 */

import { broadcastFrame } from "./presence";

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
 *
 * Thin delegation to {@link broadcastFrame} — the general fan-out (serialize
 * once, send to every OPEN socket, skip a closed/errored one). The
 * {@link BroadcastReport} it returns is discarded here to keep the `void`
 * command-socket signature.
 */
export function broadcast(clients: Set<WebSocket>, frame: unknown): void {
  broadcastFrame(clients, frame);
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
// The carrier stays OUTSIDE the agent's Sub system (the `./host` rationale): the
// round-trip is still a Promise the interpret cell awaits, bridged into
// `dispatch` by the gateway. The DURABILITY lives in the ledger + the consumer's
// storage, NOT in widening the machine's Sub type. `acceptCommandSocket` keeps
// working untouched for callers that do not need eviction survival. (The carrier
// itself lives in `./deferred-gateway`; the wake-path re-emit in `./resume`.)
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
 *
 * Thin delegation to {@link broadcastFrame} over `ctx.getWebSockets()` — the
 * general fan-out (serialize once, send to every OPEN socket, skip a
 * closed/errored one). The {@link BroadcastReport} it returns is discarded here
 * to keep the `void` command-socket signature.
 */
export function broadcastHibernatable(
  ctx: HibernatableCtx,
  frame: unknown,
): void {
  broadcastFrame(ctx.getWebSockets(), frame);
}
