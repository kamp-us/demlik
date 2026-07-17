import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type NoCtx,
  type Reducer,
  run,
  type Sub,
  subId,
} from "../index";
import { fromBroadcastChannel } from "./from-broadcast-channel";
import type { MinimalBroadcastChannel, MinimalMessageEvent } from "./platform";

// Lifecycle contract under a real runtime (issue #286): the channel opens
// (with the name carried on the Sub) when the Sub enters
// `subscriptions(state)`, delivered messages fold into State (null-dropped
// per msgFn), and reconciling the Sub out removes the listener AND closes
// the channel — the paired cleanup the factory's docblock pins.
//
// The global `BroadcastChannel` is stubbed with a hand-driven fake (the same
// approach as from-reconnecting-web-socket.test.ts's FakeSocket) so delivery
// is synchronous and `close()` is observable.

class FakeChannel implements MinimalBroadcastChannel {
  static instances: FakeChannel[] = [];
  closed = false;
  private readonly listeners = new Set<(e: MinimalMessageEvent) => void>();

  constructor(readonly name: string) {
    FakeChannel.instances.push(this);
  }
  addEventListener(
    _type: "message",
    listener: (e: MinimalMessageEvent) => void,
  ): void {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: "message",
    listener: (e: MinimalMessageEvent) => void,
  ): void {
    this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: unknown): void {
    for (const l of this.listeners) l({ type: "message", data });
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}

type BusSub = Sub<"bus"> & { channelName: string };
type State = { readonly armed: boolean; readonly seen: readonly string[] };
type Msg =
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "disarm" };

const update: Reducer<State, Msg, never> = {
  note: (s, m) => [{ ...s, seen: [...s.seen, m.text] }, []],
  disarm: (s) => [{ ...s, armed: false }, []],
};

function busMachine(channelName: string) {
  return defineMachine<State, Msg, never, BusSub, NoCtx>({
    init: () => [{ armed: true, seen: [] }, []],
    update,
    subscriptions: (s) =>
      s.armed ? [{ id: subId("bus"), type: "bus", channelName }] : [],
    subscribe: {
      bus: fromBroadcastChannel<BusSub, Msg>((event) =>
        typeof event.data === "string"
          ? { type: "note", text: event.data }
          : null,
      ),
    },
  });
}

describe("fromBroadcastChannel — subscribe → deliver → cleanup against a real runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeChannel.instances = [];
  });

  it("opens a channel named by the Sub at boot and delivers posted messages as Msgs", async () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const rt = await run(busMachine("room-7"), {}).ready;

    expect(FakeChannel.instances).toHaveLength(1);
    const channel = FakeChannel.instances[0];
    expect(channel.name).toBe("room-7"); // channelName read off the Sub

    channel.deliver("hello");
    channel.deliver("again");
    await rt.idle();
    expect(rt.getState().seen).toEqual(["hello", "again"]);

    await rt.stop();
  });

  it("msgFn → null drops unrecognized payloads without detaching", async () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const rt = await run(busMachine("room-7"), {}).ready;
    const channel = FakeChannel.instances[0];

    channel.deliver({ not: "a string" });
    await rt.idle();
    expect(rt.getState().seen).toEqual([]);

    channel.deliver("still-listening");
    await rt.idle();
    expect(rt.getState().seen).toEqual(["still-listening"]);

    await rt.stop();
  });

  it("reconciling the Sub out removes the listener AND closes the channel", async () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const rt = await run(busMachine("room-7"), {}).ready;
    const channel = FakeChannel.instances[0];
    expect(channel.listenerCount()).toBe(1);
    expect(channel.closed).toBe(false);

    await rt.dispatch({ type: "disarm" });
    expect(channel.listenerCount()).toBe(0);
    expect(channel.closed).toBe(true);

    channel.deliver("too-late");
    await rt.idle();
    expect(rt.getState().seen).toEqual([]);

    await rt.stop();
  });
});
