import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SseFrameError, sseHub } from "./index";

type Tap = {
  readonly text: () => string;
  readonly done: () => boolean;
  readonly cancel: () => Promise<void>;
};

function tap(response: Response): Tap {
  const body = response.body;
  if (body === null) throw new Error("no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let done = false;
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  })();
  return {
    text: () => text,
    done: () => done,
    cancel: () => reader.cancel(),
  };
}

const realSetTimeout = globalThis.setTimeout;
const flush = (): Promise<void> =>
  new Promise((resolve) => realSetTimeout(resolve, 0));

type RunEvent =
  | { readonly kind: "turn"; readonly turn: number }
  | { readonly kind: "status"; readonly status: string };

function runHost(options: { keepaliveMs?: number } = {}) {
  const turns: RunEvent[] = [];
  let status: RunEvent | null = null;
  const hub = sseHub<RunEvent>({
    frame: (e) => ({ event: e.kind, data: JSON.stringify(e) }),
    snapshot: () => (status === null ? [...turns] : [...turns, status]),
    ...options,
  });
  const record = (e: RunEvent): void => {
    if (e.kind === "turn") turns.push(e);
    else status = e;
    hub.emit(e);
  };
  return { hub, record };
}

const named = (e: RunEvent): string =>
  `event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;

describe("sseHub with no options", () => {
  it("writes the same bytes and headers as before", async () => {
    const hub = sseHub<{ n: number; s?: string }>();
    const response = hub.open();
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const client = tap(response);
    hub.emit({ n: 1 });
    hub.emit({ n: 2, s: "a\nb" });
    await flush();
    expect(client.text()).toBe(
      'data: {"n":1}\n\ndata: {"n":2,"s":"a\\nb"}\n\n',
    );
    await client.cancel();
  });

  it("keeps register as a plain subscription with no snapshot", () => {
    const hub = sseHub<number>();
    const seen: number[] = [];
    hub.emit(0);
    const off = hub.register((n) => seen.push(n));
    hub.emit(1);
    off();
    hub.emit(2);
    expect(seen).toEqual([1]);
  });

  it("drops an event JSON cannot encode, as before, without throwing", async () => {
    const hub = sseHub<unknown>();
    const client = tap(hub.open());
    expect(() => hub.emit({ big: 1n })).not.toThrow();
    hub.emit(1);
    await flush();
    expect(client.text()).toBe("data: 1\n\n");
    await client.cancel();
  });
});

describe("sseHub named frames", () => {
  it("writes event, id and one data line per line, byte for byte", async () => {
    const hub = sseHub<{ type: string; body: string; id?: string }>({
      frame: (e) => ({
        event: e.type,
        data: e.body,
        ...(e.id === undefined ? {} : { id: e.id }),
      }),
    });
    const client = tap(hub.open());
    hub.emit({ type: "turn", body: '{"turn":1}', id: "7" });
    hub.emit({ type: "log", body: "one\ntwo\r\nthree\rfour" });
    await flush();
    expect(client.text()).toBe(
      'event: turn\nid: 7\ndata: {"turn":1}\n\n' +
        "event: log\ndata: one\ndata: two\ndata: three\ndata: four\n\n",
    );
    await client.cancel();
  });

  it("writes an unnamed frame when event is left out", async () => {
    const hub = sseHub<string>({ frame: (s) => ({ data: s }) });
    const client = tap(hub.open());
    hub.emit("");
    hub.emit("x");
    await flush();
    expect(client.text()).toBe("data: \n\ndata: x\n\n");
    await client.cancel();
  });

  it("throws SseFrameError out of emit for a field the format cannot carry", async () => {
    const hub = sseHub<{ event?: string; id?: string }>({
      frame: (e) => ({ data: "x", ...e }),
    });
    const client = tap(hub.open());
    expect(() => hub.emit({ event: "a\nb" })).toThrow(SseFrameError);
    expect(() => hub.emit({ event: "a\rb" })).toThrow(SseFrameError);
    expect(() => hub.emit({ id: "1\n" })).toThrow(SseFrameError);
    expect(() => hub.emit({ id: "1\0" })).toThrow(SseFrameError);
    hub.emit({ event: "ok" });
    await flush();
    expect(client.text()).toBe("event: ok\ndata: x\n\n");
    await client.cancel();
  });
});

describe("sseHub keepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a comment frame each period and none before the first", async () => {
    const hub = sseHub<number>({ keepaliveMs: 1_000 });
    const client = tap(hub.open());
    vi.advanceTimersByTime(999);
    await flush();
    expect(client.text()).toBe("");
    vi.advanceTimersByTime(1);
    hub.emit(1);
    await flush();
    vi.advanceTimersByTime(1_000);
    await flush();
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(client.text()).toBe(
      ": keepalive\n\ndata: 1\n\n: keepalive\n\n: keepalive\n\n",
    );
    await client.cancel();
  });

  it("queues no further comment while the client is not reading", async () => {
    const hub = sseHub<number>({ keepaliveMs: 10 });
    const response = hub.open();
    vi.advanceTimersByTime(10_000);
    const client = tap(response);
    await flush();
    expect(client.text()).toBe(": keepalive\n\n");
    vi.advanceTimersByTime(10);
    await flush();
    vi.advanceTimersByTime(10);
    await flush();
    expect(client.text()).toBe(": keepalive\n\n".repeat(3));
    await client.cancel();
  });

  it.each([
    ["closed", 0, (ctl: ReadableStreamDefaultController) => ctl.close()],
    [
      "errored",
      0,
      (ctl: ReadableStreamDefaultController) => ctl.error(new Error("x")),
    ],
    [
      "errored",
      1,
      (ctl: ReadableStreamDefaultController) => ctl.error(new Error("x")),
    ],
  ])("clears the interval when the stream was %s under it after %i unread comments", (_, ticks, breakIt) => {
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const Real = globalThis.ReadableStream;
    vi.stubGlobal(
      "ReadableStream",
      class extends Real<Uint8Array> {
        constructor(
          source: UnderlyingDefaultSource<Uint8Array>,
          strategy?: QueuingStrategy<Uint8Array>,
        ) {
          super(
            {
              ...source,
              start: (controller) => {
                ctl = controller;
                return source.start?.(controller);
              },
            },
            strategy,
          );
        }
      },
    );
    try {
      const hub = sseHub<number>({ keepaliveMs: 1_000 });
      hub.open();
      expect(vi.getTimerCount()).toBe(1);
      if (ctl === undefined) throw new Error("no controller");
      vi.advanceTimersByTime(1_000 * ticks);
      expect(vi.getTimerCount()).toBe(1);
      breakIt(ctl);
      vi.advanceTimersByTime(1_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(() => hub.emit(1)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 31,
  ])("refuses keepaliveMs %s with a RangeError", (keepaliveMs) => {
    expect(() => sseHub<number>({ keepaliveMs })).toThrow(RangeError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after the client cancels", async () => {
    const hub = sseHub<number>({ keepaliveMs: 1_000 });
    const client = tap(hub.open());
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    await flush();
    await client.cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(client.text()).toBe(": keepalive\n\n");
  });

  it("stops after close", async () => {
    const hub = sseHub<number>({ keepaliveMs: 1_000 });
    const a = tap(hub.open());
    const b = tap(hub.open());
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(1_000);
    hub.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(a.text()).toBe(": keepalive\n\n");
    expect(b.text()).toBe(": keepalive\n\n");
    expect(a.done() && b.done()).toBe(true);
  });

  it("starts no timer for a stream opened after close", async () => {
    const hub = sseHub<number>({ keepaliveMs: 1_000 });
    hub.close();
    const client = tap(hub.open());
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(client.done()).toBe(true);
  });

  it("starts no timer when keepalive is not asked for", async () => {
    const hub = sseHub<number>();
    const client = tap(hub.open());
    expect(vi.getTimerCount()).toBe(0);
    await client.cancel();
  });
});

describe("sseHub replay snapshot", () => {
  it("gives a late client the snapshot, then live events, none twice or missing", async () => {
    const { hub, record } = runHost();
    const early = tap(hub.open());
    const events: RunEvent[] = [
      { kind: "turn", turn: 1 },
      { kind: "status", status: "running" },
      { kind: "turn", turn: 2 },
      { kind: "status", status: "waiting" },
      { kind: "turn", turn: 3 },
    ];
    for (const e of events) record(e);
    const late = tap(hub.open());
    const after: RunEvent[] = [
      { kind: "turn", turn: 4 },
      { kind: "status", status: "running" },
      { kind: "turn", turn: 5 },
    ];
    for (const e of after) record(e);
    await flush();

    expect(early.text()).toBe([...events, ...after].map(named).join(""));
    expect(late.text()).toBe(
      [
        { kind: "turn", turn: 1 },
        { kind: "turn", turn: 2 },
        { kind: "turn", turn: 3 },
        { kind: "status", status: "waiting" },
        ...after,
      ]
        .map((e) => named(e as RunEvent))
        .join(""),
    );
    await early.cancel();
    await late.cancel();
  });

  it("keeps every event across many clients opened between emits", async () => {
    const hub = sseHub<number>({
      frame: (n) => ({ event: "n", data: String(n) }),
      snapshot: () => log,
    });
    const log: number[] = [];
    const clients: { from: number; tap: Tap }[] = [];
    for (let n = 0; n < 50; n++) {
      if (n % 7 === 0) clients.push({ from: n, tap: tap(hub.open()) });
      log.push(n);
      hub.emit(n);
    }
    await flush();
    for (const client of clients) {
      expect(client.tap.text()).toBe(
        log.map((n) => `event: n\ndata: ${n}\n\n`).join(""),
      );
      await client.tap.cancel();
    }
  });

  it("delivers an emit that lands while the snapshot is taken once, after it", async () => {
    const log: number[] = [1, 2];
    let emitDuringSnapshot = true;
    const hub = sseHub<number>({
      snapshot: () => {
        const copy = [...log];
        if (emitDuringSnapshot) {
          emitDuringSnapshot = false;
          log.push(3);
          hub.emit(3);
        }
        return copy;
      },
    });
    const client = tap(hub.open());
    log.push(4);
    hub.emit(4);
    await flush();
    expect(client.text()).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n");
    await client.cancel();
  });

  it("delivers an emit made before the client reads, after the snapshot", async () => {
    const { hub, record } = runHost();
    record({ kind: "turn", turn: 1 });
    const response = hub.open();
    record({ kind: "turn", turn: 2 });
    const client = tap(response);
    await flush();
    expect(client.text()).toBe(
      named({ kind: "turn", turn: 1 }) + named({ kind: "turn", turn: 2 }),
    );
    await client.cancel();
  });

  it("hands a registered sink the snapshot first", () => {
    const { hub, record } = runHost();
    record({ kind: "turn", turn: 1 });
    record({ kind: "status", status: "running" });
    const seen: RunEvent[] = [];
    hub.register((e) => seen.push(e));
    record({ kind: "turn", turn: 2 });
    expect(seen).toEqual([
      { kind: "turn", turn: 1 },
      { kind: "status", status: "running" },
      { kind: "turn", turn: 2 },
    ]);
  });
});

describe("sseHub frame throws and emits during open", () => {
  it("delivers an event whose frame throws to no stream and no sink", async () => {
    const hub = sseHub<number>({
      frame: (n) => {
        if (n === 2) throw new Error("bad");
        return { data: String(n) };
      },
    });
    const client = tap(hub.open());
    const seen: number[] = [];
    hub.register((n) => seen.push(n));
    hub.emit(1);
    expect(() => hub.emit(2)).toThrow("bad");
    hub.emit(3);
    await flush();
    expect(seen).toEqual([1, 3]);
    expect(client.text()).toBe("data: 1\n\ndata: 3\n\n");
    await client.cancel();
  });

  it("keeps an emit made from frame while open encodes the snapshot", async () => {
    let emitFromFrame = true;
    const hub = sseHub<number>({
      snapshot: () => [1, 2],
      frame: (n) => {
        if (n === 2 && emitFromFrame) {
          emitFromFrame = false;
          hub.emit(99);
        }
        return { data: String(n) };
      },
    });
    const client = tap(hub.open());
    hub.emit(100);
    await flush();
    expect(client.text()).toBe(
      "data: 1\n\ndata: 2\n\ndata: 99\n\ndata: 100\n\n",
    );
    await client.cancel();
  });

  it("keeps an emit made from a sink while register replays the snapshot", () => {
    const hub = sseHub<number>({ snapshot: () => [1, 2] });
    const seen: number[] = [];
    let emitFromSink = true;
    hub.register((n) => {
      seen.push(n);
      if (emitFromSink) {
        emitFromSink = false;
        hub.emit(99);
        hub.emit(98);
      }
    });
    hub.emit(100);
    expect(seen).toEqual([1, 2, 99, 98, 100]);
  });

  it("keeps a chain of emits made while the pending events drain", async () => {
    const hub = sseHub<number>({
      snapshot: () => [1],
      frame: (n) => {
        if (n >= 10 && n < 13) hub.emit(n + 1);
        return { data: String(n) };
      },
    });
    let first = true;
    const seen: number[] = [];
    hub.register((n) => {
      seen.push(n);
      if (first) {
        first = false;
        hub.emit(10);
      }
    });
    expect(seen).toEqual([1, 13, 12, 11, 10]);
    const client = tap(hub.open());
    hub.emit(20);
    await flush();
    expect(client.text()).toBe("data: 1\n\ndata: 20\n\n");
    await client.cancel();
  });
});

function mainHub<E>() {
  const sinks = new Set<(event: E) => void>();
  const encoder = new TextEncoder();
  return {
    emit(event: E) {
      for (const sink of sinks) {
        try {
          sink(event);
        } catch {}
      }
    },
    open() {
      let sink!: (event: E) => void;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          sink = (event) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          };
          sinks.add(sink);
        },
        cancel: () => {
          sinks.delete(sink);
        },
      });
      return new Response(stream);
    },
    register(sink: (event: E) => void) {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
  };
}

describe("sseHub delivery order", () => {
  type Hub = {
    emit(event: number): void;
    open(): Response;
    register(sink: (event: number) => void): () => void;
  };

  async function reentrant(
    hub: Hub,
    order: "register-then-open" | "open-then-register",
  ): Promise<{ stream: string; sink: number[] }> {
    const sink: number[] = [];
    const subscribe = () =>
      hub.register((n) => {
        sink.push(n);
        if (n === 1) hub.emit(2);
      });
    let response: Response;
    if (order === "register-then-open") {
      subscribe();
      response = hub.open();
    } else {
      response = hub.open();
      subscribe();
    }
    const client = tap(response);
    hub.emit(1);
    hub.emit(3);
    await flush();
    await client.cancel();
    return { stream: client.text(), sink };
  }

  it.each([
    "register-then-open",
    "open-then-register",
  ] as const)("delivers a re-entrant emit in the same order as main when %s", async (order) => {
    const ours = await reentrant(sseHub<number>(), order);
    const main = await reentrant(mainHub<number>(), order);
    expect(ours).toEqual(main);
    expect(ours.sink).toEqual([1, 2, 3]);
    expect(ours.stream).toBe(
      order === "register-then-open"
        ? "data: 2\n\ndata: 1\n\ndata: 3\n\n"
        : "data: 1\n\ndata: 2\n\ndata: 3\n\n",
    );
  });

  it("keeps main's order across many sinks and streams interleaved", async () => {
    const run = async (hub: Hub) => {
      const log: string[] = [];
      const clients: Tap[] = [];
      for (let i = 0; i < 4; i++) {
        hub.register((n) => {
          log.push(`sink${i}:${n}`);
          if (n === i * 10) hub.emit(n + 1);
        });
        clients.push(tap(hub.open()));
      }
      for (const n of [0, 10, 20, 30]) hub.emit(n);
      await flush();
      for (const client of clients) await client.cancel();
      return { log, streams: clients.map((c) => c.text()) };
    };
    expect(await run(sseHub<number>())).toEqual(await run(mainHub<number>()));
  });

  it("lets a terminal event reach every stream when a sink closes the hub on it", async () => {
    type Ev = { readonly kind: "turn" | "end"; readonly n: number };
    const hub = sseHub<Ev>({
      frame: (e) => ({ event: e.kind, data: String(e.n) }),
    });
    const before = tap(hub.open());
    const seen: Ev[] = [];
    hub.register((e) => {
      seen.push(e);
      if (e.kind === "end") hub.close();
    });
    const after = tap(hub.open());
    const lateSink: Ev[] = [];
    hub.register((e) => lateSink.push(e));
    hub.emit({ kind: "turn", n: 1 });
    hub.emit({ kind: "end", n: 2 });
    hub.emit({ kind: "turn", n: 3 });
    await flush();
    const expected = "event: turn\ndata: 1\n\nevent: end\ndata: 2\n\n";
    expect(before.text()).toBe(expected);
    expect(after.text()).toBe(expected);
    expect(before.done() && after.done()).toBe(true);
    expect(seen.map((e) => e.n)).toEqual([1, 2]);
    expect(lateSink.map((e) => e.n)).toEqual([1, 2]);
    expect(hub.closed).toBe(true);
  });
});

describe("sseHub close", () => {
  it("ends every open stream and stops delivering", async () => {
    const { hub, record } = runHost();
    const a = tap(hub.open());
    const b = tap(hub.open());
    const seen: RunEvent[] = [];
    hub.register((e) => seen.push(e));
    record({ kind: "turn", turn: 1 });
    expect(hub.closed).toBe(false);
    hub.close();
    hub.close();
    expect(hub.closed).toBe(true);
    record({ kind: "turn", turn: 2 });
    await flush();
    expect(a.done()).toBe(true);
    expect(b.done()).toBe(true);
    expect(a.text()).toBe(named({ kind: "turn", turn: 1 }));
    expect(b.text()).toBe(named({ kind: "turn", turn: 1 }));
    expect(seen).toEqual([{ kind: "turn", turn: 1 }]);
  });

  it("gives a stream opened after close the snapshot, then ends it", async () => {
    const { hub, record } = runHost();
    record({ kind: "turn", turn: 1 });
    record({ kind: "status", status: "done" });
    hub.close();
    const late = tap(hub.open());
    await flush();
    expect(late.done()).toBe(true);
    expect(late.text()).toBe(
      named({ kind: "turn", turn: 1 }) +
        named({ kind: "status", status: "done" }),
    );
    const seen: RunEvent[] = [];
    hub.register((e) => seen.push(e));
    record({ kind: "turn", turn: 9 });
    expect(seen).toEqual([
      { kind: "turn", turn: 1 },
      { kind: "status", status: "done" },
    ]);
  });

  it("ends a stream whose client already cancelled without throwing", async () => {
    const hub = sseHub<number>();
    const client = tap(hub.open());
    await client.cancel();
    expect(() => hub.close()).not.toThrow();
  });
});
