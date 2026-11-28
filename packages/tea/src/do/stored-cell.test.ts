/**
 * Byte-bounded stored cells: every value `doEventSourcedStore` writes is
 * under 1,000,000 bytes of UTF-8, and a snapshot or event cell at or over the
 * bound is a manifest plus parts that every read reassembles before it parses.
 *
 * The fake storage keeps no value bound of its own, so each test that writes a
 * large cell also checks the bound on every retained value: the fake proves
 * the shape of the writes, not Cloudflare's limit.
 */

import { describe, expect, it } from "vitest";
import { fakeDoStorage as fakeStorage } from "../__fixtures__/do-storage";
import { defineMachine, type Reducer } from "../index";
import { run } from "../promise";
import { doEventLogReader, doEventSourcedStore, readTrace } from "./index";
import { STORED_VALUE_BYTES, storedRows } from "./stored-cell";

interface State {
  readonly text: string;
}

type Msg = { readonly _tag: "set"; readonly text: string };

const update: Reducer<State, Msg, never> = {
  set: (_s, m) => [{ text: m.text }, []],
};

function textMachine() {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      ctx: {} as Record<string, never>,
    },
    init: (loaded) => [loaded ?? { text: "" }, []],
    update,
  });
}

const ctx: Record<string, never> = {};
const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).byteLength;

const SNAPSHOT = "@@es/snapshot";
const META = "@@es/meta";
const PARTS = "@@es/part/";
const evt = (seq: number) => `@@es/evt/${String(seq).padStart(16, "0")}`;
const partsOf = (backing: Map<string, string>, key: string) =>
  [...backing.keys()].filter((k) => k.startsWith(`${PARTS}${key}/`)).sort();

/**
 * About `bytes` bytes of text with one-, two- and four-byte characters, so a
 * part boundary lands inside a character unless the cut walks back from it.
 */
function textOf(bytes: number): string {
  const unit = "a😀ğ"; // 1 + 4 + 2 bytes
  return unit.repeat(Math.ceil(bytes / 7));
}

/** Every retained value is under the bound. */
function expectBounded(backing: Map<string, string>): void {
  for (const [key, value] of backing) {
    expect(bytesOf(value), key).toBeLessThan(STORED_VALUE_BYTES);
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const item of source) all.push(item);
  return all;
}

/** A loaded store over `backing`, ready to save. */
async function loaded(backing: Map<string, string>, snapshotEvery = 1) {
  const faults = fakeStorage(backing);
  const es = doEventSourcedStore(faults.storage, textMachine(), ctx, {
    snapshotEvery,
  });
  await es.store.load();
  return { ...faults, es };
}

/** Restore `backing` in a new activation and read its State. */
async function restored(backing: Map<string, string>): Promise<State> {
  const { storage } = fakeStorage(backing);
  const es = doEventSourcedStore(storage, textMachine(), ctx, {
    snapshotEvery: 1_000,
  });
  const rt = await run(textMachine(), { ctx, store: es.store }).ready;
  try {
    return rt.getState();
  } finally {
    await rt.stop();
  }
}

describe("storedRows", () => {
  it("writes a value under the bound as itself, and one at the bound as a manifest and parts", () => {
    const under = "x".repeat(STORED_VALUE_BYTES - 1);
    expect(storedRows(PARTS, "k", under)).toEqual({
      key: "k",
      rows: [["k", under]],
      parts: 0,
    });

    const at = "x".repeat(STORED_VALUE_BYTES);
    const write = storedRows(PARTS, "k", at);
    expect(write.parts).toBe(2);
    expect(write.rows.map(([key]) => key)).toEqual([
      "k",
      `${PARTS}k/000000`,
      `${PARTS}k/000001`,
    ]);
    expect(write.rows[0]?.[1]).toBe(
      `@@es/cell:1:${JSON.stringify({ parts: 2, bytes: STORED_VALUE_BYTES })}`,
    );
  });

  it("cuts parts between characters, each strictly under the bound", () => {
    const value = textOf(2_500_000);
    const write = storedRows(PARTS, "k", value);
    const parts = write.rows.slice(1).map(([, text]) => text);
    expect(parts).toHaveLength(write.parts);
    for (const part of parts) {
      expect(bytesOf(part)).toBeLessThan(STORED_VALUE_BYTES);
      expect(part).not.toContain("�");
    }
    expect(parts.join("")).toBe(value);
  });
});

describe("doEventSourcedStore — a cell over the value bound", () => {
  it("is written in parts and restores, reads and exports as the one cell it was", async () => {
    const backing = new Map<string, string>();
    const text = textOf(2_500_000);
    const { es } = await loaded(backing);
    await es.store.save({ text }, { _tag: "set", text });

    expectBounded(backing);
    expect(backing.get(evt(1))).toMatch(/^@@es\/cell:1:/);
    expect(backing.get(SNAPSHOT)).toMatch(/^@@es\/cell:1:/);
    expect(partsOf(backing, evt(1))).toHaveLength(3);
    expect(partsOf(backing, SNAPSHOT)).toHaveLength(3);
    expect(JSON.parse(backing.get(META) ?? "")).toEqual({ lastSeq: 1 });

    expect(await restored(backing)).toEqual({ text });

    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage);
    const json = JSON.stringify({ _tag: "set", text });
    expect(await collect(reader.readStoredEvents())).toEqual([
      {
        _tag: "decoded",
        key: evt(1),
        seq: 1,
        serializedBytes: bytesOf(json),
        event: { _tag: "set", text },
      },
    ]);
    expect(await collect(reader.readFrames())).toEqual([
      {
        _tag: "message",
        key: evt(1),
        seq: 1,
        serializedBytes: bytesOf(json),
        messageBytes: bytesOf(json),
        event: { _tag: "set", text },
      },
    ]);
  });

  it("replays a log tail of cells in parts on top of the snapshot", async () => {
    const backing = new Map<string, string>();
    const first = textOf(1_200_000);
    const second = `${textOf(1_100_000)}!`;
    const { es } = await loaded(backing, 1_000);
    await es.store.save({ text: first }, { _tag: "set", text: first });
    await es.store.save({ text: second }, { _tag: "set", text: second });

    expect(backing.has(SNAPSHOT)).toBe(false);
    expectBounded(backing);
    expect(await restored(backing)).toEqual({ text: second });
  });

  it("reads a recording frame stored in parts, and readTrace sees its whole Msg", async () => {
    const backing = new Map<string, string>();
    const { storage } = fakeStorage(backing);
    const es = doEventSourcedStore(storage, textMachine(), ctx, {
      recording: { provenance: { run: "r" } },
    });
    const text = textOf(1_500_000);
    const rt = await run(textMachine(), { ctx, store: es.store }).ready;
    try {
      await rt.dispatch({ _tag: "set", text });
    } finally {
      await rt.stop();
    }

    expectBounded(backing);
    expect(backing.get(evt(2))).toMatch(/^@@es\/cell:1:/);
    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage);
    const frames = await collect(reader.readFrames({}, { evidence: true }));
    expect(frames.map((frame) => frame._tag)).toEqual(["init", "step"]);
    expect(frames[1]).toMatchObject({
      seq: 2,
      event: { _tag: "set", text },
      messageBytes: bytesOf(JSON.stringify({ _tag: "set", text })),
      evidence: { state: { text } },
    });
    const trace = await readTrace<State, Msg>(reader);
    expect(trace._tag).toBe("trace");
    if (trace._tag === "trace") {
      expect(trace.trace.msgs).toEqual([{ _tag: "set", text }]);
      expect(trace.trace.finalState).toEqual({ text });
    }
    expect(await restored(backing)).toEqual({ text });
  });
});

describe("doEventSourcedStore — rewriting a cell stored in parts", () => {
  it("deletes the old parts when a large cell shrinks to a small one", async () => {
    const backing = new Map<string, string>();
    const { es } = await loaded(backing);
    const large = textOf(2_500_000);
    await es.store.save({ text: large }, { _tag: "set", text: large });
    expect(partsOf(backing, SNAPSHOT)).toHaveLength(3);

    await es.store.save({ text: "small" }, { _tag: "set", text: "small" });
    expect(partsOf(backing, SNAPSHOT)).toEqual([]);
    expect(JSON.parse(backing.get(SNAPSHOT) ?? "")).toEqual({
      seq: 2,
      state: { text: "small" },
    });
    // The first event's own parts are another key's and stay.
    expect(partsOf(backing, evt(1))).toHaveLength(3);
    expect(await restored(backing)).toEqual({ text: "small" });
  });

  it("deletes only the obsolete parts when a cell is rewritten in fewer parts", async () => {
    const backing = new Map<string, string>();
    const { es } = await loaded(backing);
    const four = textOf(3_500_000);
    await es.store.save({ text: four }, { _tag: "set", text: four });
    expect(partsOf(backing, SNAPSHOT)).toHaveLength(4);

    const two = `${textOf(1_500_000)}?`;
    await es.store.save({ text: two }, { _tag: "set", text: two });
    expect(partsOf(backing, SNAPSHOT)).toEqual([
      `${PARTS}${SNAPSHOT}/000000`,
      `${PARTS}${SNAPSHOT}/000001`,
    ]);
    expectBounded(backing);
    expect(await restored(backing)).toEqual({ text: two });
  });

  it("keeps the stored bytes as they were when a part's write fails", async () => {
    const backing = new Map<string, string>();
    const faults = await loaded(backing);
    const first = textOf(2_500_000);
    await faults.es.store.save({ text: first }, { _tag: "set", text: first });
    const before = new Map(backing);

    faults.failPut((key) => key === `${PARTS}${SNAPSHOT}/000001`);
    const next = textOf(1_500_000);
    await expect(
      faults.es.store.save({ text: next }, { _tag: "set", text: next }),
    ).rejects.toThrow();
    expect(backing).toEqual(before);
    expect(await restored(backing)).toEqual({ text: first });
  });

  it("puts the deleted parts back when the shrinking write fails after deleting them", async () => {
    const backing = new Map<string, string>();
    const faults = await loaded(backing);
    const first = textOf(2_500_000);
    await faults.es.store.save({ text: first }, { _tag: "set", text: first });
    const before = new Map(backing);

    // The stale parts are deleted before the snapshot key is put.
    faults.failPut((key) => key === SNAPSHOT);
    await expect(
      faults.es.store.save({ text: "small" }, { _tag: "set", text: "small" }),
    ).rejects.toThrow();
    expect(backing).toEqual(before);
    expect(await restored(backing)).toEqual({ text: first });
  });
});

describe("doEventSourcedStore — a cell whose parts do not reassemble", () => {
  async function written(): Promise<Map<string, string>> {
    const backing = new Map<string, string>();
    const { es } = await loaded(backing, 1_000);
    const text = textOf(2_500_000);
    await es.store.save({ text }, { _tag: "set", text });
    return backing;
  }

  it("reads as refused (`part`) when a part is missing, and refuses a restore", async () => {
    const backing = await written();
    const missing = `${PARTS}${evt(1)}/000001`;
    const firstPart = backing.get(`${PARTS}${evt(1)}/000000`) ?? "";
    backing.delete(missing);

    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage);
    expect(await collect(reader.readStoredEvents())).toEqual([
      {
        _tag: "refused",
        key: evt(1),
        seq: 1,
        serializedBytes: bytesOf(firstPart),
        reason: "part",
      },
    ]);
    const es = doEventSourcedStore(
      fakeStorage(backing).storage,
      textMachine(),
      ctx,
    );
    await expect(es.store.load()).rejects.toThrow(
      "a stored event's parts are missing",
    );
  });

  it("reads as refused when its parts' bytes do not add up to the manifest's", async () => {
    const backing = await written();
    const key = `${PARTS}${evt(1)}/000002`;
    backing.set(key, (backing.get(key) ?? "").slice(0, -1));

    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage);
    const [cell] = await collect(reader.readStoredEvents());
    expect(cell).toMatchObject({ _tag: "refused", reason: "part" });
  });

  it("refuses a restore from a snapshot whose parts are missing", async () => {
    const backing = new Map<string, string>();
    const { es } = await loaded(backing);
    const text = textOf(2_500_000);
    await es.store.save({ text }, { _tag: "set", text });
    backing.delete(`${PARTS}${SNAPSHOT}/000000`);

    const again = doEventSourcedStore(
      fakeStorage(backing).storage,
      textMachine(),
      ctx,
    );
    await expect(again.store.load()).rejects.toThrow(
      "persisted snapshot's parts are missing",
    );
  });
});

describe("doEventSourcedStore — cells written before parts existed", () => {
  it("reads ordinary single-value cells unchanged and writes no parts for small values", async () => {
    const backing = new Map<string, string>([
      [SNAPSHOT, JSON.stringify({ seq: 1, state: { text: "one" } })],
      [evt(1), JSON.stringify({ _tag: "set", text: "one" })],
      [evt(2), JSON.stringify({ _tag: "set", text: "two" })],
      [META, JSON.stringify({ lastSeq: 2 })],
    ]);
    expect(await restored(backing)).toEqual({ text: "two" });

    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage);
    expect(
      (await collect(reader.readEvents())).map((e) => [e.seq, e.event]),
    ).toEqual([
      [1, { _tag: "set", text: "one" }],
      [2, { _tag: "set", text: "two" }],
    ]);

    const { es } = await loaded(backing);
    await es.store.save({ text: "three" }, { _tag: "set", text: "three" });
    expect([...backing.keys()].filter((k) => k.startsWith(PARTS))).toEqual([]);
    expect(await restored(backing)).toEqual({ text: "three" });
  });
});
