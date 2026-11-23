/**
 * Reading a recording log: `readFrames` sees each cell as a frame, rebuilds its
 * evidence on request, and `readStoredEvents` / `readEvents` still see only Msgs.
 * The logs here are built with the frame codec, one cell per frame.
 */

import { describe, expect, it, vi } from "vitest";
import { fakeDoStorage as fakeStorage } from "../__fixtures__/do-storage";
import { doEventLogReader, type StoredFrame } from "./index";
import {
  type Basis,
  encodeFrame,
  type FrameEvidence,
  FULL_FRAME_EVERY,
} from "./recording-frames";

interface Msg {
  readonly _tag: "inc" | "reset";
  readonly by?: number;
}

const key = (seq: number) => `@@es/evt/${String(seq).padStart(16, "0")}`;

/** The State after frame `n`: big enough that a delta beats a whole frame. */
const evidenceAt = (n: number): FrameEvidence => ({
  state: { n, items: Array.from({ length: 40 }, (_, at) => `item-${at}`) },
  cmds: n % 2 === 0 ? [] : [{ _tag: "go", n }],
});

/** A recording of one init frame and `steps` step frames, one cell each. */
async function recordedLog(steps: number): Promise<Map<string, string>> {
  const backing = new Map<string, string>();
  let basis: Basis | null = null;
  for (let seq = 1; seq <= steps + 1; seq += 1) {
    const written: { json: string; basis: Basis } = await encodeFrame(
      seq,
      seq === 1
        ? { frame: "init", restored: false, provenance: { run: "r" } }
        : { frame: "step", msgJson: JSON.stringify({ _tag: "inc", by: seq }) },
      evidenceAt(seq),
      basis,
    );
    backing.set(key(seq), written.json);
    basis = written.basis;
  }
  backing.set("@@es/meta", JSON.stringify({ lastSeq: steps + 1 }));
  return backing;
}

async function collect<T>(
  source: AsyncIterable<T>,
  bound = 2_000,
): Promise<T[]> {
  const all: T[] = [];
  for await (const item of source) {
    all.push(item);
    if (all.length > bound) throw new Error(`a read ran past ${bound} items`);
  }
  return all;
}

const readerOver = (backing: Map<string, string>) =>
  doEventLogReader<Msg>(fakeStorage(backing).storage);

const refusals = (frames: readonly StoredFrame<Msg>[]) =>
  frames.map((frame) => (frame._tag === "refused" ? frame.reason : frame._tag));

describe("readFrames on a recording log", () => {
  it("sees an init frame and a step frame per Msg, and reports the log's format", async () => {
    const reader = readerOver(await recordedLog(3));

    const frames = await collect(reader.readFrames());

    expect(await reader.readHead()).toEqual({
      lastSeq: 4,
      snapshot: false,
      format: "recording",
    });
    expect(frames.map((frame) => frame._tag)).toEqual([
      "init",
      "step",
      "step",
      "step",
    ]);
    expect(frames[0]).toMatchObject({
      restored: false,
      provenance: { run: "r" },
      encoding: "full",
    });
    expect(frames[2]).toMatchObject({
      seq: 3,
      event: { _tag: "inc", by: 3 },
      messageBytes: JSON.stringify({ _tag: "inc", by: 3 }).length,
      encoding: "delta",
    });
    expect(frames.some((frame) => "evidence" in frame)).toBe(false);
  });

  it("rebuilds each frame's State and Cmds along a chain of deltas", async () => {
    const reader = readerOver(await recordedLog(40));

    const frames = await collect(reader.readFrames({}, { evidence: true }));

    expect(
      frames.map((frame) => "evidence" in frame && frame.evidence),
    ).toEqual(Array.from({ length: 41 }, (_, at) => evidenceAt(at + 1)));
  });

  it("rebuilds a range that starts inside a chain, from one page of the frames before it", async () => {
    const { storage } = fakeStorage(await recordedLog(40));
    const list = vi.spyOn(storage, "list");
    const reader = doEventLogReader<Msg>(storage);

    const frames = await collect(
      reader.readFrames({ fromSeq: 20, toSeq: 22 }, { evidence: true }),
    );

    expect(frames).toHaveLength(3);
    expect(frames[2]).toMatchObject({ evidence: evidenceAt(22) });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toMatchObject({
      end: key(20),
      reverse: true,
      limit: FULL_FRAME_EVERY,
    });
  });

  it("rebuilds a range that starts after a whole frame, reading back no further than it", async () => {
    const reader = readerOver(await recordedLog(40));

    const frames = await collect(
      reader.readFrames({ fromSeq: 35, toSeq: 36 }, { evidence: true }),
    );

    expect(frames).toMatchObject([
      { evidence: evidenceAt(35) },
      { evidence: evidenceAt(36) },
    ]);
  });

  it('"verify" checks the evidence and yields none', async () => {
    const reader = readerOver(await recordedLog(3));

    const frames = await collect(reader.readFrames({}, { evidence: "verify" }));

    expect(frames.map((frame) => frame._tag)).toEqual([
      "init",
      "step",
      "step",
      "step",
    ]);
    expect(frames.some((frame) => "evidence" in frame)).toBe(false);
  });

  it("refuses a frame whose checksum fails, and each delta that needs it", async () => {
    const backing = await recordedLog(4);
    const damaged = JSON.parse(backing.get(key(3)) ?? "");
    damaged.evidence.delta = btoa("not a delta");
    backing.set(key(3), JSON.stringify(damaged));
    const reader = readerOver(backing);

    const frames = await collect(reader.readFrames({}, { evidence: true }));

    expect(refusals(frames)).toEqual([
      "init",
      "step",
      "checksum",
      "basis",
      "basis",
    ]);
    expect(frames[2]).toStrictEqual({
      _tag: "refused",
      key: key(3),
      seq: 3,
      serializedBytes: JSON.stringify(damaged).length,
      reason: "checksum",
    });
    expect(
      refusals(await collect(reader.readFrames({}, { evidence: "verify" }))),
    ).toEqual(["init", "step", "checksum", "basis", "basis"]);
    expect(refusals(await collect(reader.readFrames()))).toEqual([
      "init",
      "step",
      "step",
      "step",
      "step",
    ]);
  });

  it("rebuilds the deltas after a frame whose Msg the host refuses, because only its Msg is refused", async () => {
    const backing = await recordedLog(4);
    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage, {
      parseEvent: (raw) => ((raw as Msg).by === 3 ? null : (raw as Msg)),
    });

    const frames = await collect(reader.readFrames({}, { evidence: true }));
    const inside = await collect(
      reader.readFrames({ fromSeq: 4 }, { evidence: true }),
    );

    expect(refusals(frames)).toEqual(["init", "step", "event", "step", "step"]);
    expect(frames).toMatchObject([
      { evidence: evidenceAt(1) },
      { evidence: evidenceAt(2) },
      { _tag: "refused", seq: 3 },
      { evidence: evidenceAt(4) },
      { evidence: evidenceAt(5) },
    ]);
    expect(inside).toMatchObject([
      { evidence: evidenceAt(4) },
      { evidence: evidenceAt(5) },
    ]);
  });

  it.each([
    [128, 300],
    [256, 300],
    [129, 300],
  ])("reads exactly a limit of %i cells over a log of %i", async (limit, cells) => {
    const reader = readerOver(await recordedLog(cells - 1));

    const forward = await collect(reader.readFrames({ limit }));
    const backward = await collect(
      reader.readFrames({ limit }, { reverse: true }),
    );

    expect(forward.map((frame) => ("seq" in frame ? frame.seq : null))).toEqual(
      Array.from({ length: limit }, (_, at) => at + 1),
    );
    expect(backward).toHaveLength(limit);
  });

  it("reads a range from its highest seq down, in pages, without evidence", async () => {
    const reader = readerOver(await recordedLog(200));

    const all = await collect(reader.readFrames({}, { reverse: true }));
    const top = await collect(
      reader.readFrames({ toSeq: 100, limit: 2 }, { reverse: true }),
    );
    const wanted = await collect(
      reader.readFrames({}, { reverse: true, evidence: true }),
    );

    expect(all.map((frame) => ("seq" in frame ? frame.seq : null))).toEqual(
      Array.from({ length: 201 }, (_, at) => 201 - at),
    );
    expect(top.map((frame) => ("seq" in frame ? frame.seq : null))).toEqual([
      100, 99,
    ]);
    expect(wanted.some((frame) => "evidence" in frame)).toBe(false);
  });

  it("reports a cell that is not a frame, and a Msg the host does not parse", async () => {
    const backing = await recordedLog(1);
    backing.set(key(3), '{"tea":"recording/1","frame":"step"}');
    backing.set(key(4), '{"tea":"recording/2","frame":"step","msg":{}}');
    backing.set(key(5), '{"tea":"recording/1",');
    backing.set(key(6), (backing.get(key(2)) ?? "").replace("inc", "gone"));
    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage, {
      parseEvent: (raw) =>
        JSON.stringify(raw).includes("gone") ? null : (raw as Msg),
    });

    expect(refusals(await collect(reader.readFrames()))).toEqual([
      "init",
      "step",
      "frame",
      "frame",
      "json",
      "event",
    ]);
  });
});

describe("a log read for its Msgs only", () => {
  it("skips init frames, sizes an event by its Msg, and drops a frame it cannot read", async () => {
    const backing = await recordedLog(3);
    backing.set(key(3), '{"tea":"recording/1","frame":"step"}');
    const reader = readerOver(backing);

    const stored = await collect(reader.readStoredEvents());
    const events = await collect(reader.readEvents());

    expect(
      stored.map((cell) => (cell._tag === "refused" ? cell.reason : cell.seq)),
    ).toEqual([2, "frame", 4]);
    expect(stored[0]).toMatchObject({
      _tag: "decoded",
      serializedBytes: JSON.stringify({ _tag: "inc", by: 2 }).length,
    });
    expect(events.map((event) => event.seq)).toEqual([2, 4]);
  });

  it("sees a log of bare messages as message frames, sized by their own text", async () => {
    const backing = new Map([
      [key(1), '{"_tag":"inc","by":1}'],
      ["@@es/meta", '{"lastSeq":1}'],
    ]);
    const reader = readerOver(backing);

    const frames = await collect(reader.readFrames({}, { evidence: true }));

    expect(frames).toEqual([
      {
        _tag: "message",
        key: key(1),
        seq: 1,
        serializedBytes: 21,
        messageBytes: 21,
        event: { _tag: "inc", by: 1 },
      },
    ]);
  });
});

describe("a cell the reader refuses", () => {
  const frameAt = async (backing: Map<string, string>, seq: number) => {
    const frames = await collect(
      readerOver(backing).readFrames({ fromSeq: seq, toSeq: seq }),
    );
    return frames[0];
  };

  it("reports a recording cell under a key that is not a sequence, with no seq", async () => {
    const backing = await recordedLog(1);
    const cell = backing.get(key(2)) ?? "";
    backing.set("@@es/evt/not-a-seq", cell);

    const frames = await collect(readerOver(backing).readFrames());

    expect(frames.at(-1)).toStrictEqual({
      _tag: "refused",
      key: "@@es/evt/not-a-seq",
      seq: null,
      serializedBytes: cell.length,
      reason: "key",
    });
  });

  it.each([
    [
      "another version of the format",
      '{"tea":"recording/2","frame":"step","msg":{}}',
    ],
    ["another version of the format, cut short", '{"tea":"recording/2",'],
    ["a step with no Msg", '{"tea":"recording/1","frame":"step"}'],
  ])("reports %s as a frame, with no cause", async (_name, cell) => {
    const backing = await recordedLog(1);
    backing.set(key(2), cell);

    expect(await frameAt(backing, 2)).toStrictEqual({
      _tag: "refused",
      key: key(2),
      seq: 2,
      serializedBytes: cell.length,
      reason: "frame",
    });
  });

  it("keeps what JSON.parse threw as the cause of a json refusal", async () => {
    const backing = await recordedLog(1);
    backing.set(key(2), '{"tea":"recording/1",');

    const frame = await frameAt(backing, 2);

    if (frame?._tag !== "refused") throw new Error("not refused");
    expect(frame.reason).toBe("json");
    expect(frame.cause).toBeInstanceOf(SyntaxError);
  });
});

describe("an init frame", () => {
  it("says whether the boot restored a log", async () => {
    const backing = await recordedLog(1);
    const second = await encodeFrame(
      3,
      { frame: "init", restored: true, provenance: { run: "again" } },
      evidenceAt(3),
      null,
    );
    backing.set(key(3), second.json);

    const frames = await collect(readerOver(backing).readFrames());

    expect(frames.map((frame) => frame._tag)).toEqual(["init", "step", "init"]);
    expect(
      frames.map((frame) => frame._tag === "init" && frame.restored),
    ).toEqual([false, false, true]);
    expect(frames[2]).toMatchObject({ provenance: { run: "again" } });
  });
});

describe("the head of a log", () => {
  const meta = (lastSeq: number) => ["@@es/meta", `{"lastSeq":${lastSeq}}`];

  it.each([
    ["has no format before its first cell", [meta(0)], null],
    [
      "is messages for a log of one Msg",
      [[key(1), '{"_tag":"inc"}'], meta(1)],
      "messages",
    ],
    [
      "is a recording for a log of one init frame",
      [
        [
          key(1),
          '{"tea":"recording/1","frame":"init","restored":false,"evidence":{"full":""}}',
        ],
        meta(1),
      ],
      "recording",
    ],
    [
      "is a recording when the first cell is a format this build does not know",
      [[key(1), '{"tea":"recording/2","frame":"init"}'], meta(1)],
      "recording",
    ],
  ] as const)("%s", async (_name, cells, format) => {
    const reader = readerOver(
      new Map(cells.map(([cellKey, text]) => [cellKey, text])),
    );

    expect(await reader.readHead()).toMatchObject({ format });
  });
});
