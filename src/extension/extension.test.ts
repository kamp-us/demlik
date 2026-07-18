import { afterEach, describe, expect, it } from "vitest";
import { defineMachine, type Reducer, type Runtime, run } from "../index";
import {
  bridgeClient,
  bridgeRuntime,
  chromeStorageStore,
  passThroughMsg,
} from "./index";
import { fakeChrome } from "./test-utils";

// ───────────────────────────────────────────────────────────────────────────
// @demlik/tea/extension — chromeStorageStore (persistence over
// chrome.storage) and the runtime bridge (host ↔ surface over
// chrome.runtime messaging). Backed by the in-memory fakeChrome; the
// round-trip tracer runs two real `run()` lives over one storage area.
// ───────────────────────────────────────────────────────────────────────────

type CounterState = { readonly n: number };
type CounterMsg = { readonly type: "inc" };

function parseCounter(raw: unknown): CounterState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = (raw as Record<string, unknown>).n;
  return typeof n === "number" ? { n } : null;
}

function counterMachine() {
  const update: Reducer<CounterState, CounterMsg, never> = {
    inc: (s) => [{ n: s.n + 1 }, []],
  };
  return defineMachine<CounterState, CounterMsg, never, never, undefined>({
    init: (loaded) => [loaded ?? { n: 0 }, []],
    update,
  });
}

describe("chromeStorageStore", () => {
  it("load() resolves null when the key is absent (fresh boot)", async () => {
    const area = fakeChrome().storage.local;
    const store = chromeStorageStore<CounterState>("k", parseCounter, area);
    await expect(store.load()).resolves.toBeNull();
  });

  it("save() JSON-stringifies into the area; load() parses it back — the round-trip", async () => {
    const area = fakeChrome().storage.local;
    const store = chromeStorageStore<CounterState>("k", parseCounter, area);

    await store.save({ n: 5 });
    // The wire really is a JSON string at the key — a serialization boundary,
    // not a reference handoff.
    const raw = await area.get("k");
    expect((raw as Record<string, unknown>).k).toBe('{"n":5}');

    await expect(store.load()).resolves.toEqual({ n: 5 });
  });

  it("load() throws when the stored value is not a string (structural corruption)", async () => {
    const area = fakeChrome().storage.local;
    await area.set({ k: 12345 }); // hand-corrupt: non-string at the key
    const store = chromeStorageStore<CounterState>("k", parseCounter, area);
    await expect(store.load()).rejects.toThrow(/not a string/);
  });

  it("load() throws on unparseable JSON (doStore boot-throw parity)", async () => {
    const area = fakeChrome().storage.local;
    await area.set({ k: "{ not json" });
    const store = chromeStorageStore<CounterState>("k", parseCounter, area);
    await expect(store.load()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("migrate delegates to parse — shape mismatch is null, never a throw", () => {
    const area = fakeChrome().storage.local;
    const store = chromeStorageStore<CounterState>("k", parseCounter, area);
    expect(store.migrate({ n: 2 })).toEqual({ n: 2 });
    expect(store.migrate({ wrong: true })).toBeNull();
  });

  it("persists across two real runs over one area — the round-trip tracer", async () => {
    const area = fakeChrome().storage.local;

    const first = await run(counterMachine(), {
      ctx: undefined,
      store: chromeStorageStore<CounterState>("counter", parseCounter, area),
    }).ready;
    await first.dispatch({ type: "inc" });
    await first.dispatch({ type: "inc" });
    expect(first.getState()).toEqual({ n: 2 });
    await first.stop();

    // Second life: a FRESH store instance over the SAME area — the state
    // survived only if it truly crossed the JSON serialization boundary.
    const second = await run(counterMachine(), {
      ctx: undefined,
      store: chromeStorageStore<CounterState>("counter", parseCounter, area),
    }).ready;
    expect(second.getState()).toEqual({ n: 2 });
    await second.stop();
  });

  it("a persisted shape the parse rejects boots fresh (migrate → null)", async () => {
    const area = fakeChrome().storage.local;
    await area.set({ counter: JSON.stringify({ legacy: "shape" }) });
    const runtime = await run(counterMachine(), {
      ctx: undefined,
      store: chromeStorageStore<CounterState>("counter", parseCounter, area),
    }).ready;
    expect(runtime.getState()).toEqual({ n: 0 });
    await runtime.stop();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The runtime bridge — bridgeRuntime (host) ↔ bridgeClient (surface) over
// fakeChrome's runtime messaging. The bridge reads the GLOBAL chrome, so each
// test installs the fake there and restores after.
// ───────────────────────────────────────────────────────────────────────────

const globalWithChrome = globalThis as { chrome?: unknown };

function installFakeChrome() {
  const fake = fakeChrome();
  globalWithChrome.chrome = fake;
  return fake;
}

function parseCounterMsg(raw: unknown): CounterMsg | null {
  if (typeof raw !== "object" || raw === null) return null;
  return (raw as Record<string, unknown>).type === "inc"
    ? { type: "inc" }
    : null;
}

describe("bridgeRuntime ↔ bridgeClient", () => {
  let host: Runtime<CounterState, CounterMsg> | null = null;
  let disposeBridge: (() => void) | null = null;

  afterEach(async () => {
    disposeBridge?.();
    disposeBridge = null;
    await host?.stop();
    host = null;
    globalWithChrome.chrome = undefined;
  });

  async function bootBridgedHost() {
    installFakeChrome();
    host = await run(counterMachine(), { ctx: undefined }).ready;
    disposeBridge = bridgeRuntime(host, {
      channel: "test",
      parseMsg: parseCounterMsg,
    });
    return host;
  }

  it("hydrate() returns the host's current state and primes getSnapshot()", async () => {
    const h = await bootBridgedHost();
    await h.dispatch({ type: "inc" });

    const client = bridgeClient<CounterState, CounterMsg>({
      channel: "test",
      parseState: parseCounter,
      parseMsg: parseCounterMsg,
    });
    expect(client.getSnapshot()).toBeNull(); // pre-hydrate sentinel
    await expect(client.hydrate()).resolves.toEqual({ n: 1 });
    expect(client.getSnapshot()).toEqual({ n: 1 });
  });

  it("client dispatch round-trips: surface → host reducer → broadcast → subscriber", async () => {
    await bootBridgedHost();
    const client = bridgeClient<CounterState, CounterMsg>({
      channel: "test",
      parseState: parseCounter,
      parseMsg: parseCounterMsg,
    });

    const seen: Array<{ msg: CounterMsg | null; state: CounterState }> = [];
    const unsubscribe = client.subscribe((msg, state) => {
      seen.push({ msg, state });
    });

    await client.dispatch({ type: "inc" });
    await expect
      .poll(() => client.getSnapshot(), { timeout: 2000 })
      .toEqual({ n: 1 });
    expect(seen).toContainEqual({ msg: { type: "inc" }, state: { n: 1 } });

    // After unsubscribe the listener no longer hears broadcasts.
    unsubscribe();
    await client.dispatch({ type: "inc" });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.some((e) => e.state.n === 2)).toBe(false);
  });

  it("passThroughMsg lets a state-only surface opt out of msg parsing", async () => {
    await bootBridgedHost();
    const client = bridgeClient<CounterState, CounterMsg>({
      channel: "test",
      parseState: parseCounter,
      parseMsg: passThroughMsg,
    });
    // getSnapshot only tracks broadcasts while a subscription is active.
    client.subscribe(() => {});
    await client.dispatch({ type: "inc" });
    await expect
      .poll(() => client.getSnapshot(), { timeout: 2000 })
      .toEqual({ n: 1 });
  });

  it("a broadcast whose state fails the boundary parse is dropped silently", async () => {
    await bootBridgedHost();
    const client = bridgeClient<CounterState, CounterMsg>({
      channel: "test",
      parseState: () => null, // reject everything
      parseMsg: parseCounterMsg,
    });
    let called = 0;
    client.subscribe(() => {
      called += 1;
    });
    await client.dispatch({ type: "inc" });
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(0);
    expect(client.getSnapshot()).toBeNull();
  });

  it("a dispatch whose msg fails the host boundary parse is dropped, never reaching the reducer", async () => {
    const h = await bootBridgedHost();
    const client = bridgeClient<CounterState, CounterMsg>({
      channel: "test",
      parseState: parseCounter,
      // Bypass the client-side parse so a malformed msg reaches the host wire —
      // it is the HOST's parseMsg (Inv 8) that must reject it.
      parseMsg: passThroughMsg,
    });

    // dispatch() resolves (the host replies { ok: false } rather than
    // rejecting the send), but the reducer never ran — state is untouched.
    await client.dispatch({ type: "bogus" } as unknown as CounterMsg);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.getState()).toEqual({ n: 0 });
  });

  it("the disposer detaches the host: a later dispatch finds no receiver", async () => {
    await bootBridgedHost();
    const client = bridgeClient<CounterState, CounterMsg>({
      channel: "test",
      parseState: parseCounter,
      parseMsg: parseCounterMsg,
    });
    disposeBridge?.();
    disposeBridge = null;

    // fakeChrome mirrors chrome's no-receiver rejection once the bridge's
    // onMessage listener is removed.
    await expect(client.dispatch({ type: "inc" })).rejects.toThrow(
      /Receiving end does not exist/,
    );
  });
});
