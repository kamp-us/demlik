import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type NoCtx,
  type Reducer,
  run,
  type Sub,
  subId,
} from "../index";
import { fromEventSource } from "./from-event-source";
import type {
  MinimalEvent,
  MinimalEventSource,
  MinimalMessageEvent,
} from "./platform";

// Lifecycle contract under a real runtime (issue #286): the SSE connection
// opens (url read off the Sub) when the Sub enters `subscriptions(state)`,
// message/error/open events route through their three callbacks into State,
// and reconciling the Sub out detaches every listener and closes the source.
//
// The global `EventSource` is stubbed with a hand-driven fake (the FakeSocket
// approach) so the test fires the platform events deterministically.

class FakeEventSource implements MinimalEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
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
  }
  fireMessage(data: string): void {
    const event: MinimalMessageEvent = { type: "message", data };
    for (const l of this.listeners.get("message") ?? []) l(event);
  }
  fireError(): void {
    for (const l of this.listeners.get("error") ?? []) l({ type: "error" });
  }
  fireOpen(): void {
    for (const l of this.listeners.get("open") ?? []) l({ type: "open" });
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

type StreamSub = Sub<"stream"> & { url: string };
type State = {
  readonly armed: boolean;
  readonly frames: readonly string[];
  readonly errors: number;
  readonly opens: number;
};
type Msg =
  | { readonly type: "frame"; readonly data: string }
  | { readonly type: "stream_error" }
  | { readonly type: "stream_open" }
  | { readonly type: "disarm" };

const update: Reducer<State, Msg, never> = {
  frame: (s, m) => [{ ...s, frames: [...s.frames, m.data] }, []],
  stream_error: (s) => [{ ...s, errors: s.errors + 1 }, []],
  stream_open: (s) => [{ ...s, opens: s.opens + 1 }, []],
  disarm: (s) => [{ ...s, armed: false }, []],
};

function streamMachine() {
  return defineMachine<State, Msg, never, StreamSub, NoCtx>({
    init: () => [{ armed: true, frames: [], errors: 0, opens: 0 }, []],
    update,
    subscriptions: (s) =>
      s.armed
        ? [{ id: subId("stream"), type: "stream", url: "https://x/sse" }]
        : [],
    subscribe: {
      stream: fromEventSource<StreamSub, Msg>({
        onMessage: (data) =>
          data === "drop-me" ? null : { type: "frame", data },
        onError: () => ({ type: "stream_error" }),
        onOpen: () => ({ type: "stream_open" }),
      }),
    },
  });
}

describe("fromEventSource — subscribe → deliver → cleanup against a real runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("opens the connection at boot (url off the Sub) and routes all three event kinds", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const rt = await run(streamMachine(), {}).ready;

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
    const rt = await run(streamMachine(), {}).ready;
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
    const machine = defineMachine<State, Msg, never, StreamSub, NoCtx>({
      init: () => [{ armed: true, frames: [], errors: 0, opens: 0 }, []],
      update,
      subscriptions: (s) =>
        s.armed
          ? [{ id: subId("stream"), type: "stream", url: "https://x/sse" }]
          : [],
      subscribe: {
        stream: fromEventSource<StreamSub, Msg>({
          onMessage: (data) => ({ type: "frame", data }),
        }),
      },
    });
    const rt = await run(machine, {}).ready;
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
    const rt = await run(streamMachine(), {}).ready;
    const source = FakeEventSource.instances[0];

    await rt.dispatch({ type: "disarm" });
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
