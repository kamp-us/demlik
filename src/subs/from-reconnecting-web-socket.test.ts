import { describe, expect, it } from "vitest";
import { type Sub, subId } from "../index";
import {
  fromReconnectingWebSocket,
  type ReconnectingWebSocketFactoryOpts,
} from "./from-reconnecting-web-socket";
import type { WebSocketSubData } from "./from-web-socket";
import type {
  MinimalCloseEvent,
  MinimalEvent,
  MinimalMessageEvent,
  MinimalWebSocket,
} from "./platform";

// A fake `WebSocket` the test drives by hand: the factory installs its `on*`
// handlers and the test fires them to simulate the platform's open/close/
// message/error events — no DOM, no real network. Records the close code.
// Mirrors vortex's reconnecting-socket.test.ts FakeSocket, narrowed to the
// `MinimalWebSocket` surface the factory drives.
class FakeSocket implements MinimalWebSocket {
  closedWith: number | null = null;
  onopen: ((event: MinimalEvent) => void) | null = null;
  onmessage: ((event: MinimalMessageEvent) => void) | null = null;
  onerror: ((event: MinimalEvent) => void) | null = null;
  onclose: ((event: MinimalCloseEvent) => void) | null = null;

  constructor(readonly url: string) {}

  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }

  // ── test drivers ──
  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ type: "message", data });
  }
  fireError(): void {
    this.onerror?.({ type: "error" });
  }
  fireClose(code = 1006, reason = ""): void {
    this.onclose?.({ type: "close", code, reason });
  }
}

// A manual clock: captures scheduled reconnects so the test flushes them
// deterministically — the same shape vortex's fakeClock uses.
function fakeClock() {
  const pending: { fn: () => void; ms: number }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const entry = { fn, ms };
    pending.push(entry);
    return () => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
    };
  };
  /** Run (and remove) the next scheduled callback; returns its delay. */
  const flushNext = (): number => {
    const entry = pending.shift();
    if (entry === undefined) throw new Error("no pending timer");
    entry.fn();
    return entry.ms;
  };
  return { pending, schedule, flushNext };
}

type WsSub = Sub<"ws"> & WebSocketSubData;
type Msg =
  | { type: "open" }
  | { type: "message"; data: unknown }
  | { type: "error" }
  | { type: "close"; code: number }
  | { type: "reconnect"; attempt: number };

const SUB: WsSub = { id: subId("ws"), type: "ws", wsUrl: "ws://x/ws" };

// Wire the factory to a fresh socket-factory + clock, subscribe it, and expose
// the created sockets, dispatched Msgs, and the cleanup fn.
function harness(
  overrides: Partial<ReconnectingWebSocketFactoryOpts<WsSub, Msg>> = {},
  sub: WsSub = SUB,
) {
  const sockets: FakeSocket[] = [];
  const dispatched: Msg[] = [];
  const clock = fakeClock();
  const handler = fromReconnectingWebSocket<WsSub, Msg>({
    onMessage: (data) => ({ type: "message", data }),
    onOpen: () => ({ type: "open" }),
    onError: () => ({ type: "error" }),
    onClose: (code) => ({ type: "close", code }),
    onReconnect: (attempt) => ({ type: "reconnect", attempt }),
    connect: (url) => {
      const ws = new FakeSocket(url);
      sockets.push(ws);
      return ws;
    },
    schedule: clock.schedule,
    backoffBaseMs: 100,
    backoffMaxMs: 800,
    ...overrides,
  });
  const cleanup = handler(sub, undefined, (m) => dispatched.push(m));
  return { sockets, dispatched, clock, cleanup };
}

describe("fromReconnectingWebSocket — transparent reconnection (#188)", () => {
  it("opens a connection on subscribe and dispatches onOpen on handshake", () => {
    const h = harness();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toBe("ws://x/ws");
    expect(h.dispatched).toEqual([]);
    h.sockets[0].fireOpen();
    expect(h.dispatched).toEqual([{ type: "open" }]);
  });

  it("delivers decoded frames to onMessage", () => {
    const h = harness();
    h.sockets[0].fireOpen();
    h.sockets[0].fireMessage('{"type":"snapshot"}');
    expect(h.dispatched).toContainEqual({
      type: "message",
      data: '{"type":"snapshot"}',
    });
  });

  it("reconnects transparently after an unexpected close (a new socket, no reload)", () => {
    const h = harness();
    h.sockets[0].fireOpen();

    // The connection drops unexpectedly.
    h.sockets[0].fireClose(1006);
    expect(h.dispatched).toContainEqual({ type: "close", code: 1006 });
    // A reconnect is scheduled; flushing it opens a brand-new socket.
    expect(h.clock.pending).toHaveLength(1);
    h.clock.flushNext();
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1].url).toBe("ws://x/ws");
  });

  it("fires the onReconnect hook (with the 1-based attempt) when a re-open succeeds, not on the first open", () => {
    const h = harness();
    // First open is NOT a reconnect.
    h.sockets[0].fireOpen();
    expect(h.dispatched).toEqual([{ type: "open" }]);

    // Drop, reconnect, and the re-open fires onReconnect with attempt 1.
    h.sockets[0].fireClose();
    h.clock.flushNext();
    h.sockets[1].fireOpen();
    expect(h.dispatched).toContainEqual({ type: "open" });
    expect(h.dispatched).toContainEqual({ type: "reconnect", attempt: 1 });

    // A second drop after a successful reconnect reports attempt 1 again
    // (the backoff/attempt counter reset on the successful open).
    h.sockets[1].fireClose();
    h.clock.flushNext();
    h.sockets[2].fireOpen();
    const reconnects = h.dispatched.filter((m) => m.type === "reconnect");
    expect(reconnects).toEqual([
      { type: "reconnect", attempt: 1 },
      { type: "reconnect", attempt: 1 },
    ]);
  });

  it("uses exponential backoff that resets after a successful open", () => {
    const h = harness(); // base 100, max 800
    h.sockets[0].fireOpen();

    h.sockets[0].fireClose();
    expect(h.clock.flushNext()).toBe(100); // attempt 0 → 100
    h.sockets[1].fireClose();
    expect(h.clock.flushNext()).toBe(200); // attempt 1 → 200
    h.sockets[2].fireClose();
    expect(h.clock.flushNext()).toBe(400); // attempt 2 → 400

    // A successful handshake resets the backoff; the next drop retries fast.
    h.sockets[3].fireOpen();
    h.sockets[3].fireClose();
    expect(h.clock.flushNext()).toBe(100);
  });

  it("caps the backoff at backoffMaxMs", () => {
    const h = harness(); // base 100, max 800
    h.sockets[0].fireOpen();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      h.sockets[i].fireClose();
      delays.push(h.clock.flushNext());
    }
    // 100, 200, 400, 800, then capped at 800.
    expect(delays).toEqual([100, 200, 400, 800, 800, 800]);
  });

  it("uses the documented defaults (250ms base, 5000ms cap) when no backoff opts are given", () => {
    const h = harness({ backoffBaseMs: undefined, backoffMaxMs: undefined });
    h.sockets[0].fireOpen();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      h.sockets[i].fireClose();
      delays.push(h.clock.flushNext());
    }
    // 250, 500, 1000, 2000, 4000, then capped at 5000.
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000]);
  });

  it("reads sub.wsUrl afresh on every reconnect (a re-subscribe to a new url reconnects there)", () => {
    const sub: WsSub = {
      id: subId("ws"),
      type: "ws",
      wsUrl: "ws://x/ws?player=abc",
    };
    const h = harness({}, sub);
    h.sockets[0].fireOpen();
    h.sockets[0].fireClose();
    h.clock.flushNext();
    expect(h.sockets[1].url).toBe("ws://x/ws?player=abc");
  });

  it("routes error events through onError but lets close drive the reconnect (one path)", () => {
    const h = harness();
    h.sockets[0].fireOpen();
    h.sockets[0].fireError();
    expect(h.dispatched).toContainEqual({ type: "error" });
    // An error alone schedules nothing — only the following close does.
    expect(h.clock.pending).toHaveLength(0);
    h.sockets[0].fireClose();
    expect(h.clock.pending).toHaveLength(1);
  });

  it("cleanup() is a deliberate teardown — no reconnect, and the socket is closed with 1000", () => {
    const h = harness();
    h.sockets[0].fireOpen();
    h.cleanup();
    expect(h.sockets[0].closedWith).toBe(1000);
    // No reconnect scheduled, and a stray close does not resurrect it.
    expect(h.clock.pending).toHaveLength(0);
    h.sockets[0].fireClose();
    expect(h.sockets).toHaveLength(1);
  });

  it("cleanup() detaches handlers so the teardown close fires no onClose Msg", () => {
    const h = harness();
    h.sockets[0].fireOpen();
    const before = h.dispatched.length;
    h.cleanup();
    // Handlers detached before close(): the teardown emits no further Msg.
    expect(h.dispatched).toHaveLength(before);
  });

  it("a reconnect already scheduled is cancelled by cleanup()", () => {
    const h = harness();
    h.sockets[0].fireOpen();
    h.sockets[0].fireClose(); // schedules a reconnect
    expect(h.clock.pending).toHaveLength(1);
    h.cleanup();
    expect(h.clock.pending).toHaveLength(0);
  });

  it("optional callbacks are honored — a factory with only onMessage neither throws nor dispatches lifecycle Msgs", () => {
    const sockets: FakeSocket[] = [];
    const dispatched: Msg[] = [];
    const clock = fakeClock();
    const handler = fromReconnectingWebSocket<WsSub, Msg>({
      onMessage: (data) => ({ type: "message", data }),
      connect: (url) => {
        const ws = new FakeSocket(url);
        sockets.push(ws);
        return ws;
      },
      schedule: clock.schedule,
      backoffBaseMs: 100,
      backoffMaxMs: 800,
    });
    const cleanup = handler(SUB, undefined, (m) => dispatched.push(m));
    sockets[0].fireOpen();
    sockets[0].fireError();
    sockets[0].fireClose();
    // No onOpen/onError/onClose/onReconnect supplied: only the reconnect is
    // scheduled, no lifecycle Msg dispatched.
    expect(dispatched).toEqual([]);
    expect(clock.pending).toHaveLength(1);
    clock.flushNext();
    sockets[1].fireOpen();
    sockets[1].fireMessage("hi");
    expect(dispatched).toEqual([{ type: "message", data: "hi" }]);
    cleanup();
  });
});
