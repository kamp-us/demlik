import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { defineMachine, type Reducer, run } from "../index";
import {
  fileStore,
  type NodeSub,
  type NodeSubscribeCtx,
  nodeSubscribe,
  sendToWebSocket,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// @demlik/tea/node — fileStore (atomic JSON persistence) + nodeSubscribe (the
// node_ws / node_timer / node_signal handler registry). Each surface is
// exercised through a real `run()`: machines whose subscriptions list the
// node Subs, with the substrate's reconciler driving install and teardown.
// ───────────────────────────────────────────────────────────────────────────

function parseCounter(raw: unknown): { n: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = (raw as Record<string, unknown>).n;
  return typeof n === "number" ? { n } : null;
}

describe("fileStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tea-node-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("load() resolves null when the file is absent (fresh boot)", async () => {
    const store = fileStore(join(dir, "absent.json"), parseCounter);
    await expect(store.load()).resolves.toBeNull();
  });

  it("save() writes JSON atomically — content lands, no .tmp residue", async () => {
    const path = join(dir, "state.json");
    const store = fileStore(path, parseCounter);
    await store.save({ n: 7 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ n: 7 });
    // The pid-scoped temp was renamed away — only the target file remains.
    await expect(readdir(dir)).resolves.toEqual(["state.json"]);
  });

  it("save() creates missing parent directories", async () => {
    const path = join(dir, "deep", "nested", "state.json");
    const store = fileStore(path, parseCounter);
    await store.save({ n: 1 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ n: 1 });
  });

  it("save → load round-trips the value", async () => {
    const store = fileStore(join(dir, "rt.json"), parseCounter);
    await store.save({ n: 3 });
    await expect(store.load()).resolves.toEqual({ n: 3 });
    await store.save({ n: 4 });
    await expect(store.load()).resolves.toEqual({ n: 4 });
  });

  it("load() throws on structurally malformed JSON (infra error, doStore parity)", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ not json", "utf8");
    const store = fileStore(path, parseCounter);
    await expect(store.load()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("migrate delegates to parse — shape mismatch is null, never a throw", () => {
    const store = fileStore(join(dir, "x.json"), parseCounter);
    expect(store.migrate({ n: 5 })).toEqual({ n: 5 });
    expect(store.migrate({ wrong: "shape" })).toBeNull();
  });

  it("persists across two real runs — the round-trip tracer", async () => {
    const path = join(dir, "counter.json");
    type S = { readonly n: number };
    type M = { readonly type: "inc" };
    const update: Reducer<S, M, never> = {
      inc: (s) => [{ n: s.n + 1 }, []],
    };
    const machine = defineMachine<S, M, never, never, undefined>({
      init: (loaded) => [loaded ?? { n: 0 }, []],
      update,
    });

    const first = await run(machine, {
      ctx: undefined,
      store: fileStore(path, parseCounter),
    }).ready;
    await first.dispatch({ type: "inc" });
    await first.dispatch({ type: "inc" });
    await first.stop();

    // Second life reads what the first persisted through the file.
    const second = await run(machine, {
      ctx: undefined,
      store: fileStore(path, parseCounter),
    }).ready;
    expect(second.getState()).toEqual({ n: 2 });
    await second.stop();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// nodeSubscribe — timers and signals through a real run.
// ───────────────────────────────────────────────────────────────────────────

type TickState = {
  readonly phase: "idle" | "armed";
  readonly ticks: number;
};
type TickMsg =
  | { readonly type: "arm" }
  | { readonly type: "disarm" }
  | { readonly type: "tick" };

function timerMachine(delayMs: number, repeat: boolean) {
  const update: Reducer<TickState, TickMsg, never> = {
    arm: (s) => [{ ...s, phase: "armed" }, []],
    disarm: (s) => [{ ...s, phase: "idle" }, []],
    tick: (s) => [{ ...s, ticks: s.ticks + 1 }, []],
  };
  return defineMachine<
    TickState,
    TickMsg,
    never,
    NodeSub<TickMsg>,
    NodeSubscribeCtx
  >({
    init: () => [{ phase: "idle", ticks: 0 }, []],
    update,
    subscriptions: (s) =>
      s.phase === "armed"
        ? [
            {
              id: "t1",
              type: "node_timer",
              delayMs,
              msg: { type: "tick" },
              repeat,
            },
          ]
        : [],
    subscribe: nodeSubscribe<TickMsg, NodeSubscribeCtx>(),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("nodeSubscribe: node_timer", () => {
  it("a one-shot timer dispatches its msg once after delayMs", async () => {
    const runtime = await run(timerMachine(5, false), {
      ctx: { wsRegistry: new Map() },
    }).ready;
    await runtime.dispatch({ type: "arm" });
    await sleep(30);
    await runtime.idle();
    expect(runtime.getState().ticks).toBe(1);
    await runtime.stop();
  });

  it("a repeating timer keeps firing while listed, and cleanup stops it", async () => {
    const runtime = await run(timerMachine(5, true), {
      ctx: { wsRegistry: new Map() },
    }).ready;
    await runtime.dispatch({ type: "arm" });
    await sleep(40);
    await runtime.dispatch({ type: "disarm" });
    await runtime.idle();
    const ticksAtDisarm = runtime.getState().ticks;
    expect(ticksAtDisarm).toBeGreaterThanOrEqual(2);

    // The reconciler ran the cleanup when `subscriptions` dropped the sub —
    // the interval is cleared, so the count is frozen.
    await sleep(40);
    expect(runtime.getState().ticks).toBe(ticksAtDisarm);
    await runtime.stop();
  });

  it("leaving the phase before a one-shot fires cancels it", async () => {
    const runtime = await run(timerMachine(30, false), {
      ctx: { wsRegistry: new Map() },
    }).ready;
    await runtime.dispatch({ type: "arm" });
    await runtime.dispatch({ type: "disarm" }); // cleanup clears the pending timeout
    await sleep(60);
    expect(runtime.getState().ticks).toBe(0);
    await runtime.stop();
  });
});

describe("nodeSubscribe: node_signal", () => {
  type SigState = { readonly phase: "idle" | "armed"; readonly caught: number };
  type SigMsg =
    | { readonly type: "arm" }
    | { readonly type: "disarm" }
    | { readonly type: "sig" };

  function signalMachine() {
    const update: Reducer<SigState, SigMsg, never> = {
      arm: (s) => [{ ...s, phase: "armed" }, []],
      disarm: (s) => [{ ...s, phase: "idle" }, []],
      sig: (s) => [{ ...s, caught: s.caught + 1 }, []],
    };
    return defineMachine<
      SigState,
      SigMsg,
      never,
      NodeSub<SigMsg>,
      NodeSubscribeCtx
    >({
      init: () => [{ phase: "idle", caught: 0 }, []],
      update,
      subscriptions: (s) =>
        s.phase === "armed"
          ? [
              {
                id: "sig1",
                type: "node_signal",
                signal: "SIGUSR2",
                msg: { type: "sig" },
              },
            ]
          : [],
      subscribe: nodeSubscribe<SigMsg, NodeSubscribeCtx>(),
    });
  }

  it("dispatches the msg when the signal fires, and detaches on cleanup", async () => {
    const runtime = await run(signalMachine(), {
      ctx: { wsRegistry: new Map() },
    }).ready;

    // Not armed yet — the signal reaches no listener of ours.
    process.emit("SIGUSR2");
    await runtime.idle();
    expect(runtime.getState().caught).toBe(0);

    await runtime.dispatch({ type: "arm" });
    process.emit("SIGUSR2");
    await runtime.idle();
    expect(runtime.getState().caught).toBe(1);

    // Disarm → cleanup ran `process.off` — a later signal is not observed.
    await runtime.dispatch({ type: "disarm" });
    process.emit("SIGUSR2");
    await runtime.idle();
    expect(runtime.getState().caught).toBe(1);
    await runtime.stop();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// nodeSubscribe: node_ws — socket lifecycle owned by the reconciler, plus the
// WS teardown state machine (graceful close when OPEN, terminate otherwise).
// ───────────────────────────────────────────────────────────────────────────

type WsState = {
  readonly phase: "idle" | "connected";
  readonly frames: readonly string[];
  readonly opened: boolean;
  readonly closedWith: number | null;
};
type WsMsg =
  | { readonly type: "connect" }
  | { readonly type: "hangup" }
  | { readonly type: "ws_open" }
  | { readonly type: "ws_frame"; readonly data: string }
  | { readonly type: "ws_closed"; readonly code: number };

function wsMachine(url: string) {
  const update: Reducer<WsState, WsMsg, never> = {
    connect: (s) => [{ ...s, phase: "connected" }, []],
    hangup: (s) => [{ ...s, phase: "idle" }, []],
    ws_open: (s) => [{ ...s, opened: true }, []],
    ws_frame: (s, m) => [{ ...s, frames: [...s.frames, m.data] }, []],
    ws_closed: (s, m) => [{ ...s, closedWith: m.code }, []],
  };
  return defineMachine<WsState, WsMsg, never, NodeSub<WsMsg>, NodeSubscribeCtx>(
    {
      init: () => [
        { phase: "idle", frames: [], opened: false, closedWith: null },
        [],
      ],
      update,
      subscriptions: (s) =>
        s.phase === "connected"
          ? [
              {
                id: "ws1",
                type: "node_ws",
                url,
                onOpen: () => ({ type: "ws_open" }),
                // Frames prefixed "drop:" exercise the null-drop seam.
                onMessage: (data) =>
                  data.startsWith("drop:") ? null : { type: "ws_frame", data },
                onClose: (code) => ({ type: "ws_closed", code }),
              },
            ]
          : [],
      subscribe: nodeSubscribe<WsMsg, NodeSubscribeCtx>(),
    },
  );
}

describe("nodeSubscribe: node_ws through a real run", () => {
  let server: WebSocketServer;
  let url: string;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null)
      throw new Error("expected AddressInfo");
    url = `ws://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("opens on subscribe, routes frames (dropping null-parsed ones), registers in ctx.wsRegistry, and closes 1000 on teardown", async () => {
    const ctx: NodeSubscribeCtx = { wsRegistry: new Map() };
    const serverSide = new Promise<{
      sendFrames: () => void;
      closed: Promise<number>;
    }>((resolve) => {
      server.on("connection", (socket) => {
        const closed = new Promise<number>((res) =>
          socket.on("close", (code) => res(code)),
        );
        resolve({
          sendFrames: () => {
            socket.send("hello");
            socket.send("drop:me"); // onMessage returns null — must not reach the reducer
            socket.send("world");
          },
          closed,
        });
      });
    });

    const runtime = await run(wsMachine(url), { ctx }).ready;
    await runtime.dispatch({ type: "connect" });

    const peer = await serverSide;
    // Wait for the client's open handshake to have dispatched ws_open.
    await expect
      .poll(() => runtime.getState().opened, { timeout: 2000 })
      .toBe(true);
    expect(ctx.wsRegistry.has("ws1")).toBe(true);

    peer.sendFrames();
    await expect
      .poll(() => runtime.getState().frames, { timeout: 2000 })
      .toEqual(["hello", "world"]);

    // Teardown: leaving the phase reconciles the sub out. Socket is OPEN, so
    // the cleanup closes gracefully with 1000 and empties the registry.
    await runtime.dispatch({ type: "hangup" });
    await expect(peer.closed).resolves.toBe(1000);
    expect(ctx.wsRegistry.has("ws1")).toBe(false);
    await runtime.stop();
  });

  it("sendToWebSocket writes to the registered socket; false when absent or not OPEN", async () => {
    const ctx: NodeSubscribeCtx = { wsRegistry: new Map() };
    const received = new Promise<string>((resolve) => {
      server.on("connection", (socket) => {
        socket.on("message", (data) => resolve(data.toString()));
      });
    });

    const runtime = await run(wsMachine(url), { ctx }).ready;

    // Nothing registered yet — a write is a boolean no-op, never a throw.
    expect(sendToWebSocket(ctx, "ws1", "too early")).toBe(false);

    await runtime.dispatch({ type: "connect" });
    await expect
      .poll(() => runtime.getState().opened, { timeout: 2000 })
      .toBe(true);

    expect(sendToWebSocket(ctx, "ws1", "ping-from-cmd")).toBe(true);
    await expect(received).resolves.toBe("ping-from-cmd");

    // Unknown id — false.
    expect(sendToWebSocket(ctx, "nope", "x")).toBe(false);

    await runtime.dispatch({ type: "hangup" });
    expect(sendToWebSocket(ctx, "ws1", "after teardown")).toBe(false);
    await runtime.stop();
  });

  it("tearing down a CONNECTING socket terminates it without crashing (the non-OPEN teardown arm)", async () => {
    // Point at a port with no listener: the socket sits in CONNECTING until
    // the refusal lands. Reconcile it out immediately — the cleanup must take
    // the terminate() path and absorb the teardown-induced 'error'.
    const ctx: NodeSubscribeCtx = { wsRegistry: new Map() };
    const runtime = await run(wsMachine("ws://127.0.0.1:1"), { ctx }).ready;

    await runtime.dispatch({ type: "connect" });
    expect(ctx.wsRegistry.has("ws1")).toBe(true);
    await runtime.dispatch({ type: "hangup" }); // cleanup while CONNECTING
    expect(ctx.wsRegistry.has("ws1")).toBe(false);

    // Give the refused connection time to error out — the swallowed listener
    // means no unhandled 'error' crashes the process and no msg is dispatched.
    await sleep(50);
    expect(runtime.getState().opened).toBe(false);
    expect(runtime.getState().closedWith).toBeNull();
    await runtime.stop();
  });
});
