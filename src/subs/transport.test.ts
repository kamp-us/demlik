import { describe, expect, it, vi } from "vitest";
import { defineMachine, type Reducer, subIdOf } from "../index";
import { run } from "../promise";
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
  | { readonly type: "close_seam" }
  | { readonly type: "rekey"; readonly runId: string };

const update: Reducer<State, Msg, never> = {
  heard: (s, m) => [{ ...s, heard: [...s.heard, m.text] }, []],
  lost: (s) => [{ ...s, runId: null, heard: [...s.heard, "<lost>"] }, []],
  close_seam: (s) => [{ ...s, runId: null }, []],
  rekey: (s, m) => [{ ...s, runId: m.runId }, []],
};

const lost = (): Msg => ({ type: "lost" });

function seamBattery() {
  return fromTransport<"hands", string, Inbound, Outbound, Msg, Ctx>({
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
    lostMsg: lost,
    serializeOutbound: (out) => JSON.stringify(out),
  });
}

type Seam = ReturnType<typeof seamBattery>;

function machineFor(seam: Seam, runId = "run-1") {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      sub: {} as TransportSub<"hands", string>,
      ctx: {} as Ctx,
    },
    init: () => [{ runId, heard: [] }, []],
    update,
    subs: [seam.depKeyed((s: State) => s.runId)],
  });
}

function runSeam(seam: Seam, transport: Transport, runId = "run-1") {
  return run(machineFor(seam, runId), {
    subscribe: { hands: seam.subscribe },
    ctx: { transport },
  }).ready;
}

/** The running Sub the engine would hand the seam's runner for `runId`. */
function handsSub(runId: string): TransportSub<"hands", string> {
  return { id: subIdOf("hands", runId), type: "hands", deps: runId };
}

describe("fromTransport — inbound, close, and the outbound handle table", () => {
  it("opens the transport when the seam's key turns non-null", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await runSeam(seam, transport);

    expect(transport.listenerCount).toBe(2); // message + close
    await rt.stop();
  });

  it("folds parsed inbound frames into State", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await runSeam(seam, transport);

    transport.deliver(JSON.stringify({ kind: "said", text: "hello" }));
    transport.deliver(JSON.stringify({ kind: "said", text: "again" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual(["hello", "again"]);

    await rt.stop();
  });

  it("parseInbound → null drops the frame; the seam stays open", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await runSeam(seam, transport);

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
    const rt = await runSeam(seam, transport);

    transport.deliver(JSON.stringify({ kind: "said", text: "" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual([]);

    await rt.stop();
  });

  it("a transport close dispatches exactly one lostMsg", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await runSeam(seam, transport);
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

  it("a null key detaches both listeners and closes the channel", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await runSeam(seam, transport);

    await rt.dispatch({ type: "close_seam" });
    expect(transport.closed).toBe(true);
    expect(transport.listenerCount).toBe(0);

    // Post-teardown frames are unreachable — the listener was really removed.
    transport.deliver(JSON.stringify({ kind: "said", text: "ghost" }));
    await rt.idle();
    expect(rt.getState().heard).toEqual([]);

    await rt.stop();
  });

  it("send() routes to the live transport by the seam's key", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const rt = await runSeam(seam, transport);

    seam.send("run-1", { say: "go" });
    expect(transport.sent).toEqual([JSON.stringify({ say: "go" })]);

    await rt.stop();
  });

  it("send() after the seam closed drops honestly instead of throwing", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = await runSeam(seam, transport);

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
    const rt = await runSeam(seam, transport);

    seam.send("run-does-not-exist", { say: "nope" });
    expect(transport.sent).toEqual([]);

    warn.mockRestore();
    await rt.stop();
  });

  it("the handle table keeps a string key and a numeric key distinct", () => {
    const seam = fromTransport<
      "hands",
      string | number,
      Inbound,
      Outbound,
      Msg,
      Ctx
    >({
      name: "hands",
      openTransport: (_k, ctx) => ctx.transport,
      parseInbound: () => null,
      onInbound: () => null,
      lostMsg: lost,
      serializeOutbound: (out) => JSON.stringify(out),
    });
    const transport = stubTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispose = seam.subscribe(
      { id: subIdOf("hands", "1"), type: "hands", deps: "1" },
      { transport },
      () => {},
    );

    seam.send(1, { say: "wrong key" });
    expect(transport.sent).toEqual([]);
    seam.send("1", { say: "right key" });
    expect(transport.sent).toEqual([JSON.stringify({ say: "right key" })]);

    warn.mockRestore();
    void dispose();
  });

  it("a changed key closes the old seam and opens a fresh one", async () => {
    const first = stubTransport();
    const second = stubTransport();
    const opened = [first, second];
    const keyed = fromTransport<"hands", string, Inbound, Outbound, Msg, Ctx>({
      name: "hands",
      openTransport: () => {
        const next = opened.shift();
        if (next === undefined) throw new Error("no transport left");
        return next;
      },
      parseInbound: () => null,
      onInbound: () => null,
      lostMsg: lost,
      serializeOutbound: (out) => JSON.stringify(out),
    });
    const rt = await runSeam(keyed, stubTransport());

    await rt.dispatch({ type: "rekey", runId: "run-2" });
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    keyed.send("run-1", { say: "old" });
    keyed.send("run-2", { say: "new" });
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([JSON.stringify({ say: "new" })]);
    warn.mockRestore();

    await rt.stop();
  });

  it("two seams in one machine are two Sub types that never collide", async () => {
    const hands = seamBattery();
    const worker = fromTransport<"worker", string, Inbound, Outbound, Msg, Ctx>(
      {
        name: "worker",
        openTransport: (_k, ctx) => ctx.transport,
        parseInbound: () => null,
        onInbound: () => null,
        lostMsg: lost,
        serializeOutbound: (out) => JSON.stringify(out),
      },
    );
    const transport = stubTransport();
    const machine = defineMachine({
      types: {
        model: {} as State,
        msg: {} as Msg,
        sub: {} as
          | TransportSub<"hands", string>
          | TransportSub<"worker", string>,
        ctx: {} as Ctx,
      },
      init: () => [{ runId: "run-1", heard: [] }, []],
      update,
      // Same key on both seams: the Sub type is part of the id, so they run
      // side by side instead of deduping onto one.
      subs: [
        hands.depKeyed((s: State) => s.runId),
        worker.depKeyed((s: State) => s.runId),
      ],
    });
    const rt = await run(machine, {
      subscribe: { hands: hands.subscribe, worker: worker.subscribe },
      ctx: { transport },
    }).ready;

    expect(transport.listenerCount).toBe(4); // two seams × (message + close)
    await rt.stop();
  });

  it("a close that throws is swallowed at the boundary (Rule 2 fire-and-forget)", async () => {
    const seam = seamBattery();
    const transport = stubTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    transport.close = () => {
      throw new Error("socket already gone");
    };
    const rt = await runSeam(seam, transport);

    await expect(rt.dispatch({ type: "close_seam" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
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
      seam.subscribe(handsSub("run-1"), { transport }, () => {}),
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
      seam.subscribe(handsSub("run-1"), { transport }, () => {}),
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
        seam.subscribe(handsSub("run-1"), { transport }, () => {}),
      ).toThrow();
    }
    // Every failed attempt closed its own transport — an unbounded reconcile
    // retry loop can no longer strand one socket per pass.
    expect(opened.every((t) => t.closed)).toBe(true);
  });
});
