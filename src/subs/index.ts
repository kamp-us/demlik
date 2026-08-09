/**
 * @packageDocumentation
 * @demlik/tea/subs — universal Sub factories.
 *
 * Eleven factories absorb the recurring `(sub, ctx, dispatch) => cleanup`
 * shape of every cross-cutting Sub topology: timers, DOM events,
 * BroadcastChannel pub/sub, cross-runtime Ports, SSE streams, and
 * bidirectional WebSocket streams — one-shot (`fromWebSocket`) and
 * auto-reconnecting with capped backoff (`fromReconnectingWebSocket`).
 * Callers compose them into `machine.subscribe[type]` cells — the factory
 * absorbs the lifecycle (subscribe + cleanup), the caller keeps the intent
 * (which Msg, which channel/port/runtime).
 *
 * Subpath separation rationale (mirrors `@demlik/tea/testing`): the main
 * `@demlik/tea` entry stays substrate-only; these factories depend on
 * platform globals (`setInterval`, `EventTarget`, `BroadcastChannel`,
 * `EventSource`, `WebSocket`) that some consumers (pure unit tests,
 * server-only substrate users) MUST be able to skip. Importing them from a
 * separate subpath pins the dependency at the package boundary.
 *
 * Three of the eleven are open-ended BATTERIES rather than fixed platform
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
 *     reaches the live channel without a hand-written registry.
 *     Transport-agnostic (workerd WebSocket, MessagePort, in-process stub),
 *     where `fromWebSocket` owns a concrete socket and is inbound-only.
 *   - `defineManagedResource` / `combineManagedResources` — a Model-gated
 *     resource with a MANDATORY `release`. `release` sees only what `acquire`
 *     returned, so a half-built resource can never dangle, and the teardown
 *     rides the reconcile pass instead of a start/end Cmd pair hand-driven
 *     across every transition cell.
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
  type CombinedManagedResources,
  combineManagedResources,
  type DefineManagedResourceOpts,
  defineManagedResource,
  type GatedManagedResource,
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
