/**
 * @packageDocumentation
 * Universal Sub factories — published on the root `@demlik/tea` door (#51; the
 * `/subs` door closed and its parts moved up, per ADR 0016).
 *
 * Each factory returns a sub runner — the `(sub, ctx, dispatch) => Dispose`
 * shape of every cross-cutting Sub topology: timers, DOM events,
 * BroadcastChannel pub/sub, cross-runtime Ports, SSE streams, and
 * bidirectional WebSocket streams — one-shot (`fromWebSocket`) and
 * auto-reconnecting with capped backoff (`fromReconnectingWebSocket`). The
 * machine declares the Sub as data (`subs: [{ type, deps(state) }]`); the
 * caller hands the runner to `run` under that type
 * (`run(machine, { subscribe: { [type]: runner } })`). The factory absorbs the
 * lifecycle (subscribe + cleanup) and reads its data off `sub.deps`; the caller
 * keeps the intent (which Msg, which channel/port/runtime). A changed `deps`
 * value is a new Sub id, so the engine stops the old runner and starts a new
 * one — no factory here watches its own deps.
 *
 * Subpath separation rationale (mirrors `@demlik/tea/testing`): the main
 * `@demlik/tea` entry stays substrate-only; these factories depend on
 * platform globals (`setInterval`, `EventTarget`, `BroadcastChannel`,
 * `EventSource`, `WebSocket`) that some consumers (pure unit tests,
 * server-only substrate users) MUST be able to skip. Importing them from a
 * separate subpath pins the dependency at the package boundary.
 *
 * Three of them are open-ended BATTERIES rather than fixed platform
 * bindings — they take the platform as a parameter, so one call covers a whole
 * topology instead of one socket:
 *
 *   - `defineListener` — the listener-as-resource primitive. Turns an
 *     imperative `add`/`remove` pair into a Sub whose disposer is DERIVED, so
 *     a no-op cleanup, or a `remove` handed a different function than `add`
 *     saw, is unrepresentable. Every hand-rolled `from*` skeleton collapses
 *     onto it.
 *   - `fromTransport` — the duplex SEAM battery. Owns the inbound stream, the
 *     close → `*_lost` Msg, AND the outbound handle table, so a Cmd handler
 *     reaches the live channel by the seam's key without a hand-written
 *     registry. Transport-agnostic (workerd WebSocket, MessagePort, in-process
 *     stub), where `fromWebSocket` owns a concrete socket and is inbound-only.
 *   - `defineManagedResource` — a Model-gated resource with a MANDATORY
 *     `release`. `release` sees only what `acquire` returned, so a half-built
 *     resource can never dangle, and the teardown rides the reconcile pass
 *     instead of a start/end Cmd pair hand-driven across every transition cell.
 *
 * Both `fromTransport` and `defineManagedResource` hand back the `subs` entry
 * (`.depKeyed(when)`, whose deps is the battery's key) and the runner for
 * their Sub type (`.subscribe`); the battery's `name` is that type.
 *
 * Strengthens invariant 9 (the surface for cross-cutting Sub topologies is
 * named, small, and exported from one subpath).
 */

export { defineListener, type ListenerTarget } from "./define-listener";
export { fromBroadcastChannel } from "./from-broadcast-channel";
export {
  type EventSourceFactoryOpts,
  fromEventSource,
} from "./from-event-source";
export { fromEventTarget } from "./from-event-target";
export { fromInterval } from "./from-interval";
export { fromPort } from "./from-port";
export {
  type CancelTimer,
  fromReconnectingWebSocket,
  type ReconnectingWebSocketFactoryOpts,
} from "./from-reconnecting-web-socket";
export { fromTimeout } from "./from-timeout";
export {
  fromWebSocket,
  type WebSocketFactoryOpts,
  type WebSocketSubData,
} from "./from-web-socket";
export {
  type DefineManagedResourceOpts,
  defineManagedResource,
  type ManagedResourceBattery,
  type ManagedResourceSub,
} from "./managed-resource";
export {
  type FromTransportOpts,
  fromTransport,
  type Transport,
  type TransportBattery,
  type TransportFactory,
  type TransportSub,
} from "./transport";
export type { SubscribeHandler } from "./types";
