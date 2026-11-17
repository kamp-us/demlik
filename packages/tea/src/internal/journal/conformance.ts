import { describe, expect, it } from "vitest";
import type {
  FencedJournal,
  Journal,
  JournalAppend,
  JournalRead,
  JournalRefusal,
} from "./index";

export type KitCase = "K1" | "K2" | "K3" | "K4" | "K5" | "K6" | "K7" | "K8";
/** Test controls belong to the fixture, never to Journal. cut is a physical write ordinal or byte offset. */
export interface JournalKitFixture {
  open(): Promise<Journal>;
  interruptAt(point: number | undefined): void;
  writePoints(records: readonly string[]): readonly number[];
  dispose(): Promise<void>;
  readonly byteFile: boolean;
  tearTail?(): Promise<void>;
}
export type JournalKitFactory = () => Promise<JournalKitFixture>;
export type KitResult = {
  readonly id: KitCase;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail?: string;
};
type KitOptions = { readonly records: number; readonly now: () => number };
type KitContext = KitOptions & {
  readonly fixture: JournalKitFixture;
  readonly open: JournalKitFixture["open"];
  readonly make: JournalKitFactory;
};
type KitCheck = (context: KitContext) => Promise<KitResult>;

const record = (i: number) =>
  JSON.stringify({ value: i, pad: "x".repeat(80), unicode: "半🌱" });
const batch = (n: number, start = 1): [string, ...string[]] => {
  if (n < 1) throw new Error("The kit requires at least one record");
  return [
    record(start),
    ...Array.from({ length: n - 1 }, (_, i) => record(start + i + 1)),
  ];
};
const entries = (n: number, after = 0) =>
  Array.from({ length: Math.max(0, n - after) }, (_, i) => ({
    seq: after + i + 1,
    record: record(after + i + 1),
  }));
const passed = (id: KitCase, detail?: string): KitResult => ({
  id,
  status: "passed",
  ...(detail === undefined ? {} : { detail }),
});
const appended = (result: JournalAppend | JournalRefusal): JournalAppend => {
  if (result._tag !== "appended") throw new Error(JSON.stringify(result));
  return result;
};
const read = (result: JournalRead | JournalRefusal): JournalRead => {
  if (result._tag !== "read") throw new Error(JSON.stringify(result));
  return result;
};
const close = async (journal: Journal) => {
  const result = await journal.close();
  if (result) throw new Error(JSON.stringify(result));
};
const median = (samples: readonly number[]) => {
  const value = [...samples].sort((a, b) => a - b)[
    Math.floor(samples.length / 2)
  ];
  if (value === undefined) throw new Error("No cost samples");
  return value;
};

async function order({ open, records }: KitContext): Promise<KitResult> {
  const journal = await open();
  for (let i = 1; i <= records; i++) {
    expect(appended(await journal.append("s", [record(i)]))).toEqual({
      _tag: "appended",
      head: i,
      entries: [{ seq: i, record: record(i) }],
    });
  }
  expect(read(await journal.read("s", 0))).toEqual({
    _tag: "read",
    head: records,
    entries: entries(records),
  });
  await close(journal);
  return passed("K1");
}
async function readFrom({ open, records }: KitContext): Promise<KitResult> {
  const journal = await open();
  expect(read(await journal.read("s", 0))).toEqual({
    _tag: "read",
    head: 0,
    entries: [],
  });
  appended(await journal.append("s", batch(records)));
  for (const after of [
    0,
    1,
    7,
    Math.floor(records / 2),
    records - 1,
    records,
    records + 1,
  ]) {
    expect(read(await journal.read("s", after))).toEqual({
      _tag: "read",
      head: records,
      entries: entries(records, after),
    });
  }
  await close(journal);
  return passed("K2");
}
async function allOrNone({ make }: KitContext): Promise<KitResult> {
  const records = batch(3);
  const shape = await make();
  const points = shape.writePoints(records);
  for (const point of points) {
    const fixture = await make();
    let journal = await fixture.open();
    appended(await journal.append("prefix", [record(0)]));
    fixture.interruptAt(point);
    const ack = await journal.append("s", records);
    expect(["appended", "journal_io"]).toContain(ack._tag);
    await close(journal);
    fixture.interruptAt(undefined);
    journal = await fixture.open();
    const rows = read(await journal.read("s", 0));
    expect([0, 3], `cut ${point}: saw ${rows.entries.length}/3`).toContain(
      rows.entries.length,
    );
    expect(rows.entries).toEqual(entries(rows.entries.length));
    expect(rows.head).toBe(rows.entries.length);
    expect(read(await journal.read("prefix", 0)).entries).toEqual([
      { seq: 1, record: record(0) },
    ]);
    const next = appended(await journal.append("s", [record(4)]));
    expect(next).toEqual({
      _tag: "appended",
      head: rows.head + 1,
      entries: [{ seq: rows.head + 1, record: record(4) }],
    });
    await close(journal);
    await fixture.dispose();
  }
  return passed("K3", JSON.stringify({ physicalCuts: points.length }));
}
async function reopen({ open, records }: KitContext): Promise<KitResult> {
  let journal = await open();
  appended(await journal.append("s", batch(records)));
  const before = read(await journal.read("s", 0));
  expect(before).toEqual({
    _tag: "read",
    head: records,
    entries: entries(records),
  });
  await close(journal);
  journal = await open();
  expect(await journal.read("s", 0)).toEqual(before);
  await close(journal);
  return passed("K4");
}
async function flatCost({ make, now }: KitContext): Promise<KitResult> {
  const samples: Record<10 | 10000, number[]> = { 10: [], 10000: [] };
  for (let sample = 0; sample < 21; sample++) {
    const fixture = await make();
    const journal = await fixture.open();
    const encoded = [record(10000)] as const;
    // Pair exact heads in one instance, then alternate measurement order.
    for (const n of [10, 10000])
      appended(await journal.append(`n${n}`, batch(n - 1, 0)));
    for (let warm = 0; warm < 10; warm++)
      appended(await journal.append("warm", encoded));
    const order: readonly (10 | 10000)[] =
      sample % 2 ? [10000, 10] : [10, 10000];
    for (const n of order) {
      read(await journal.read(`n${n}`, n - 1));
      const start = now();
      const ack = await journal.append(`n${n}`, encoded);
      const elapsed = now() - start;
      appended(ack);
      if (sample >= 5) samples[n].push(elapsed);
    }
    await close(journal);
    await fixture.dispose();
  }
  const at10 = median(samples[10]);
  const at10000 = median(samples[10000]);
  expect(at10000, `${at10000} > 3 * ${at10}`).toBeLessThanOrEqual(3 * at10);
  return passed("K5", JSON.stringify({ at10, at10000, ratio: at10000 / at10 }));
}
async function streams({ open }: KitContext): Promise<KitResult> {
  const journal = await open();
  appended(await journal.append("b", [record(1)]));
  const before = await journal.read("b", 0);
  appended(await journal.append("a", batch(3, 2)));
  expect(await journal.read("b", 0)).toEqual(before);
  await close(journal);
  return passed("K6");
}
function isFenced(journal: Journal): journal is FencedJournal {
  return "fenced" in journal && journal.fenced === true;
}
async function fenced({ open }: KitContext): Promise<KitResult> {
  const journal = await open();
  if (!isFenced(journal)) {
    await close(journal);
    return { id: "K7", status: "skipped" };
  }
  appended(await journal.append("s", [record(1)]));
  for (const expected of [0, 2]) {
    expect(
      await journal.appendFenced("s", [record(2), record(3)], expected),
    ).toEqual({
      _tag: "journal_conflict",
      expected,
      head: 1,
    });
    expect(read(await journal.read("s", 0))).toEqual({
      _tag: "read",
      head: 1,
      entries: entries(1),
    });
  }
  const ack = await journal.appendFenced("s", [record(2)], 1);
  expect(ack).toEqual({
    _tag: "appended",
    head: 2,
    entries: [{ seq: 2, record: record(2) }],
  });
  await close(journal);
  return passed("K7");
}
async function tornTail({ open, fixture }: KitContext): Promise<KitResult> {
  if (!fixture.byteFile) return { id: "K8", status: "skipped" };
  if (!fixture.tearTail)
    throw new Error("A byte-file fixture must provide tearTail");
  let journal = await open();
  appended(await journal.append("s", batch(2)));
  await close(journal);
  await fixture.tearTail();
  journal = await open();
  for (let repeat = 0; repeat < 2; repeat++) {
    expect(read(await journal.read("s", 0))).toEqual({
      _tag: "read",
      head: 2,
      entries: entries(2),
    });
  }
  expect(appended(await journal.append("s", [record(3)]))).toEqual({
    _tag: "appended",
    head: 3,
    entries: [{ seq: 3, record: record(3) }],
  });
  await close(journal);
  journal = await open();
  expect(read(await journal.read("s", 0))).toEqual({
    _tag: "read",
    head: 3,
    entries: entries(3),
  });
  await close(journal);
  return passed("K8");
}

const cases = {
  K1: order,
  K2: readFrom,
  K3: allOrNone,
  K4: reopen,
  K5: flatCost,
  K6: streams,
  K7: fenced,
  K8: tornTail,
} satisfies Record<KitCase, KitCheck>;

export async function journalConformance(
  make: JournalKitFactory,
  options: KitOptions,
): Promise<readonly KitResult[]> {
  const results: KitResult[] = [];
  for (const id of Object.keys(cases) as KitCase[]) {
    const fixtures = new Set<JournalKitFixture>();
    const tracked: JournalKitFactory = async () => {
      const fixture = await make();
      const wrapper: JournalKitFixture = {
        ...fixture,
        async dispose() {
          if (!fixtures.delete(wrapper)) return;
          await fixture.dispose();
        },
      };
      fixtures.add(wrapper);
      return wrapper;
    };
    try {
      const fixture = await tracked();
      results.push(
        await cases[id]({
          ...options,
          fixture,
          open: () => fixture.open(),
          make: tracked,
        }),
      );
    } catch (error) {
      results.push({
        id,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      for (const fixture of fixtures) await fixture.dispose();
    }
  }
  return results;
}

export function describeJournalConformance(
  label: string,
  make: JournalKitFactory,
  options: KitOptions,
): void {
  describe(`Journal conformance: ${label}`, () => {
    it("passes every applicable K1–K8 case", async () => {
      const results = await journalConformance(make, options);
      console.info(JSON.stringify({ driver: label, results }));
      expect(results.filter((result) => result.status === "failed")).toEqual(
        [],
      );
    }, 120_000);
  });
}
