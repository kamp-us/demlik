// ---------------------------------------------------------------------------
// fromWebSocket — universal `WebSocket` Sub factory. The symmetric sibling
// of `fromEventSource`.
//
// WebSocket is the bidirectional streaming protocol used wherever the
// server pushes events AND the client pushes commands on the same
// connection. The constructor opens the connection, `onopen` fires once
// on handshake, `onmessage` fires per server-pushed frame, `onerror`
// fires on transient or permanent failure, `onclose` fires once on
// teardown carrying `code` + `reason`. `close(code)` initiates a clean
// shutdown from the client side.
//
// Four callbacks because four observable events ARE four concerns the
// caller routinely cares about. The Sub's `wsUrl` lives on the Sub itself
// (`WebSocketSubData`) — same id + different `wsUrl` is silent under the
// reconcile pass, identical to `fromEventSource`'s `url` contract.
//
//   - `onMessage(data, sub)` — required. The platform delivers `data` as
//     `string | Blob | ArrayBuffer` depending on `binaryType` and the
//     server's frame type. The factory does NOT bake in a parse contract:
//     the callback receives the raw `unknown` and decides parse + Msg
//     shape. Returns `M | null`; null drops the dispatch.
//
//   - `onOpen(sub)` — optional. Connection handshake succeeded. Useful
//     for "show 'connected' indicator" Msgs. Omitting drops open events
//     silently.
//
//   - `onError(event, sub)` — optional. WebSocket's `error` event fires
//     on transient drops AND permanent failures; like SSE, most consumers
//     want one Msg ("connection-errored") without folding both into
//     `onMessage`'s discriminant. Omitting drops error events silently.
//
//   - `onClose(code, reason, sub)` — optional. The connection is gone.
//     `code` is the WebSocket close code (1000 = clean, 1006 = abnormal,
//     etc.). `reason` is the server-supplied string (often empty).
//     Omitting drops close events silently.
//
// Cleanup is `close(1000)` — the IANA-registered clean-shutdown code.
// The factory intentionally does NOT bake in registry semantics (e.g.
// the extension's `ctx.wsRegistry` so `interpret.send_ws` can reach the
// live socket): that's consumer glue. A consumer that needs the live
// socket for outbound sends wires it from inside the subscribe handler
// or keeps a hand-written Sub alongside this factory.
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type {
  MinimalCloseEvent,
  MinimalEvent,
  MinimalMessageEvent,
  MinimalWebSocketCtor,
} from "./platform";
import { dispatchIfPresent, type SubscribeHandler } from "./types";

export type WebSocketSubData = { wsUrl: string };

declare const WebSocket: MinimalWebSocketCtor;

export interface WebSocketFactoryOpts<S, M> {
  onMessage: (data: unknown, sub: S) => M | null;
  onOpen?: (sub: S) => M | null;
  onError?: (event: MinimalEvent, sub: S) => M | null;
  onClose?: (code: number, reason: string, sub: S) => M | null;
}

export function fromWebSocket<S extends Sub & WebSocketSubData, M>(
  opts: WebSocketFactoryOpts<S, M>,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const ws = new WebSocket(sub.wsUrl);

    ws.onmessage = (event: MinimalMessageEvent): void => {
      // The platform delivers `data` as `unknown` — the factory hands it
      // through untouched and the caller chooses the parse strategy.
      dispatchIfPresent(dispatch, opts.onMessage(event.data, sub));
    };

    const onOpen = opts.onOpen;
    if (onOpen) {
      ws.onopen = (): void => {
        dispatchIfPresent(dispatch, onOpen(sub));
      };
    }

    const onError = opts.onError;
    if (onError) {
      ws.onerror = (event: MinimalEvent): void => {
        dispatchIfPresent(dispatch, onError(event, sub));
      };
    }

    const onClose = opts.onClose;
    if (onClose) {
      ws.onclose = (event: MinimalCloseEvent): void => {
        dispatchIfPresent(dispatch, onClose(event.code, event.reason, sub));
      };
    }

    return () => {
      // Detach the lifecycle handlers BEFORE close() so the consumer's
      // `onClose` Msg isn't fired from a teardown the substrate initiated.
      // Mirrors fromEventSource's removeEventListener pass.
      ws.onmessage = null;
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      // 1000 = "normal closure" per RFC 6455 §7.4.1.
      ws.close(1000);
    };
  };
}
