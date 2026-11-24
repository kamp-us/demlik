import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDoStorage } from "../__fixtures__/do-storage";
import {
  defineMachine,
  foldMsgs,
  StoreRefusedError,
  type Transitions,
} from "../index";
import { recorder, replayTrace, type Trace, writeTrace } from "../persistence";
import { run } from "../promise";
import mainBytes from "./fixtures/recording-bytes.main.json";
import { recordingBytesScenario } from "./fixtures/recording-bytes-scenario";
import {
  doEventLogReader,
  doEventSourcedStore,
  type EventSourcedOptions,
  type RecordingBreak,
  RecordingUnavailableError,
  readTrace,
} from "./index";

interface Model {
  readonly _tag: "counting";
  readonly count: number;
  readonly blob: string;
}
type Msg =
  | { _tag: "inc"; by: number }
  | { _tag: "grow"; size: number; seed: number }
  | { _tag: "shrink" };
type Cmd = { _tag: "notify"; count: number };

function noise(size: number, seed: number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let state = seed >>> 0 || 1;
  let out = "";
  for (let at = 0; at < size; at += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

const update: Transitions<Model, Msg, Cmd> = {
  counting: {
    inc: (s, m) => [
      { ...s, count: s.count + m.by },
      [{ _tag: "notify", count: s.count + m.by }],
    ],
    grow: (s, m) => [{ ...s, blob: noise(m.size, m.seed) }, []],
    shrink: (s) => [{ ...s, blob: "" }, []],
  },
};

const counter = defineMachine({
  types: { model: {} as Model, msg: {} as Msg, cmd: {} as Cmd },
  init: (loaded) => [loaded ?? { _tag: "counting", count: 0, blob: "" }, []],
  update,
});

const ctx = {};
const key = (seq: number) => `@@es/evt/${String(seq).padStart(16, "0")}`;
const inc = (by: number): Msg => ({ _tag: "inc", by });
const interpret = { notify: async () => {} };
type Options = EventSourcedOptions<Model, Msg>;

const storeOn = (backing: Map<string, string>, opts: Options) =>
  doEventSourcedStore(fakeDoStorage(backing).storage, counter, ctx, opts);

const eventSeqs = (backing: Map<string, string>) =>
  [...backing.keys()]
    .filter((k) => k.startsWith("@@es/evt/"))
    .map((k) => Number(k.slice("@@es/evt/".length)))
    .sort((a, b) => a - b);

async function recordWindowed(
  msgs: readonly Msg[],
  window: number,
): Promise<Trace<Model, Msg>> {
  const handle = run(counter, { onError: () => {}, interpret });
  const capture = recorder(handle, { captureSteps: true, window });
  const rt = await handle.ready;
  for (const msg of msgs) await rt.dispatch(msg);
  await rt.stop();
  capture.stop();
  return capture.dump();
}

async function liveRun(
  backing: Map<string, string>,
  msgs: readonly Msg[],
  opts: Options,
): Promise<Model> {
  const rt = await run(counter, {
    store: storeOn(backing, opts).store,
    onError: () => {},
    interpret,
  }).ready;
  for (const msg of msgs) await rt.dispatch(msg);
  const state = rt.getState();
  await rt.stop();
  return state;
}

const thousand = Array.from({ length: 1000 }, (_, at) => inc(at + 1));
const recording = { recording: { provenance: { run: "w" } } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a windowed trace written into an empty recording store", () => {
  it("keeps a 1000-transition run's last 10 at their live seqs, reads back, and replays to finalState", async () => {
    const trace = await recordWindowed(thousand, 10);
    expect(trace.skipped).toBe(990);
    const backing = new Map<string, string>();

    await writeTrace(storeOn(backing, recording).store, trace);

    expect(eventSeqs(backing)).toEqual(
      Array.from({ length: 11 }, (_, at) => 991 + at),
    );
    const anchor = JSON.parse(backing.get(key(991)) as string);
    expect(anchor).toMatchObject({
      frame: "init",
      restored: false,
      skipped: 990,
    });

    const reader = doEventLogReader<Msg>(fakeDoStorage(backing).storage);
    const back = await readTrace<Model, Msg>(reader);
    if (back._tag !== "trace") throw new Error(`unavailable: ${back.reason}`);
    expect(back.trace.skipped).toBe(990);
    expect(back.trace.loaded).toEqual(trace.loaded);
    expect(back.trace.msgs).toEqual(trace.msgs);
    expect(back.trace.finalState).toEqual(trace.finalState);
    const replay = replayTrace(counter, back.trace);
    expect(replay.matches).toBe(true);
    expect(replay.actual).toEqual(trace.finalState);
    expect(replay.actual.count).toBe(500500);
  });

  it("numbers each step as the live run on a recording store numbered it", async () => {
    const live = new Map<string, string>();
    await liveRun(live, thousand.slice(0, 30), recording);
    const trace = await recordWindowed(thousand.slice(0, 30), 4);
    const written = new Map<string, string>();

    await writeTrace(storeOn(written, recording).store, trace);

    for (const seq of [28, 29, 30, 31]) {
      expect(JSON.parse(written.get(key(seq)) as string).msg).toEqual(
        JSON.parse(live.get(key(seq)) as string).msg,
      );
    }
    expect(eventSeqs(written)).toEqual([27, 28, 29, 30, 31]);
  });

  it("restores the run's final State, and keeps numbering from the last live seq", async () => {
    const trace = await recordWindowed(thousand, 10);
    const backing = new Map<string, string>();
    await writeTrace(storeOn(backing, recording).store, trace);

    const es = storeOn(backing, recording);
    expect(await es.store.load()).toEqual(trace.finalState);
    expect(await es.getCommittedSeq()).toBe(1001);
    await liveRun(backing, [inc(1)], recording);

    expect(eventSeqs(backing).slice(-3)).toEqual([1001, 1002, 1003]);
    const head = await doEventLogReader<Msg>(
      fakeDoStorage(backing).storage,
    ).readHead();
    expect(head).toMatchObject({ lastSeq: 1003, format: "recording" });
    const restarted = JSON.parse(backing.get(key(1002)) as string);
    expect(restarted).toMatchObject({ frame: "init", restored: true });
    expect(restarted.skipped).toBeUndefined();
  });

  it("round-trips the count through the stored init frame and readFrames", async () => {
    const trace = await recordWindowed(thousand.slice(0, 20), 5);
    const backing = new Map<string, string>();
    await writeTrace(storeOn(backing, recording).store, trace);

    const reader = doEventLogReader<Msg>(fakeDoStorage(backing).storage);
    const frames = [];
    for await (const frame of reader.readFrames({}, { evidence: true })) {
      frames.push(frame);
    }
    expect(frames[0]).toMatchObject({
      _tag: "init",
      seq: 16,
      skipped: 15,
      restored: false,
      evidence: { state: trace.loaded },
    });
    expect(frames.map((frame) => frame.seq)).toEqual([16, 17, 18, 19, 20, 21]);
  });

  it("gives a log written as bare messages the same offset, with no frame", async () => {
    const trace = await recordWindowed(thousand, 10);
    const backing = new Map<string, string>();

    await writeTrace(storeOn(backing, {}).store, trace);

    expect(eventSeqs(backing)).toEqual(
      Array.from({ length: 10 }, (_, at) => 991 + at),
    );
    expect(JSON.parse(backing.get("@@es/snapshot") as string)).toEqual({
      seq: 990,
      state: trace.loaded,
    });
    expect(await storeOn(backing, {}).store.load()).toEqual(trace.finalState);
  });
});

describe("an offset the store refuses", () => {
  it("refuses a windowed trace written into a log that already has frames, and writes nothing", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1), inc(2)], recording);
    const before = new Map(backing);
    const trace = await recordWindowed(thousand.slice(0, 20), 5);

    await expect(
      writeTrace(storeOn(backing, recording).store, trace),
    ).rejects.toThrow(/empty log only/);
    expect(backing).toEqual(before);
  });

  it("refuses a moved anchor saved into a log of messages that already has events", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], {});
    const es = storeOn(backing, {});
    await es.store.load();

    await expect(
      es.store.save({ _tag: "counting", count: 9, blob: "" }, undefined, {
        _tag: "init",
        cmds: [],
        skipped: 4,
      }),
    ).rejects.toThrow(/empty log only/);
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
  ])("refuses a skipped count of %s from writeTrace before it loads or saves", async (skipped) => {
    const trace = await recordWindowed(thousand.slice(0, 20), 5);
    const backing = new Map<string, string>();
    let loaded = false;

    await expect(
      writeTrace(
        {
          load: async () => {
            loaded = true;
            return null;
          },
          save: async () => {},
        },
        { ...trace, skipped },
      ),
    ).rejects.toThrow(/integer >= 0/);
    expect(loaded).toBe(false);
    await expect(
      writeTrace(storeOn(backing, recording).store, { ...trace, skipped }),
    ).rejects.toThrow(/integer >= 0/);
    expect(backing.size).toBe(0);
  });

  it.each([
    -3, 0.25,
  ])("refuses a skipped count of %s on the store's own init boundary", async (skipped) => {
    const backing = new Map<string, string>();
    const es = storeOn(backing, recording);
    await es.store.load();

    await expect(
      es.store.save({ _tag: "counting", count: 0, blob: "" }, undefined, {
        _tag: "init",
        cmds: [],
        skipped,
      }),
    ).rejects.toThrow(/integer >= 0/);
    expect(eventSeqs(backing)).toEqual([]);
  });
});

describe("a frame over its row budget", () => {
  const budget = 2_000;
  const big: Msg = { _tag: "grow", size: 6_000, seed: 7 };
  const run5: Msg[] = [inc(1), big, { _tag: "shrink" }, inc(2), inc(3)];

  function heard() {
    const breaks: RecordingBreak[] = [];
    const opts: Options = {
      recording: { provenance: null, maxRowBytes: budget },
      onRecordingBreak: (b) => {
        breaks.push(b);
      },
    };
    return { breaks, opts };
  }

  it("becomes a marker at its seq, the frames after it are kept, and the host hears seq and bytes", async () => {
    const { breaks, opts } = heard();
    const backing = new Map<string, string>();

    const final = await liveRun(backing, run5, opts);

    expect(eventSeqs(backing)).toEqual([1, 2, 3, 4, 5, 6]);
    const marker = JSON.parse(backing.get(key(3)) as string);
    expect(marker).toMatchObject({
      frame: "refused",
      reason: "oversized",
      of: "step",
      seq: 3,
    });
    expect(marker.bytes).toBeGreaterThan(budget);
    expect((backing.get(key(3)) as string).length).toBeLessThan(200);
    expect(backing.has("@@es/snapshot")).toBe(false);
    for (const [cellKey, cell] of backing) {
      if (cellKey.startsWith("@@es/evt/")) {
        expect(cellKey.length + cell.length).toBeLessThanOrEqual(budget);
      }
    }
    expect(breaks).toEqual([
      {
        fromSeq: 3,
        toSeq: 3,
        reason: "oversized",
        seq: 3,
        bytes: marker.bytes,
      },
    ]);

    const reader = doEventLogReader<Msg>(fakeDoStorage(backing).storage);
    const frames = [];
    for await (const frame of reader.readFrames({}, { evidence: true })) {
      frames.push(frame);
    }
    expect(frames.map((frame) => frame._tag)).toEqual([
      "init",
      "step",
      "refused",
      "step",
      "step",
      "step",
    ]);
    expect(frames[2]).toMatchObject({
      reason: "oversized",
      seq: 3,
      bytes: marker.bytes,
    });
    expect(frames[3]).toMatchObject({ encoding: "full" });
    expect(frames[5]).toMatchObject({ evidence: { state: final } });

    expect(breaks).toHaveLength(1);
  });

  it("reports replay unavailable, and refuses to load a State from the log, naming the marker's seq", async () => {
    const { opts } = heard();
    const backing = new Map<string, string>();
    await liveRun(backing, run5, opts);

    const back = await readTrace<Model, Msg>(
      doEventLogReader<Msg>(fakeDoStorage(backing).storage),
    );

    expect(back._tag).toBe("unavailable");
    expect(back).toMatchObject({ seq: 3, reason: "oversized" });
    expect("trace" in back).toBe(false);

    const refused = await storeOn(backing, opts)
      .store.load()
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RecordingUnavailableError);
    expect(refused).toMatchObject({
      _tag: "recording_unavailable",
      reason: "oversized",
      seq: 3,
    });

    const failure = await run(counter, {
      store: storeOn(backing, opts).store,
      onError: () => {},
      interpret,
    }).ready.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StoreRefusedError);
    expect((failure as StoreRefusedError).cause).toMatchObject({ seq: 3 });
  });

  it("writes no snapshot beside a marker, even when one is due", async () => {
    const { opts } = heard();
    const backing = new Map<string, string>();

    await liveRun(backing, [inc(1), big, { _tag: "shrink" }, inc(2)], {
      ...opts,
      snapshotEvery: 2,
    });

    expect(JSON.parse(backing.get(key(3)) as string).reason).toBe("oversized");
    expect(JSON.parse(backing.get("@@es/snapshot") as string).seq).toBe(4);
    expect(JSON.parse(backing.get("@@es/meta") as string)).toEqual({
      lastSeq: 5,
      marked: 3,
    });
  });

  it("still takes appends and reads once its load is refused", async () => {
    const { opts } = heard();
    const backing = new Map<string, string>();
    const final = await liveRun(backing, [inc(1), big], opts);
    const es = storeOn(backing, opts);
    await expect(es.store.load()).rejects.toBeInstanceOf(
      RecordingUnavailableError,
    );

    const next = { ...final, count: final.count + 1, blob: "" };
    await es.store.save(next, inc(1), { _tag: "step", cmds: [] });

    expect(eventSeqs(backing)).toEqual([1, 2, 3, 4]);
    const events = [];
    for await (const event of doEventLogReader<Msg>(
      fakeDoStorage(backing).storage,
    ).readEvents()) {
      events.push(event.seq);
    }
    expect(events).toEqual([2, 4]);
    expect(JSON.parse(backing.get("@@es/meta") as string)).toEqual({
      lastSeq: 4,
      marked: 3,
    });
  });

  it("puts a marker in place of an oversized anchor too", async () => {
    const { breaks, opts } = heard();
    const msgs: Msg[] = [inc(5), big, { _tag: "shrink" }, inc(1), inc(2)];
    const trace = await recordWindowed(msgs, 3);
    expect(trace.skipped).toBe(2);
    const backing = new Map<string, string>();

    await writeTrace(storeOn(backing, opts).store, trace);

    expect(JSON.parse(backing.get(key(3)) as string)).toMatchObject({
      frame: "refused",
      of: "init",
      seq: 3,
    });
    expect(eventSeqs(backing)).toEqual([3, 4, 5, 6]);
    expect(breaks.map((b) => b.fromSeq)).toEqual([3]);
    expect(backing.has("@@es/snapshot")).toBe(false);
    await expect(storeOn(backing, opts).store.load()).rejects.toMatchObject({
      seq: 3,
    });
    const back = await readTrace<Model, Msg>(
      doEventLogReader<Msg>(fakeDoStorage(backing).storage),
    );
    expect(back).toMatchObject({ _tag: "unavailable", reason: "oversized" });
  });

  it("does not stop later frames when the observer throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backing = new Map<string, string>();
    let calls = 0;
    const opts: Options = {
      recording: { provenance: null, maxRowBytes: budget },
      onRecordingBreak: () => {
        calls += 1;
        throw new Error("observer broke");
      },
    };
    const msgs: Msg[] = [
      big,
      { _tag: "shrink" },
      inc(1),
      { _tag: "grow", size: 6_000, seed: 9 },
      { _tag: "shrink" },
      inc(2),
    ];

    await liveRun(backing, msgs, opts);

    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(eventSeqs(backing)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.parse(backing.get(key(7)) as string)).toMatchObject({
      frame: "step",
      msg: inc(2),
    });
    await expect(storeOn(backing, opts).store.load()).rejects.toMatchObject({
      seq: 2,
    });
  });

  it("does not stop later frames when the observer rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backing = new Map<string, string>();
    const opts: Options = {
      recording: { provenance: null, maxRowBytes: budget },
      onRecordingBreak: (() =>
        Promise.reject(new Error("observer rejected"))) as () => void,
    };

    await liveRun(backing, [big, { _tag: "shrink" }, inc(1)], opts);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventSeqs(backing)).toEqual([1, 2, 3, 4]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns by default, naming the seq and the bytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backing = new Map<string, string>();

    await liveRun(backing, [big], {
      recording: { provenance: null, maxRowBytes: budget },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /frame 2 measured \d+ bytes/,
    );
  });

  it("is not applied to a log written as bare messages", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], {});

    await liveRun(backing, [big], {
      recording: { provenance: null, maxRowBytes: budget },
    });

    expect(JSON.parse(backing.get(key(2)) as string)._tag).toBe("grow");
  });

  it.each([
    0, -1, 2.5,
  ])("refuses a maxRowBytes of %s when the store is built", (maxRowBytes) => {
    expect(() =>
      storeOn(new Map(), { recording: { provenance: null, maxRowBytes } }),
    ).toThrow(/maxRowBytes/);
  });
});

describe("a write the storage rejects", () => {
  const tooBig = () =>
    Object.assign(new Error("string or blob too big: SQLITE_TOOBIG"), {
      code: "SQLITE_TOOBIG",
    });

  function rejecting(seq: number, cause: Error) {
    const backing = new Map<string, string>();
    const fake = fakeDoStorage(backing);
    let armed = true;
    fake.failPut((k) => {
      if (k !== key(seq) || !armed) return false;
      armed = false;
      return true;
    }, cause);
    const breaks: RecordingBreak[] = [];
    const es = doEventSourcedStore(fake.storage, counter, ctx, {
      recording: { provenance: null, maxRowBytes: 8_000_000 },
      onRecordingBreak: (b) => {
        breaks.push(b);
      },
    });
    return { backing, es, breaks };
  }

  async function saveRun(
    es: ReturnType<typeof doEventSourcedStore<Model, Msg, object>>,
  ) {
    let state = (await es.store.load()) as Model;
    await es.store.save(state, undefined, { _tag: "init", cmds: [] });
    for (const msg of [inc(1), inc(2), inc(3)]) {
      state = foldMsgs(counter, state, [msg]);
      await es.store.save(state, msg, { _tag: "step", cmds: [] });
    }
    return state;
  }

  it("takes SQLITE_TOOBIG as an oversized frame: a marker at its seq, the rest kept", async () => {
    const { backing, es, breaks } = rejecting(3, tooBig());

    await saveRun(es);

    expect(JSON.parse(backing.get(key(3)) as string)).toMatchObject({
      frame: "refused",
      reason: "oversized",
      of: "step",
      seq: 3,
    });
    expect(eventSeqs(backing)).toEqual([1, 2, 3, 4]);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ reason: "oversized", seq: 3 });
    expect((breaks[0] as { bytes: number }).bytes).toBeGreaterThan(0);
    await expect(storeOn(backing, {}).store.load()).rejects.toMatchObject({
      seq: 3,
    });
    expect(
      await readTrace<Model, Msg>(
        doEventLogReader<Msg>(fakeDoStorage(backing).storage),
      ),
    ).toMatchObject({ _tag: "unavailable", seq: 3, reason: "oversized" });
  });

  it("takes SQLITE_TOOBIG carried as an error's cause the same way", async () => {
    const { backing, es } = rejecting(
      2,
      new Error("put failed", { cause: tooBig() }),
    );

    await saveRun(es);

    expect(JSON.parse(backing.get(key(2)) as string).reason).toBe("oversized");
  });

  it("propagates any other storage failure and writes nothing for it", async () => {
    const { backing, es, breaks } = rejecting(
      3,
      new Error("storage is unavailable"),
    );

    await expect(saveRun(es)).rejects.toThrow("storage is unavailable");
    expect(eventSeqs(backing)).toEqual([1, 2]);
    expect(breaks).toEqual([]);
  });

  it("propagates SQLITE_TOOBIG on a snapshot, not the frame, and writes nothing for it", async () => {
    const backing = new Map<string, string>();
    const fake = fakeDoStorage(backing);
    fake.failPut((k) => k === "@@es/snapshot", tooBig());
    const breaks: RecordingBreak[] = [];
    const es = doEventSourcedStore(fake.storage, counter, ctx, {
      snapshotEvery: 2,
      recording: { provenance: null, maxRowBytes: 8_000_000 },
      onRecordingBreak: (b) => {
        breaks.push(b);
      },
    });

    await expect(saveRun(es)).rejects.toThrow(/SQLITE_TOOBIG/);
    expect(eventSeqs(backing)).toEqual([1, 2]);
    expect(breaks).toEqual([]);
  });

  it("propagates SQLITE_TOOBIG when the store has no row budget", async () => {
    const backing = new Map<string, string>();
    const fake = fakeDoStorage(backing);
    fake.failPut((k) => k === key(2), tooBig());
    const es = doEventSourcedStore(fake.storage, counter, ctx, recording);

    await expect(saveRun(es)).rejects.toThrow(/SQLITE_TOOBIG/);
    expect(eventSeqs(backing)).toEqual([1]);
  });
});

function rowLimited(backing: Map<string, string>, limit: number) {
  const { storage } = fakeDoStorage(backing);
  const rejected: string[] = [];
  const transaction = storage.transaction.bind(storage);
  const limited = Object.assign(Object.create(storage), {
    transaction: <T>(
      closure: (txn: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> =>
      transaction((txn) => {
        const put = txn.put.bind(txn) as (
          k: string,
          v: string,
        ) => Promise<void>;
        const guarded = Object.assign(Object.create(txn), {
          put: async (k: string, v: string) => {
            if (new TextEncoder().encode(v).byteLength > limit) {
              rejected.push(k);
              throw new Error(`string or blob too big: SQLITE_TOOBIG (${k})`);
            }
            await put(k, v);
          },
          delete: txn.delete.bind(txn),
        }) as DurableObjectTransaction;
        return closure(guarded);
      }),
  }) as DurableObjectStorage;
  return { storage: limited, rejected };
}

describe("loading a log that holds a marker, again and again", () => {
  const big: Msg = { _tag: "grow", size: 6_000, seed: 7 };
  const tooBig = () => new Error("string or blob too big: SQLITE_TOOBIG");

  async function measuredStep() {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1), big, { _tag: "shrink" }], {
      recording: { provenance: null, maxRowBytes: 2_000 },
      onRecordingBreak: () => {},
    });
    return { backing, seq: 3 };
  }

  async function measuredAnchor() {
    const backing = new Map<string, string>();
    const trace = await recordWindowed(
      [inc(5), big, { _tag: "shrink" }, inc(1)],
      2,
    );
    await writeTrace(
      storeOn(backing, {
        recording: { provenance: null, maxRowBytes: 2_000 },
        onRecordingBreak: () => {},
      }).store,
      trace,
    );
    return { backing, seq: 3 };
  }

  async function rejectedFrame(at: number) {
    const backing = new Map<string, string>();
    const fake = fakeDoStorage(backing);
    let armed = true;
    fake.failPut((k) => {
      if (k !== key(at) || !armed) return false;
      armed = false;
      return true;
    }, tooBig());
    const rt = await run(counter, {
      store: doEventSourcedStore(fake.storage, counter, ctx, {
        recording: { provenance: null, maxRowBytes: 8_000_000 },
        onRecordingBreak: () => {},
      }).store,
      onError: () => {},
      interpret,
    }).ready;
    await rt.dispatch(inc(1));
    await rt.dispatch(inc(2));
    await rt.stop();
    return { backing, seq: at };
  }

  const logs = [
    ["a step marker from a measured budget", measuredStep],
    ["an init marker at a moved anchor", measuredAnchor],
    ["a step marker from SQLITE_TOOBIG", () => rejectedFrame(3)],
    ["an init marker from SQLITE_TOOBIG", () => rejectedFrame(1)],
  ] as const;

  it.each(
    logs,
  )("refuses %s with its seq on every direct load, spending no restore attempt", async (_name, make) => {
    const { backing, seq } = await make();

    for (const limit of [1, 1, 1, 0, 0]) {
      const refused = await storeOn(backing, { restoreRetryLimit: limit })
        .store.load()
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(RecordingUnavailableError);
      expect(refused).toMatchObject({ seq });
    }
    expect(backing.has("@@es/meta/restore-attempt")).toBe(false);
  });

  it.each(
    logs,
  )("refuses %s with its seq on every runtime boot, with restoreRetryLimit 0 too", async (_name, make) => {
    const { backing, seq } = await make();

    for (const limit of [1, 1, 1, 0, 0]) {
      const failure = await run(counter, {
        store: storeOn(backing, { restoreRetryLimit: limit }).store,
        onError: () => {},
        interpret,
      }).ready.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(StoreRefusedError);
      expect((failure as StoreRefusedError).cause).toBeInstanceOf(
        RecordingUnavailableError,
      );
      expect((failure as StoreRefusedError).cause).toMatchObject({ seq });
    }
  });
});

describe("a size rejection that persists on every try", () => {
  const limit = 4_096;
  const huge: Msg = { _tag: "grow", size: 40_000, seed: 3 };

  function storeLimited(
    backing: Map<string, string>,
    breaks: RecordingBreak[],
  ) {
    const limited = rowLimited(backing, limit);
    const es = doEventSourcedStore(limited.storage, counter, ctx, {
      recording: { provenance: null, maxRowBytes: 1_000_000 },
      onRecordingBreak: (b) => {
        breaks.push(b);
      },
    });
    return { es, rejected: limited.rejected };
  }

  it("leaves a marker for each frame storage rejects and keeps every frame after it", async () => {
    const backing = new Map<string, string>();
    const breaks: RecordingBreak[] = [];
    const { es, rejected } = storeLimited(backing, breaks);
    const msgs: Msg[] = [inc(1), huge, inc(2), { _tag: "shrink" }, inc(3)];
    const rt = await run(counter, {
      store: es.store,
      onError: () => {},
      interpret,
    }).ready;
    for (const msg of msgs) await rt.dispatch(msg);
    await rt.stop();

    expect(rejected).toEqual([key(3), key(4)]);
    expect(eventSeqs(backing)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(breaks.map((b) => b.seq)).toEqual([3, 4]);
    expect(JSON.parse(backing.get(key(6)) as string)).toMatchObject({
      frame: "step",
      msg: inc(3),
    });
    await expect(storeOn(backing, {}).store.load()).rejects.toMatchObject({
      seq: 3,
    });
  });

  it("writes a windowed trace whose anchor State fits no row, with no snapshot beside its marker", async () => {
    const backing = new Map<string, string>();
    const breaks: RecordingBreak[] = [];
    const { es } = storeLimited(backing, breaks);
    const trace = await recordWindowed(
      [inc(1), huge, inc(2), inc(3), { _tag: "shrink" }, inc(4)],
      4,
    );
    expect(trace.skipped).toBe(2);

    await writeTrace(es.store, trace);

    expect(eventSeqs(backing)).toEqual([3, 4, 5, 6, 7]);
    expect(breaks.map((b) => b.seq)).toEqual([3, 4, 5]);
    expect(backing.has("@@es/snapshot")).toBe(false);
    expect(
      await readTrace<Model, Msg>(
        doEventLogReader<Msg>(fakeDoStorage(backing).storage),
      ),
    ).toMatchObject({ _tag: "unavailable", seq: 3, reason: "oversized" });
    await expect(storeOn(backing, {}).store.load()).rejects.toMatchObject({
      seq: 3,
    });
  });
});

describe("sequence numbers past the safe range", () => {
  const max = Number.MAX_SAFE_INTEGER;

  it.each([
    max,
    max - 5,
  ])("writeTrace refuses a skipped count of %s whose steps would pass it, before it loads", async (skipped) => {
    const trace = await recordWindowed(thousand.slice(0, 20), 10);
    let loaded = false;

    await expect(
      writeTrace(
        {
          load: async () => {
            loaded = true;
            return null;
          },
          save: async () => {},
        },
        { ...trace, skipped },
      ),
    ).rejects.toThrow(/safe integer/);
    expect(loaded).toBe(false);
  });

  it.each([
    [recording],
    [{}],
  ])("the store refuses a moved anchor of MAX_SAFE_INTEGER on either format (%#)", async (opts) => {
    const backing = new Map<string, string>();
    const es = storeOn(backing, opts);
    await es.store.load();

    await expect(
      es.store.save({ _tag: "counting", count: 0, blob: "" }, undefined, {
        _tag: "init",
        cmds: [],
        skipped: max,
      }),
    ).rejects.toThrow(/safe sequence/);
    expect(backing.size).toBe(0);
  });

  it.each([
    [recording],
    [{}],
  ])("the store refuses a step past MAX_SAFE_INTEGER and keeps the log readable (%#)", async (opts) => {
    const backing = new Map<string, string>();
    const es = storeOn(backing, opts);
    await es.store.load();
    await es.store.save({ _tag: "counting", count: 0, blob: "" }, undefined, {
      _tag: "init",
      cmds: [],
      skipped: max - 1,
    });
    const head = await es.getCommittedSeq();

    const steps: Promise<void>[] = [];
    for (let at = head; at <= max; at += 1) {
      steps.push(
        es.store.save({ _tag: "counting", count: at, blob: "" }, inc(1), {
          _tag: "step",
          cmds: [],
        }),
      );
    }
    const settled = await Promise.allSettled(steps);

    expect(settled.at(-1)?.status).toBe("rejected");
    expect(await es.getCommittedSeq()).toBeLessThanOrEqual(max);
    expect(eventSeqs(backing).every(Number.isSafeInteger)).toBe(true);
    await expect(storeOn(backing, opts).store.load()).resolves.toBeDefined();
  });
});

describe("a recording missing a committed frame", () => {
  async function fiveSteps() {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1), inc(2), inc(3), inc(4), inc(5)], recording);
    return backing;
  }
  const read = (backing: Map<string, string>, range = {}) =>
    readTrace<Model, Msg>(
      doEventLogReader<Msg>(fakeDoStorage(backing).storage),
      range,
    );

  it("reads the whole recording as a trace that replays", async () => {
    const back = await read(await fiveSteps());

    expect(back._tag).toBe("trace");
    if (back._tag === "trace") {
      expect(back.trace.msgs).toHaveLength(5);
      expect(replayTrace(counter, back.trace).matches).toBe(true);
    }
  });

  it("is unavailable at a gap inside it, not a prefix before the gap", async () => {
    const backing = await fiveSteps();
    backing.delete(key(4));

    expect(await read(backing)).toEqual({
      _tag: "unavailable",
      seq: 4,
      reason: "gap",
    });
  });

  it("is unavailable when its cells stop before the committed head", async () => {
    const backing = await fiveSteps();
    backing.delete(key(6));
    backing.delete(key(5));

    expect(await read(backing)).toEqual({
      _tag: "unavailable",
      seq: 5,
      reason: "tail",
    });
  });

  it("is unavailable when the range starts at a seq with no cell", async () => {
    const backing = await fiveSteps();
    backing.delete(key(1));

    expect(await read(backing, { fromSeq: 1 })).toMatchObject({
      reason: "gap",
      seq: 1,
    });
    expect(await read(backing)).toMatchObject({
      _tag: "unavailable",
      seq: 2,
    });
  });

  it("reads a range that ends before the head as the trace up to it", async () => {
    const back = await read(await fiveSteps(), { toSeq: 3 });

    expect(back._tag).toBe("trace");
    if (back._tag === "trace")
      expect(back.trace.msgs).toEqual([inc(1), inc(2)]);
  });

  it("is empty for a log with nothing committed", async () => {
    expect(await read(new Map())).toEqual({
      _tag: "unavailable",
      seq: null,
      reason: "empty",
    });
  });
});

describe("a store given no moved anchor and no row budget", () => {
  it("stores the bytes the release before them stored", async () => {
    expect(await recordingBytesScenario()).toEqual(mainBytes);
  });
});
