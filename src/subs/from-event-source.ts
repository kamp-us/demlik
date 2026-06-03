// ---------------------------------------------------------------------------
// fromEventSource — universal `EventSource` (server-sent events) Sub
// factory.
//
// SSE is the asymmetric streaming protocol used by the agent log /
// audit log pipelines: HTTP-shaped open, server pushes events forever,
// client receives until close. `EventSource` is the standard browser
// API; the constructor opens the connection, `message` fires per
// server-pushed event, `error` fires on disconnect or non-2xx, `open`
// fires once on initial handshake, `close()` tears the connection
// down.
//
// Three callbacks because three observable events ARE three concerns
// the caller routinely cares about:
//
//   - `onMessage(data, sub)` — required. The SSE payload's `data` field
//     is `string` from the platform; the caller decides parse + Msg
//     shape. Returns `M | null`; null drops the dispatch.
//
//   - `onError(event, sub)` — optional. SSE's `error` event fires both
//     on transient network drops (the browser auto-reconnects) AND on
//     permanent failures. Most consumers want to surface ONE of these
//     as a Msg (e.g. "stream-disconnected") without folding both into
//     `onMessage`'s discriminant. Omitting the callback drops error
//     events silently.
//
//   - `onOpen(sub)` — optional. The connection's initial handshake
//     succeeded. Useful for "show 'connected' indicator" Msgs. Omitting
//     drops open events silently. NOT fired on auto-reconnect by every
//     browser implementation — treat the event as best-effort.
//
// `url` lives on the Sub itself (`EventSourceSubData`). Same id +
// different url = the substrate's reconcile pass leaves the existing
// connection alone (the URL change is silent). Changing the URL
// requires a new Sub.id.
//
// Cleanup is `close()` + `removeEventListener` for all three —
// belt-and-suspenders against EventSource implementations that
// dispatch events into already-closed sources.
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type { MinimalEvent, MinimalEventSourceCtor, MinimalMessageEvent } from "./platform";
import type { SubscribeHandler } from "./types";

type EventSourceSubData = { url: string };

declare const EventSource: MinimalEventSourceCtor;

export interface EventSourceFactoryOpts<S, M> {
  onMessage: (data: string, sub: S) => M | null;
  onError?: (event: MinimalEvent, sub: S) => M | null;
  onOpen?: (sub: S) => M | null;
}

export function fromEventSource<S extends Sub & EventSourceSubData, M>(
  opts: EventSourceFactoryOpts<S, M>,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const source = new EventSource(sub.url);

    const messageListener = (event: MinimalMessageEvent): void => {
      // The SSE `data` payload is a string per the platform contract.
      // Cast at the boundary: callers express `(data: string) => M | null`
      // and never see `unknown` flowing in from the platform global.
      const msg = opts.onMessage(event.data as string, sub);
      if (msg !== null) dispatch(msg);
    };
    source.addEventListener("message", messageListener);

    const onError = opts.onError;
    const errorListener = onError
      ? (event: MinimalEvent): void => {
          const msg = onError(event, sub);
          if (msg !== null) dispatch(msg);
        }
      : undefined;
    if (errorListener) source.addEventListener("error", errorListener);

    const onOpen = opts.onOpen;
    const openListener = onOpen
      ? (): void => {
          const msg = onOpen(sub);
          if (msg !== null) dispatch(msg);
        }
      : undefined;
    if (openListener) source.addEventListener("open", openListener);

    return () => {
      source.removeEventListener("message", messageListener);
      if (errorListener) source.removeEventListener("error", errorListener);
      if (openListener) source.removeEventListener("open", openListener);
      source.close();
    };
  };
}
