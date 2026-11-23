/**
 * `doEventSourcedStore` with `recording`: the log is a recording, one frame per
 * boot and per applied Msg, each with the State after it and the Cmds the engine
 * started. Restore, snapshots and reads treat it as the log of Msgs it contains.
 */

import { describe, expect, it } from "vitest";
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

  it("refuses when the evidence its next frame is a delta of cannot be rebuilt", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [inc(1)], recording);
    const damaged = JSON.parse(backing.get(key(2)) ?? "");
    damaged.evidence.delta = btoa("not a delta");
    backing.set(key(2), JSON.stringify(damaged));

    await expect(
      doEventSourcedStore(
        fakeStorage(backing).storage,
        counter,
        ctx,
        recording,
      ).store.load(),
    ).rejects.toThrow(/recorded evidence could not be rebuilt/);
  });
});
