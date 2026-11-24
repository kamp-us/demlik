import { afterEach, describe, expect, it, vi } from "vitest";
import { defineMachine, type NoCtx, type Reducer, type Sub } from "../index";
import { run } from "../promise";
import { fromEventSource } from "./from-event-source";
import type {
  MinimalEvent,
  MinimalEventSource,
  MinimalMessageEvent,
  MinimalServerSentMessageEvent,
} from "./platform";

// Lifecycle contract under a real runtime (issue #286): the SSE connection
// opens (url read off the Sub's deps) when its `deps` turns non-null,
// message/error/open events route through their three callbacks into State,
// and reconciling the Sub out detaches every listener and closes the source.
//
// The global `EventSource` is stubbed with a hand-driven fake (the FakeSocket
// approach) so the test fires the platform events deterministically.

class FakeEventSource implements MinimalEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  readyState = 0;
  private readonly listeners = new Map<
    string,
    Set<(e: MinimalEvent) => void>
  >();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: MinimalEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (e: MinimalEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  fireMessage(data: string): void {
    const event: MinimalMessageEvent = { type: "message", data };
    for (const l of this.listeners.get("message") ?? []) l(event);
  }
  fireNamed(type: string, data: string, lastEventId: string): void {
    const event: MinimalServerSentMessageEvent = { type, data, lastEventId };
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  fireError(readyState = 0): void {
    this.readyState = readyState;
    for (const l of this.listeners.get("error") ?? []) l({ type: "error" });
  }
  totalListeners(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  fireOpen(): void {
    for (const l of this.listeners.get("open") ?? []) l({ type: "open" });
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

type StreamSub = Sub<"stream", { readonly url: string }>;
type State = {
  readonly armed: boolean;
  readonly frames: readonly string[];
  readonly errors: number;
  readonly opens: number;
};
type Msg =
  | { readonly _tag: "frame"; readonly data: string }
  | { readonly _tag: "stream_error" }
  | { readonly _tag: "stream_open" }
  | { readonly _tag: "disarm" };

const update: Reducer<State, Msg, never> = {
  frame: (s, m) => [{ ...s, frames: [...s.frames, m.data] }, []],
  stream_error: (s) => [{ ...s, errors: s.errors + 1 }, []],
  stream_open: (s) => [{ ...s, opens: s.opens + 1 }, []],
  disarm: (s) => [{ ...s, armed: false }, []],
};

function streamMachine() {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      sub: {} as StreamSub,
      ctx: {} as NoCtx,
    },
    init: () => [{ armed: true, frames: [], errors: 0, opens: 0 }, []],
    update,
    subs: [
      {
        _tag: "stream",
        deps: (s) => (s.armed ? { url: "https://x/sse" } : null),
      },
    ],
  });
}

const subscribe = {
  stream: fromEventSource<StreamSub, Msg>({
    onMessage: (data) => (data === "drop-me" ? null : { _tag: "frame", data }),
    onError: () => ({ _tag: "stream_error" }),
    onOpen: () => ({ _tag: "stream_open" }),
  }),
};

describe("fromEventSource — subscribe → deliver → cleanup against a real runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("opens the connection at boot (url off the Sub) and routes all three event kinds", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(streamMachine(), { subscribe }).ready;

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("https://x/sse");

    source.fireOpen();
    source.fireMessage("a");
    source.fireMessage("b");
    source.fireError();
    await rt.idle();
    expect(rt.getState()).toMatchObject({
      opens: 1,
      frames: ["a", "b"],
      errors: 1,
    });

    await rt.stop();
  });

  it("onMessage → null drops the frame but keeps the stream attached", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(streamMachine(), { subscribe }).ready;
    const source = FakeEventSource.instances[0];

    source.fireMessage("drop-me");
    await rt.idle();
    expect(rt.getState().frames).toEqual([]);

    source.fireMessage("keep-me");
    await rt.idle();
    expect(rt.getState().frames).toEqual(["keep-me"]);

    await rt.stop();
  });

  it("omitted optional callbacks attach no error/open listeners at all", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(streamMachine(), {
      subscribe: {
        stream: fromEventSource<StreamSub, Msg>({
          onMessage: (data) => ({ _tag: "frame", data }),
        }),
      },
    }).ready;
    const source = FakeEventSource.instances[0];

    expect(source.listenerCount("message")).toBe(1);
    expect(source.listenerCount("error")).toBe(0);
    expect(source.listenerCount("open")).toBe(0);

    source.fireError();
    source.fireOpen();
    await rt.idle();
    expect(rt.getState()).toMatchObject({ errors: 0, opens: 0 });

    await rt.stop();
  });

  it("reconciling the Sub out detaches every listener and closes the source", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(streamMachine(), { subscribe }).ready;
    const source = FakeEventSource.instances[0];

    await rt.dispatch({ _tag: "disarm" });
    expect(source.listenerCount("message")).toBe(0);
    expect(source.listenerCount("error")).toBe(0);
    expect(source.listenerCount("open")).toBe(0);
    expect(source.closed).toBe(true);

    source.fireMessage("too-late");
    await rt.idle();
    expect(rt.getState().frames).toEqual([]);

    await rt.stop();
  });
});

type FeedSub = Sub<"feed", { readonly url: string }>;
type FeedEvent = {
  readonly type: string;
  readonly data: string;
  readonly lastEventId: string;
};
type FeedState = {
  readonly url: string | null;
  readonly events: readonly FeedEvent[];
  readonly frames: readonly string[];
  readonly lost: number;
  readonly retrying: number;
};
type FeedMsg =
  | { readonly _tag: "named"; readonly event: FeedEvent }
  | { readonly _tag: "frame"; readonly data: string }
  | { readonly _tag: "feed_lost" }
  | { readonly _tag: "feed_retrying" }
  | { readonly _tag: "point"; readonly url: string | null };

const feedUpdate: Reducer<FeedState, FeedMsg, never> = {
  named: (s, m) => [{ ...s, events: [...s.events, m.event] }, []],
  frame: (s, m) => [{ ...s, frames: [...s.frames, m.data] }, []],
  feed_lost: (s) => [{ ...s, lost: s.lost + 1 }, []],
  feed_retrying: (s) => [{ ...s, retrying: s.retrying + 1 }, []],
  point: (s, m) => [{ ...s, url: m.url }, []],
};

function feedMachine() {
  return defineMachine({
    types: {
      model: {} as FeedState,
      msg: {} as FeedMsg,
      sub: {} as FeedSub,
      ctx: {} as NoCtx,
    },
    init: () => [
      { url: "https://x/feed", events: [], frames: [], lost: 0, retrying: 0 },
      [],
    ],
    update: feedUpdate,
    subs: [{ _tag: "feed", deps: (s) => (s.url ? { url: s.url } : null) }],
  });
}

const NAMED = ["entry", "reset", "progress"] as const;

const feedSubscribe = {
  feed: fromEventSource<FeedSub, FeedMsg, (typeof NAMED)[number]>({
    events: {
      types: NAMED,
      onEvent: (event) =>
        event.data === "drop-me" ? null : { _tag: "named", event },
    },
    onError: (_event, _sub, readyState) =>
      readyState === "closed"
        ? { _tag: "feed_lost" }
        : readyState === "connecting"
          ? { _tag: "feed_retrying" }
          : null,
  }),
};

describe("fromEventSource — named server-sent events", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("dispatches every named type with its type, data and lastEventId, across a long interleaved stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(feedMachine(), { subscribe: feedSubscribe }).ready;
    const source = FakeEventSource.instances[0];

    const expected: FeedEvent[] = [];
    for (let i = 0; i < 60; i++) {
      const type = NAMED[i % NAMED.length];
      const event = { type, data: `{"n":${i}}`, lastEventId: String(i) };
      source.fireNamed(type, event.data, event.lastEventId);
      expected.push(event);
    }
    await rt.idle();
    expect(rt.getState().events).toEqual(expected);

    await rt.stop();
  });

  it("dispatches nothing for a type the host did not name, nor for an unnamed message", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(feedMachine(), { subscribe: feedSubscribe }).ready;
    const source = FakeEventSource.instances[0];

    source.fireNamed("heartbeat", "x", "1");
    source.fireNamed("Entry", "x", "2");
    source.fireMessage("unnamed");
    source.fireNamed("entry", "drop-me", "3");
    await rt.idle();
    expect(rt.getState().events).toEqual([]);
    expect(rt.getState().frames).toEqual([]);
    expect(source.listenerCount("heartbeat")).toBe(0);
    expect(source.listenerCount("message")).toBe(0);

    source.fireNamed("entry", "kept", "4");
    await rt.idle();
    expect(rt.getState().events).toEqual([
      { type: "entry", data: "kept", lastEventId: "4" },
    ]);

    await rt.stop();
  });

  it("delivers unnamed messages through onMessage alongside named events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(feedMachine(), {
      subscribe: {
        feed: fromEventSource<FeedSub, FeedMsg>({
          onMessage: (data) => ({ _tag: "frame", data }),
          events: {
            types: ["entry"],
            onEvent: (event) => ({ _tag: "named", event }),
          },
        }),
      },
    }).ready;
    const source = FakeEventSource.instances[0];

    source.fireMessage("plain");
    source.fireNamed("entry", "named", "7");
    await rt.idle();
    expect(rt.getState().frames).toEqual(["plain"]);
    expect(rt.getState().events).toEqual([
      { type: "entry", data: "named", lastEventId: "7" },
    ]);

    await rt.stop();
  });

  it("tells an error on a CLOSED source from one on a CONNECTING source", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(feedMachine(), { subscribe: feedSubscribe }).ready;
    const source = FakeEventSource.instances[0];

    source.fireError(0);
    source.fireError(0);
    source.fireNamed("entry", "after-retry", "9");
    source.fireError(2);
    await rt.idle();
    expect(rt.getState()).toMatchObject({ retrying: 2, lost: 1 });
    expect(rt.getState().events).toHaveLength(1);

    await rt.stop();
  });

  it("unsubscribe removes every listener it added and closes the source", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(feedMachine(), {
      subscribe: {
        feed: fromEventSource<FeedSub, FeedMsg>({
          onMessage: (data) => ({ _tag: "frame", data }),
          events: {
            types: ["entry", "reset", "entry"],
            onEvent: (event) => ({ _tag: "named", event }),
          },
          onError: () => ({ _tag: "feed_lost" }),
          onOpen: () => null,
        }),
      },
    }).ready;
    const source = FakeEventSource.instances[0];
    expect(source.totalListeners()).toBe(5);
    expect(source.listenerCount("entry")).toBe(1);

    await rt.dispatch({ _tag: "point", url: null });
    expect(source.totalListeners()).toBe(0);
    expect(source.closed).toBe(true);

    source.fireNamed("entry", "too-late", "1");
    source.fireMessage("too-late");
    await rt.idle();
    expect(rt.getState().events).toEqual([]);
    expect(rt.getState().frames).toEqual([]);

    await rt.stop();
  });

  it("a changed url closes the old source and opens a new one that keeps the named listeners", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(feedMachine(), { subscribe: feedSubscribe }).ready;
    const first = FakeEventSource.instances[0];

    await rt.dispatch({ _tag: "point", url: "https://y/feed" });
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1];
    expect(first.closed).toBe(true);
    expect(first.totalListeners()).toBe(0);
    expect(second.url).toBe("https://y/feed");
    expect(second.closed).toBe(false);

    first.fireNamed("entry", "old", "1");
    second.fireNamed("reset", "new", "2");
    await rt.idle();
    expect(rt.getState().events).toEqual([
      { type: "reset", data: "new", lastEventId: "2" },
    ]);

    await rt.stop();
  });
});
