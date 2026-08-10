import { describe, expect, it, vi } from "vitest";
import { defineMachine, type Reducer, run } from "../index";
import { fromTransport, type Transport, type TransportSub } from "./transport";

// The seam battery owns three things at once: the inbound stream, the
// close → `*_lost` Msg, and the outbound handle table. Each is exercised
// against a stub transport under a real runtime, because the whole claim of
// the battery is that the substrate's reconcile pass drives all three.

/** In-process stub in the shape of the `Transport` port. */
function stubTransport() {
  const messageListeners = new Set<(data: string) => void>();
  const closeListeners = new Set<() => void>();
  const sent: string[] = [];
  let closed = false;

  const transport: Transport & {
    readonly sent: string[];
    deliver(data: string): void;
    dropPeer(): void;
    readonly closed: boolean;
    readonly listenerCount: number;
  } = {
    sent,
    get closed() {
      return closed;
    },
    get listenerCount() {
      return messageListeners.size + closeListeners.size;
    },
    deliver(data) {
      for (const l of [...messageListeners]) l(data);
    },
    dropPeer() {
      for (const l of [...closeListeners]) l();
    },
    send(data) {
      sent.push(data);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      closed = true;
    },
  };
  return transport;
}

type Inbound = { readonly kind: "said"; readonly text: string };
type Outbound = { readonly say: string };
type Ctx = { readonly transport: Transport };
type State = {
  readonly runId: string | null;
  readonly heard: readonly string[];
};
type Msg =
  | { readonly type: "heard"; readonly text: string }
  | { readonly type: "lost" }
  | { readonly type: "close_seam" };

const update: Reducer<State, Msg, never> = {
  heard: (s, m) => [{ ...s, heard: [...s.heard, m.text] }, []],
  lost: (s) => [{ ...s, runId: null, heard: [...s.heard, "<lost>"] }, []],
  close_seam: (s) => [{ ...s, runId: null }, []],
};

function seamBattery() {
  return fromTransport<string, Inbound, Outbound, Msg, Ctx>({
    name: "hands",
    openTransport: (_runId, ctx) => ctx.transport,
    // `keepalive` is a transport-level frame the seam does not surface.
    parseInbound: (raw) => {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "kind" in parsed &&
        parsed.kind === "said" &&
        "text" in parsed &&
        typeof parsed.text === "string"
      ) {
        return { kind: "said", text: parsed.text };
      }
      return null;
    },
    // Empty text parses fine but is not worth a domain Msg — the second
    // (post-parse) drop-on-null seam.
    onInbound: (inbound) =>
      inbound.text === "" ? null : { type: "heard", text: inbound.text },
    lostMsg: () => ({ type: "lost" }),
    serializeOutbound: (out) => JSON.stringify(out),
  });
}

function machineFor(seam: ReturnType<typeof seamBattery>, runId = "run-1") {
  return defineMachine<State, Msg, never, TransportSub<string>, Ctx>({
    init: () => [{ runId, heard: [] }, []],
    update,
    subscriptions: (s) => (s.runId === null ? [] : [seam.sub(s.runId)]),
    subscribe: { transport: seam.subscribe },
  });
}

describe("fromTransport — inbound, close, and the outbound handle table", () => {
  it("opens the transport when the seam Sub enters the desired set", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    expect(transport.listenerCount).toBe(2); // message + close
    await rt.stop();
  });

  it("folds parsed inbound frames into State", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    transport.deliver(JSON.stringify({ kind: "said", text: "hello" }));
    transport.deliver(JSON.stringify({ kind: "said", text: "again" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual(["hello", "again"]);

    await rt.stop();
  });

  it("parseInbound → null drops the frame; the seam stays open", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    transport.deliver(JSON.stringify({ kind: "keepalive" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual([]);

    transport.deliver(JSON.stringify({ kind: "said", text: "still here" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual(["still here"]);

    await rt.stop();
  });

  it("onInbound → null drops the dispatch after a successful parse", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    transport.deliver(JSON.stringify({ kind: "said", text: "" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual([]);

    await rt.stop();
  });

  it("a transport close dispatches exactly one lostMsg", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;
    const observed = vi.fn();
    rt.observe(observed);

    transport.dropPeer();
    await rt.idle();

    expect(rt.getState().heard).toEqual(["<lost>"]);
    expect(rt.getState().runId).toBeNull();
    expect(
      observed.mock.calls.filter(([msg]) => msg.type === "lost"),
    ).toHaveLength(1);

    await rt.stop();
  });

  it("reconciling the seam out detaches both listeners and closes the channel", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    await rt.dispatch({ type: "close_seam" });
    expect(transport.closed).toBe(true);
    expect(transport.listenerCount).toBe(0);

    // Post-teardown frames are unreachable — the listener was really removed.
    transport.deliver(JSON.stringify({ kind: "said", text: "ghost" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual([]);

    await rt.stop();
  });

  it("send() routes to the live transport while the seam is open", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    seam.send("run-1", { say: "go" });
    expect(transport.sent).toEqual([JSON.stringify({ say: "go" })]);

    await rt.stop();
  });

  it("send() after the seam closed drops honestly instead of throwing", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    await rt.dispatch({ type: "close_seam" });
    expect(() => seam.send("run-1", { say: "too late" })).not.toThrow();
    expect(transport.sent).toEqual([]);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    await rt.stop();
  });

  it("send() to an unknown key drops rather than mis-routing to another seam", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    seam.send("run-does-not-exist", { say: "nope" });
    expect(transport.sent).toEqual([]);

    warn.mockRestore();
    await rt.stop();
  });

  it("subIdFor keeps a string key and a numeric key distinct", () => {
    const seam = fromTransport<string | number, Inbound, Outbound, Msg, Ctx>({
      name: "hands",
      openTransport: (_k, ctx) => ctx.transport,
      parseInbound: () => null,
      onInbound: () => null,
      lostMsg: () => ({ type: "lost" }),
      serializeOutbound: (out) => JSON.stringify(out),
    });
    expect(seam.subIdFor("1")).not.toBe(seam.subIdFor(1));
  });

  it("two batteries with different names never collide on Sub id", () => {
    const a = seamBattery();
    const b = fromTransport<string, Inbound, Outbound, Msg, Ctx>({
      name: "worker",
      openTransport: (_k, ctx) => ctx.transport,
      parseInbound: () => null,
      onInbound: () => null,
      lostMsg: () => ({ type: "lost" }),
      serializeOutbound: (out) => JSON.stringify(out),
    });
    expect(a.subIdFor("run-1")).not.toBe(b.subIdFor("run-1"));
  });

  it("a close that throws is swallowed at the boundary (Rule 2 fire-and-forget)", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    transport.close = () => {
      throw new Error("socket already gone");
    };
    const rt = await run(machineFor(seam), { ctx: { transport } }).ready;

    await expect(rt.dispatch({ type: "close_seam" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    await rt.stop();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `.depKeyed` — the same seam expressed as ONE `subs` entry instead of a
// `subscriptions` line plus a `subscribe.transport` line. The gate travels
// with the seam, and the kernel derives its id from the key, so there is no
// central list to forget to edit and no hand-written SubId to typo.
// ───────────────────────────────────────────────────────────────────────────
describe("fromTransport.depKeyed — the seam as a dep-keyed Sub", () => {
  function depKeyedMachineFor(
    seam: ReturnType<typeof seamBattery>,
    runId = "run-1",
  ) {
    return defineMachine<State, Msg, never, never, Ctx>({
      init: () => [{ runId, heard: [] }, []],
      update,
      subs: [seam.depKeyed((s: State) => s.runId)],
    });
  }

  it("opens the transport with no `subscriptions` and no `subscribe` cell", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(depKeyedMachineFor(seam), { ctx: { transport } })
      .ready;

    expect(transport.listenerCount).toBe(2); // message + close
    await rt.stop();
  });

  it("folds inbound frames through the same subscribe the manual path uses", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(depKeyedMachineFor(seam), { ctx: { transport } })
      .ready;

    transport.deliver(JSON.stringify({ kind: "said", text: "hello" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual(["hello"]);

    await rt.stop();
  });

  it("tears the seam down when the gate returns null", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(depKeyedMachineFor(seam), { ctx: { transport } })
      .ready;

    await rt.dispatch({ type: "close_seam" });
    expect(transport.closed).toBe(true);
    expect(transport.listenerCount).toBe(0);

    await rt.stop();
  });

  it("keeps the outbound handle table reachable while the seam is open", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await run(depKeyedMachineFor(seam), { ctx: { transport } })
      .ready;

    seam.send("run-1", { say: "hi" });
    expect(transport.sent).toEqual([JSON.stringify({ say: "hi" })]);

    await rt.stop();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F3: acquire-as-success-value. The handle table used to be written BEFORE the
// inbound/close listeners were wired, so an adapter that throws while wiring
// (a socket already CLOSING is the everyday case) left the transport IN the
// table with no sub registered — nothing to clean it up, `send` writing into a
// half-wired seam, and every subsequent reconcile opening another one. Wiring
// comes first and the table is written last, exactly as `defineManagedResource`
// already does it: no fully-wired transport, no table entry.
// ───────────────────────────────────────────────────────────────────────────
describe("fromTransport — a transport that fails to wire leaks nothing", () => {
  /** A transport whose `onClose` wiring throws, as an already-CLOSING socket does. */
  function unwireableTransport() {
    const base = stubTransport();
    let closed = false;
    return {
      ...base,
      get closed() {
        return closed;
      },
      onMessage: base.onMessage,
      onClose(): () => void {
        throw new Error("socket is CLOSING");
      },
      close() {
        closed = true;
      },
      get listenerCount() {
        return base.listenerCount;
      },
    };
  }

  it("closes the transport and rethrows rather than registering a half-wired seam", () => {
    const seam = seamBattery();
    const transport = unwireableTransport();

    expect(() =>
      seam.subscribe(seam.sub("run-1"), { transport }, () => {}),
    ).toThrow(/socket is CLOSING/);
    expect(transport.closed).toBe(true);
    // The inbound listener it DID wire is gone too — no dangling callback into
    // a runtime that never learned about this seam.
    expect(transport.listenerCount).toBe(0);
  });

  it("leaves the handle table empty, so a later `send` drops honestly", () => {
    const seam = seamBattery();
    const transport = unwireableTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      seam.subscribe(seam.sub("run-1"), { transport }, () => {}),
    ).toThrow();
    seam.send("run-1", { say: "hi" });

    expect(transport.sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not accumulate a transport per retry, so the leak cannot grow", () => {
    const seam = seamBattery();
    const opened: Array<ReturnType<typeof unwireableTransport>> = [];

    for (let i = 0; i < 3; i++) {
      const transport = unwireableTransport();
      opened.push(transport);
      expect(() =>
        seam.subscribe(seam.sub("run-1"), { transport }, () => {}),
      ).toThrow();
    }
    // Every failed attempt closed its own transport — an unbounded reconcile
    // retry loop can no longer strand one socket per pass.
    expect(opened.every((t) => t.closed)).toBe(true);
  });
});
