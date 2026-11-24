import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDoStorage } from "../__fixtures__/do-storage";
import { defineMachine, foldMsgs, type Transitions } from "../index";
import { recorder, replayTrace, type Trace, writeTrace } from "../persistence";
import { run } from "../promise";
import mainBytes from "./fixtures/recording-bytes.main.json";
import { recordingBytesScenario } from "./fixtures/recording-bytes-scenario";
import {
  doEventLogReader,
  doEventSourcedStore,
  type EventSourcedOptions,
  type RecordingBreak,
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
    const back = await reader.readTrace<Model>();
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
    for (const [seq, cell] of backing) {
      if (seq.startsWith("@@es/evt/")) {
        expect(seq.length + cell.length).toBeLessThanOrEqual(budget);
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

    const restored = storeOn(backing, opts);
    expect(await restored.store.load()).toEqual(final);
    expect(breaks).toHaveLength(1);
  });

  it("reports the recording unavailable for replay, with no matched prefix", async () => {
    const { opts } = heard();
    const backing = new Map<string, string>();
    await liveRun(backing, run5, opts);

    const back = await doEventLogReader<Msg>(
      fakeDoStorage(backing).storage,
    ).readTrace<Model>();

    expect(back._tag).toBe("unavailable");
    expect(back).toMatchObject({ seq: 3, reason: "oversized" });
    expect("trace" in back).toBe(false);
  });

  it("restores across a marker when the snapshot written beside it is the latest", async () => {
    const { opts } = heard();
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1), big], opts);

    expect(JSON.parse(backing.get("@@es/snapshot") as string).seq).toBe(3);
    const final = await liveRun(backing, [{ _tag: "shrink" }, inc(4)], opts);
    expect(final).toMatchObject({ count: 5, blob: "" });
    expect(await storeOn(backing, opts).store.load()).toEqual(final);
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
    expect(await storeOn(backing, opts).store.load()).toEqual(trace.finalState);
    const back = await doEventLogReader<Msg>(
      fakeDoStorage(backing).storage,
    ).readTrace();
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

    const final = await liveRun(backing, msgs, opts);

    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(eventSeqs(backing)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.parse(backing.get(key(7)) as string)).toMatchObject({
      frame: "step",
      msg: inc(2),
    });
    expect(await storeOn(backing, opts).store.load()).toEqual(final);
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

    const final = await saveRun(es);

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
    expect(await storeOn(backing, {}).store.load()).toEqual(final);
    expect(
      await doEventLogReader<Msg>(fakeDoStorage(backing).storage).readTrace(),
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

  it("propagates SQLITE_TOOBIG when the store has no row budget", async () => {
    const backing = new Map<string, string>();
    const fake = fakeDoStorage(backing);
    fake.failPut((k) => k === key(2), tooBig());
    const es = doEventSourcedStore(fake.storage, counter, ctx, recording);

    await expect(saveRun(es)).rejects.toThrow(/SQLITE_TOOBIG/);
    expect(eventSeqs(backing)).toEqual([1]);
  });
});

describe("a store given no moved anchor and no row budget", () => {
  it("stores the bytes the release before them stored", async () => {
    expect(await recordingBytesScenario()).toEqual(mainBytes);
  });
});
