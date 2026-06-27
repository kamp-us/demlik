// ---------------------------------------------------------------------------
// @demlik/tea/subs — universal Sub factories.
//
// Eight factories absorb the recurring `(sub, ctx, dispatch) => cleanup`
// shape of every cross-cutting Sub topology: timers, DOM events,
// BroadcastChannel pub/sub, cross-runtime Ports, SSE streams, and
// bidirectional WebSocket streams — one-shot (`fromWebSocket`) and
// auto-reconnecting with capped backoff (`fromReconnectingWebSocket`).
// Callers compose them into
// `machine.subscribe[type]` cells — the factory absorbs the lifecycle
// (subscribe + cleanup), the caller keeps the intent (which Msg, which
// channel/port/runtime).
//
// Subpath separation rationale (mirrors `@demlik/tea/testing`): the main
// `@demlik/tea` entry stays substrate-only; these factories depend on
// platform globals (`setInterval`, `EventTarget`, `BroadcastChannel`,
// `EventSource`, `WebSocket`) that some consumers (pure unit tests,
// server-only substrate users) MUST be able to skip. Importing them
// from a separate subpath pins the dependency at the package boundary.
//
// Excluded from v1:
//   - fromAbortableFetch — niche; one-off recipe in callers.
//   - Chrome-specific factories (chrome.alarms, chrome.tabs,
//     chrome.runtime) — live in @demlik/tea/extension/subs, NOT here.
//   - DO-hibernation-safe WebSocket — deferred until a consumer needs it.
//
// Strengthens invariant 9 (the surface for cross-cutting Sub topologies
// is named, small, and exported from one subpath).
// ---------------------------------------------------------------------------

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
export type { SubscribeHandler } from "./types";
