import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type NoCtx,
  type Reducer,
  run,
  type Sub,
  subId,
} from "../index";
import { fromWebSocket, type WebSocketSubData } from "./from-web-socket";
import type {
  MinimalCloseEvent,
  MinimalEvent,
  MinimalMessageEvent,
  MinimalWebSocket,
} from "./platform";

// Lifecycle contract under a real runtime (issue #286): the socket opens
// (wsUrl read off the Sub) when the Sub enters `subscriptions(state)`, the
// four lifecycle events route through their callbacks into State, and
// reconciling the Sub out detaches the handlers BEFORE close(1000) — so the
// substrate-initiated teardown never fires the consumer's onClose Msg.
//
// The global `WebSocket` is stubbed with the same hand-driven FakeSocket
// shape from-reconnecting-web-socket.test.ts uses.

class FakeSocket implements MinimalWebSocket {
  static instances: FakeSocket[] = [];
  closedWith: number | null = null;
  onopen: ((event: MinimalEvent) => void) | null = null;
  onmessage: ((event: MinimalMessageEvent) => void) | null = null;
  onerror: ((event: MinimalEvent) => void) | null = null;
  onclose: ((event: MinimalCloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }
  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ type: "message", data });
  }
  fireError(): void {
    this.onerror?.({ type: "error" });
  }
  fireClose(code = 1006, reason = "gone"): void {
    this.onclose?.({ type: "close", code, reason });
  }
}

type WsSub = Sub<"ws"> & WebSocketSubData;
type State = {
  readonly armed: boolean;
  readonly frames: readonly unknown[];
  readonly opens: number;
  readonly errors: number;
  readonly closes: readonly { code: number; reason: string }[];
};
type Msg =
  | { readonly type: "frame"; readonly data: unknown }
  | { readonly type: "ws_open" }
  | { readonly type: "ws_error" }
  | {
      readonly type: "ws_close";
      readonly code: number;
      readonly reason: string;
    }
  | { readonly type: "disarm" };

const update: Reducer<State, Msg, never> = {
  frame: (s, m) => [{ ...s, frames: [...s.frames, m.data] }, []],
  ws_open: (s) => [{ ...s, opens: s.opens + 1 }, []],
  ws_error: (s) => [{ ...s, errors: s.errors + 1 }, []],
  ws_close: (s, m) => [
    { ...s, closes: [...s.closes, { code: m.code, reason: m.reason }] },
    [],
  ],
  disarm: (s) => [{ ...s, armed: false }, []],
};

function wsMachine() {
  return defineMachine<State, Msg, never, WsSub, NoCtx>({
    init: () => [
      { armed: true, frames: [], opens: 0, errors: 0, closes: [] },
      [],
    ],
    update,
    subscriptions: (s) =>
      s.armed ? [{ id: subId("ws"), type: "ws", wsUrl: "ws://x/ws" }] : [],
    subscribe: {
      ws: fromWebSocket<WsSub, Msg>({
        onMessage: (data) =>
          data === "drop-me" ? null : { type: "frame", data },
        onOpen: () => ({ type: "ws_open" }),
        onError: () => ({ type: "ws_error" }),
        onClose: (code, reason) => ({ type: "ws_close", code, reason }),
      }),
    },
  });
}

describe("fromWebSocket — subscribe → deliver → cleanup against a real runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.instances = [];
  });

  it("opens the socket at boot (wsUrl off the Sub) and routes all four lifecycle events", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const rt = await run(wsMachine(), {}).ready;

    expect(FakeSocket.instances).toHaveLength(1);
    const ws = FakeSocket.instances[0];
    expect(ws.url).toBe("ws://x/ws");

    ws.fireOpen();
    ws.fireMessage('{"kind":"snapshot"}');
    ws.fireError();
    ws.fireClose(1011, "server going away");
    await rt.idle();
    expect(rt.getState()).toMatchObject({
      opens: 1,
      frames: ['{"kind":"snapshot"}'],
      errors: 1,
      closes: [{ code: 1011, reason: "server going away" }],
    });

    await rt.stop();
  });

  it("onMessage → null drops the frame but keeps the socket attached", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const rt = await run(wsMachine(), {}).ready;
    const ws = FakeSocket.instances[0];

    ws.fireMessage("drop-me");
    await rt.idle();
    expect(rt.getState().frames).toEqual([]);

    ws.fireMessage("keep-me");
    await rt.idle();
    expect(rt.getState().frames).toEqual(["keep-me"]);

    await rt.stop();
  });

  it("reconciling the Sub out detaches handlers BEFORE close(1000) — no onClose Msg from teardown", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const rt = await run(wsMachine(), {}).ready;
    const ws = FakeSocket.instances[0];
    ws.fireOpen();
    await rt.idle();

    await rt.dispatch({ type: "disarm" });
    expect(ws.closedWith).toBe(1000); // RFC 6455 normal closure
    expect(ws.onmessage).toBeNull();
    expect(ws.onopen).toBeNull();
    expect(ws.onerror).toBeNull();
    expect(ws.onclose).toBeNull();

    // The teardown close dispatched no consumer Msg.
    await rt.idle();
    expect(rt.getState().closes).toEqual([]);

    await rt.stop();
  });
});
