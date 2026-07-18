// ---------------------------------------------------------------------------
// fromReconnectingWebSocket — a `WebSocket` Sub factory that survives drops.
//
// `fromWebSocket` is the SSE-sibling ONE-SHOT factory: its cleanup `close()`s
// the socket and it never re-opens on an unexpected drop (issue #188). That is
// the right shape for a connection the caller manages, but any tea client over
// an unreliable transport — games, presence, collab — needs the connection to
// recover transparently, without a page reload. Rather than re-roll a backoff
// loop in every consumer (vortex's `ReconnectingSocket` is the proven shape,
// services/vortex/src/reconnecting-socket.ts), this is the reconnecting variant
// folded into the substrate's Sub surface.
//
// The reconnect contract, mirroring vortex's wrapper:
//
//   - On an UNEXPECTED close (`onclose` the substrate didn't initiate) it
//     re-opens after a CAPPED exponential backoff: `min(base * 2^attempt, max)`.
//     A successful handshake resets `attempt` to 0, so the next drop retries
//     fast again.
//
//   - A CALLER-INITIATED close (the Sub's cleanup, e.g. the machine
//     transitioned the Sub away) suppresses reconnect: handlers are detached
//     BEFORE `close(1000)` so the teardown can't fire `onClose` or schedule a
//     reconnect. After cleanup the factory never re-opens.
//
//   - `connect` and `schedule` are INJECTABLE (defaulting to the global
//     `WebSocket` and `setTimeout`/`clearTimeout`), the test seam that lets the
//     reconnect/backoff behavior be unit-tested with a fake socket + a manual
//     clock — no DOM, no real network, no timers — exactly as vortex's wrapper
//     is tested.
//
// Callback contract (same `M | null` "null drops the dispatch" shape as
// `fromWebSocket`, plus one reconnect-specific hook):
//
//   - `onMessage(data, sub)` — required. Raw `unknown` frame; the caller parses.
//   - `onOpen(sub)` — optional. Fires on EVERY successful handshake — the first
//     open AND every reconnect — so a "connected" indicator stays accurate.
//   - `onError(event, sub)` — optional. The `error` event; `close` still drives
//     the reconnect (one path), so this is purely a notification.
//   - `onClose(code, reason, sub)` — optional. Fires on every close the
//     substrate observes (a drop that will be retried, too) — NOT on the
//     caller's own teardown, whose handlers are detached first.
//   - `onReconnect(attempt, sub)` — optional. Fires when a RE-open (any open
//     after the first) succeeds, carrying the 1-based reconnect count. This is
//     the resync hook: the place to dispatch a "re-fetch the authoritative
//     snapshot, discard predicted state" Msg after the transport recovered.
//
// Like `fromWebSocket`, `wsUrl` lives on the Sub (`WebSocketSubData`); every
// reconnect reads `sub.wsUrl` afresh, so a reconcile that re-subscribes with a
// new url reconnects to the new endpoint.
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type { WebSocketSubData } from "./from-web-socket";
import type {
  MinimalEvent,
  MinimalWebSocket,
  MinimalWebSocketCtor,
} from "./platform";
import { dispatchIfPresent, type SubscribeHandler } from "./types";

declare const WebSocket: MinimalWebSocketCtor;

/** Cancels a scheduled reconnect timer (the inverse of `schedule`). */
export type CancelTimer = () => void;

export interface ReconnectingWebSocketFactoryOpts<S, M> {
  onMessage: (data: unknown, sub: S) => M | null;
  onOpen?: (sub: S) => M | null;
  onError?: (event: MinimalEvent, sub: S) => M | null;
  onClose?: (code: number, reason: string, sub: S) => M | null;
  /**
   * Fires when a reconnection (any open after the first) succeeds, carrying the
   * 1-based reconnect count — the resync hook. Omitting drops reconnect events
   * silently.
   */
  onReconnect?: (attempt: number, sub: S) => M | null;
  /** First backoff delay in ms (doubles each failed attempt). Default 250. */
  backoffBaseMs?: number;
  /** Backoff ceiling in ms. Default 5000. */
  backoffMaxMs?: number;
  /** Inject the socket constructor (defaults to the global `WebSocket`); the test seam. */
  connect?: (url: string) => MinimalWebSocket;
  /** Inject the timer (defaults to `setTimeout`/`clearTimeout`); the test seam. */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
}

const defaultConnect = (url: string): MinimalWebSocket => new WebSocket(url);

const defaultSchedule = (fn: () => void, ms: number): CancelTimer => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

export function fromReconnectingWebSocket<S extends Sub & WebSocketSubData, M>(
  opts: ReconnectingWebSocketFactoryOpts<S, M>,
): SubscribeHandler<S, M, unknown> {
  const backoffBaseMs = opts.backoffBaseMs ?? 250;
  const backoffMaxMs = opts.backoffMaxMs ?? 5000;
  const connect = opts.connect ?? defaultConnect;
  const schedule = opts.schedule ?? defaultSchedule;

  const { onMessage, onOpen, onError, onClose, onReconnect } = opts;

  return (sub, _ctx, dispatch) => {
    let ws: MinimalWebSocket | null = null;
    let attempt = 0;
    let opened = false;
    let closedByCaller = false;
    let cancelReconnect: CancelTimer | null = null;

    const emit = (msg: M | null): void => dispatchIfPresent(dispatch, msg);

    const handleClose = (code: number, reason: string): void => {
      ws = null;
      if (onClose) emit(onClose(code, reason, sub));
      // A teardown the substrate initiated detaches handlers first, so this
      // path only runs for an UNEXPECTED close — reconnect with capped backoff.
      if (closedByCaller) return;
      const delay = Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs);
      attempt += 1;
      cancelReconnect = schedule(() => {
        cancelReconnect = null;
        if (!closedByCaller) open();
      }, delay);
    };

    function open(): void {
      const socket = connect(sub.wsUrl);
      ws = socket;

      socket.onopen = (): void => {
        // `opened` BEFORE this open marks it a reconnect; `attempt` is the
        // pending count for the drop that triggered it (1-based once we reset).
        const reconnected = opened;
        const reconnectCount = attempt;
        attempt = 0;
        opened = true;
        if (onOpen) emit(onOpen(sub));
        if (reconnected && onReconnect) emit(onReconnect(reconnectCount, sub));
      };

      socket.onmessage = (event): void => {
        emit(onMessage(event.data, sub));
      };

      // `error` precedes `close`; let `close` drive the reconnect so there is
      // one path. The handler is still wired (as a no-op when the caller didn't
      // supply `onError`) so a platform error event has a sink.
      socket.onerror = onError
        ? (event): void => emit(onError(event, sub))
        : (): void => {};

      socket.onclose = (event): void => {
        handleClose(event.code, event.reason);
      };
    }

    open();

    return () => {
      // Deliberate teardown: cancel any pending reconnect, detach handlers so
      // the cleanup `close()` can't fire `onClose` or schedule a reconnect,
      // then close the live socket. After this the factory never re-opens.
      closedByCaller = true;
      if (cancelReconnect !== null) {
        cancelReconnect();
        cancelReconnect = null;
      }
      const socket = ws;
      ws = null;
      if (socket !== null) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        // 1000 = "normal closure" per RFC 6455 §7.4.1.
        socket.close(1000);
      }
    };
  };
}
