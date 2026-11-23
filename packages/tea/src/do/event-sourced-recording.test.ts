/**
 * `doEventSourcedStore` with `recording`: the log is a recording, one frame per
 * boot and per applied Msg, each with the State after it and the Cmds the engine
 * started. Restore, snapshots and reads treat it as the log of Msgs it contains.
 */

import { describe, expect, it, vi } from "vitest";
import { fakeDoStorage as fakeStorage } from "../__fixtures__/do-storage";
import { defineMachine, type Transitions } from "../index";
import { run } from "../promise";
import {
  doEventLogReader,
  doEventSourcedStore,
  type EventSourcedOptions,
  type StoredFrame,
} from "./index";

interface Model {
  readonly _tag: "counting";
  readonly count: number;
  readonly items: readonly string[];
}
type Msg = { _tag: "inc"; by: number } | { _tag: "reset" };
type Cmd = { _tag: "notify"; count: number } | { _tag: "hello" };

const fresh: Model = {
  _tag: "counting",
  count: 0,
  items: Array.from({ length: 40 }, (_, at) => `item-${at}`),
};

const update: Transitions<Model, Msg, Cmd> = {
  counting: {
    inc: (s, m) => [
      { ...s, count: s.count + m.by },
      [{ _tag: "notify", count: s.count + m.by }],
    ],
    reset: (s) => [{ ...s, count: 0 }, []],
  },
};

const counter = defineMachine({
  types: { model: {} as Model, msg: {} as Msg, cmd: {} as Cmd },
  init: (loaded) => [loaded ?? fresh, [{ _tag: "hello" }]],
  update,
});

const key = (seq: number) => `@@es/evt/${String(seq).padStart(16, "0")}`;
const ctx = {};

type Options = Omit<EventSourcedOptions<Model, Msg>, "keys">;

/** One run over `backing`: boot, dispatch each Msg, stop. Returns the State it ended in. */
async function liveRun(
  backing: Map<string, string>,
  msgs: readonly Msg[],
  opts: Options,
): Promise<Model> {
  const es = doEventSourcedStore(
    fakeStorage(backing).storage,
    counter,
    ctx,
    opts,
  );
  const rt = await run(counter, {
    store: es.store,
    onError: () => {},
    interpret: { notify: async () => {}, hello: async () => {} },
  }).ready;
  for (const msg of msgs) await rt.dispatch(msg);
  const state = rt.getState();
  await rt.stop();
  return state;
}

async function framesOf(backing: Map<string, string>) {
  const reader = doEventLogReader<Msg>(fakeStorage(backing).storage);
  const frames: StoredFrame<Msg>[] = [];
  for await (const frame of reader.readFrames({}, { evidence: true })) {
    frames.push(frame);
  }
  return frames;
}

const tags = (frames: readonly StoredFrame<Msg>[]) =>
  frames.map((frame) => frame._tag);
const inc = (by: number): Msg => ({ _tag: "inc", by });
const recording = { recording: { provenance: { run: "r" } } };

describe("a log written as a recording", () => {
  it("has an init frame for the boot and a step frame per Msg, each with its State and Cmds", async () => {
    const backing = new Map<string, string>();

    const ended = await liveRun(
      backing,
      [inc(1), inc(2), { _tag: "reset" }],
      recording,
    );

    const frames = await framesOf(backing);
    expect(tags(frames)).toEqual(["init", "step", "step", "step"]);
    expect(frames[0]).toMatchObject({
      restored: false,
      provenance: { run: "r" },
      evidence: { state: fresh, cmds: [{ _tag: "hello" }] },
    });
    expect(frames.slice(1)).toMatchObject([
      {
        evidence: { state: { count: 1 }, cmds: [{ _tag: "notify", count: 1 }] },
      },
      {
        evidence: { state: { count: 3 }, cmds: [{ _tag: "notify", count: 3 }] },
      },
      { evidence: { state: ended, cmds: [] } },
    ]);
    expect(JSON.parse(backing.get("@@es/meta") ?? "")).toEqual({ lastSeq: 4 });
  });

  it("restores by folding its Msgs and skipping its init frames, and each restart opens with an init frame", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1), inc(2)], recording);

    const ended = await liveRun(backing, [inc(4)], recording);

    expect(ended.count).toBe(7);
    const frames = await framesOf(backing);
    expect(tags(frames)).toEqual(["init", "step", "step", "init", "step"]);
    expect(
      frames.flatMap((frame) =>
        frame._tag === "init" ? [frame.restored] : [],
      ),
    ).toEqual([false, true]);
    expect(frames[3]).toMatchObject({
      evidence: { state: { count: 3 }, cmds: [{ _tag: "hello" }] },
    });
  });

  it("continues its chain of deltas across a restart", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], recording);

    await liveRun(backing, [inc(2)], recording);

    const frames = await framesOf(backing);
    expect(
      frames.map((frame) => "encoding" in frame && frame.encoding),
    ).toEqual(["full", "delta", "delta", "delta"]);
  });

  it("counts Msgs, not init frames, toward snapshotEvery", async () => {
    const backing = new Map<string, string>();

    await liveRun(backing, [inc(1), inc(1)], {
      ...recording,
      snapshotEvery: 2,
    });

    expect(JSON.parse(backing.get("@@es/snapshot") ?? "").seq).toBe(3);
    const again = await liveRun(backing, [inc(1)], {
      ...recording,
      snapshotEvery: 2,
    });
    expect(again.count).toBe(3);
    expect(JSON.parse(backing.get("@@es/snapshot") ?? "").seq).toBe(3);
  });

  it("counts only Msgs after a restart that the snapshot does not cover", async () => {
    const backing = new Map<string, string>();
    const opts = { ...recording, snapshotEvery: 3 };
    await liveRun(backing, [inc(1)], opts);

    await liveRun(backing, [inc(1), inc(1)], opts);

    expect(JSON.parse(backing.get("@@es/snapshot") ?? "").seq).toBe(5);
  });

  it("starts counting again after snapshotNow", async () => {
    const backing = new Map<string, string>();
    const es = doEventSourcedStore(fakeStorage(backing).storage, counter, ctx, {
      ...recording,
      snapshotEvery: 3,
    });
    await es.store.load();
    const saveStep = (by: number) =>
      es.store.save({ ...fresh, count: by }, inc(by), {
        _tag: "step",
        cmds: [],
      });
    await es.store.save(fresh, undefined, { _tag: "init", cmds: [] });
    await saveStep(1);

    expect(await es.snapshotNow()).toBe(true);
    for (const by of [2, 3, 4]) await saveStep(by);

    expect(JSON.parse(backing.get("@@es/snapshot") ?? "").seq).toBe(5);
  });

  it("snapshots the State its Msgs fold to, not the State an active init made of it", async () => {
    const backing = new Map<string, string>();
    const es = doEventSourcedStore(
      fakeStorage(backing).storage,
      counter,
      ctx,
      recording,
    );
    await es.store.load();

    await es.store.save({ ...fresh, count: 100 }, undefined, {
      _tag: "init",
      cmds: [],
    });

    expect(await es.snapshotNow()).toBe(true);
    expect(JSON.parse(backing.get("@@es/snapshot") ?? "")).toMatchObject({
      seq: 1,
      state: { count: 0 },
    });
  });

  it("keeps being written as a recording without the option, and gets no init frame", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], recording);

    await liveRun(backing, [inc(2)], {});

    expect(tags(await framesOf(backing))).toEqual(["init", "step", "step"]);
  });

  it("writes a step frame with no Cmds when the save names no boundary", async () => {
    const backing = new Map<string, string>();
    const es = doEventSourcedStore(
      fakeStorage(backing).storage,
      counter,
      ctx,
      recording,
    );
    await es.store.load();

    await es.store.save({ ...fresh, count: 5 }, inc(5));

    expect(await framesOf(backing)).toMatchObject([
      { _tag: "step", evidence: { state: { count: 5 }, cmds: null } },
    ]);
  });
});

describe("a log written as bare messages", () => {
  it("stays bare messages when a later run asks for a recording", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], {});

    const ended = await liveRun(backing, [inc(2)], recording);

    expect(ended.count).toBe(3);
    expect(tags(await framesOf(backing))).toEqual(["message", "message"]);
    expect(JSON.parse(backing.get(key(2)) ?? "")).toEqual(inc(2));
  });
});

describe("restoring a recording that cannot be read", () => {
  it("refuses a cell that starts a recording but is not a frame", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], recording);
    backing.set(key(2), '{"tea":"recording/1","frame":"step"}');

    await expect(
      doEventSourcedStore(
        fakeStorage(backing).storage,
        counter,
        ctx,
        recording,
      ).store.load(),
    ).rejects.toThrow(/recording frame was refused/);
  });
});

describe("restoring a recording whose evidence is broken", () => {
  const damageDelta = (backing: Map<string, string>, seq: number) => {
    const cell = JSON.parse(backing.get(key(seq)) ?? "");
    cell.evidence.delta = btoa("not a delta");
    backing.set(key(seq), JSON.stringify(cell));
  };

  const cases = [
    {
      name: "a delta that fails its checksum",
      opts: {},
      msgs: [inc(1)],
      damage: (backing: Map<string, string>) => damageDelta(backing, 2),
      broken: { fromSeq: 2, toSeq: 2, reason: "checksum" },
      count: 11,
    },
    {
      name: "a delta in the middle of a chain that fails its checksum",
      opts: {},
      msgs: [inc(1), inc(1), inc(1)],
      damage: (backing: Map<string, string>) => damageDelta(backing, 3),
      broken: { fromSeq: 3, toSeq: 4, reason: "checksum" },
      count: 13,
    },
    {
      name: "a frame the next one is a delta of, gone from the log",
      opts: { snapshotEvery: 2 },
      msgs: [inc(1), inc(1), inc(1)],
      damage: (backing: Map<string, string>) => backing.delete(key(3)),
      broken: { fromSeq: 3, toSeq: 4, reason: "basis" },
      count: 13,
    },
    {
      name: "a cell, older than the snapshot, that is not a frame",
      opts: { snapshotEvery: 2 },
      msgs: [inc(1), inc(1)],
      damage: (backing: Map<string, string>) =>
        backing.set(key(2), '{"tea":"recording/1","frame":"step"}'),
      broken: { fromSeq: 2, toSeq: 3, reason: "frame" },
      count: 12,
    },
    {
      name: "every cell gone from under a snapshot",
      opts: { snapshotEvery: 1 },
      msgs: [inc(1), inc(1)],
      damage: (backing: Map<string, string>) => {
        for (const seq of [1, 2, 3]) backing.delete(key(seq));
      },
      broken: { fromSeq: 3, toSeq: 3, reason: "basis" },
      count: 12,
    },
  ] as const;

  it.each(
    cases,
  )("resumes after $name, reports where, and writes the next frame whole", async ({
    opts,
    msgs,
    damage,
    broken,
    count,
  }) => {
    const backing = new Map<string, string>();
    await liveRun(backing, msgs, { ...recording, ...opts });
    damage(backing);
    const heard: unknown[] = [];

    const ended = await liveRun(backing, [inc(10)], {
      ...recording,
      ...opts,
      onRecordingBreak: (b) => heard.push(b),
    });

    expect(ended.count).toBe(count);
    expect(heard).toEqual([broken]);
    const frames = await framesOf(backing);
    const [restart, next] = frames.slice(-2);
    expect([restart?._tag, next?._tag]).toEqual(["init", "step"]);
    expect(restart).toMatchObject({ encoding: "full", restored: true });
    expect(next).toMatchObject({ encoding: "delta" });
  });

  it("writes the next frame whole when a second load of the same store finds the break", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1), inc(1)], recording);
    const { store } = doEventSourcedStore(
      fakeStorage(backing).storage,
      counter,
      ctx,
      { ...recording, onRecordingBreak: () => {} },
    );
    await store.load();
    damageDelta(backing, 3);

    await store.load();
    await store.save(fresh, inc(1), { _tag: "step", cmds: [] });

    expect((await framesOf(backing)).at(-1)).toMatchObject({
      seq: 4,
      encoding: "full",
    });
  });

  it("still refuses to rebuild the broken frames when they are read", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], recording);
    damageDelta(backing, 2);
    await liveRun(backing, [inc(1)], recording);

    const frames = await framesOf(backing);

    expect(frames.map((frame) => frame._tag)).toEqual([
      "init",
      "refused",
      "init",
      "step",
    ]);
    expect(frames[1]).toMatchObject({ seq: 2, reason: "checksum" });
  });

  it("warns by default, naming the frames", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], recording);
    damageDelta(backing, 2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await liveRun(backing, [], recording);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /frames 2 to 2 \(checksum\)/,
    );
    warn.mockRestore();
  });

  it("is not stopped by a hook that throws", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], recording);
    damageDelta(backing, 2);
    const hookFailure = new Error("hook");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ended = await liveRun(backing, [inc(1)], {
      ...recording,
      onRecordingBreak: () => {
        throw hookFailure;
      },
    });

    expect(ended.count).toBe(2);
    expect(warn).toHaveBeenCalledWith(hookFailure);
    warn.mockRestore();
  });
});
