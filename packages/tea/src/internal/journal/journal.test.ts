import { describe, expect, it, vi } from "vitest";
import {
  type JournalKitFactory,
  journalConformance,
  type KitCase,
} from "./conformance";
import { describeJournalConformance } from "./describe-conformance";
import { type FencedJournal, type Journal, memoryJournal } from "./index";

const memoryFixture: JournalKitFactory = async () => {
  const journal = memoryJournal({ fenced: true });
  let cut: number | undefined;
  return {
    byteFile: false,
    interruptAt(point) {
      cut = point;
    },
    writePoints: (records) =>
      Array.from({ length: records.length + 2 }, (_, i) => i),
    async open() {
      return {
        ...journal,
        async append(stream, records) {
          if (cut === undefined) return journal.append(stream, records);
          const input = new Proxy(records, {
            get(target, key, receiver) {
              if (cut !== undefined && key === String(cut))
                throw new Error("interrupted allocation");
              return Reflect.get(target, key, receiver);
            },
          });
          const nativeSet = Map.prototype.set;
          const spy = vi
            .spyOn(Map.prototype, "set")
            .mockImplementation(function (
              this: Map<unknown, unknown>,
              key: unknown,
              value: unknown,
            ) {
              if (key === stream && cut === records.length)
                throw new Error("interrupted before commit");
              const result = nativeSet.call(this, key, value);
              if (key === stream && cut === records.length + 1)
                throw new Error("interrupted after commit");
              return result;
            });
          try {
            return await journal.append(stream, input);
          } finally {
            spy.mockRestore();
          }
        },
      };
    },
    async dispose() {},
  };
};

describeJournalConformance("memory", memoryFixture, {
  records: 10000,
  now: () => performance.now(),
});

/** Every unconditional mutation must fail its named case; failures from other cases are also reported. */
const broken = {
  normalizesJson: "K1",
  normalizesUnicode: "K1",
  trimsRecords: "K1",
  dropsBatchTail: "K3",
  clearsStreamOnInterrupt: "K3",
  checksThenWrites: "K7",
  foldsStreamCase: "K6",
  acknowledgesUnstored: "K3",
  rewritesWholeLog: "K5",
  acknowledgesMeasuredUnstored: "K5",
  losesOnReopen: "K4",
  misreportsBatchAcknowledgement: "K4",
  reordersRead: "K1",
  ignoresAfter: "K2",
  slicesFromEnd: "K2",
  crossesStreams: "K6",
  dropsIsolatedStream: "K6",
  acceptsStaleExpected: "K7",
  acknowledgesFencedUnstored: "K7",
  returnsTornTail: "K8",
  truncatesOnRead: "K8",
} satisfies Record<string, KitCase>;
type Broken = keyof typeof broken;
type MutationContext = {
  readonly journal: FencedJournal;
  readonly cut: () => number | undefined;
  readonly torn: () => boolean;
  readonly truncateTail: () => void;
  readonly opens: () => number;
  readonly cleared: Map<string, FencedJournal>;
  readonly batches: Map<string, number>;
  readonly clock: { ticks: number };
};
type Mutation = (context: MutationContext) => FencedJournal;

function transformRecords(
  journal: FencedJournal,
  transform: (record: string) => string,
): FencedJournal {
  const batch = ([first, ...rest]: Parameters<
    Journal["append"]
  >[1]): Parameters<Journal["append"]>[1] => [
    transform(first),
    ...rest.map(transform),
  ];
  return {
    ...journal,
    append: (stream, records) => journal.append(stream, batch(records)),
    appendFenced: (stream, records, expected) =>
      journal.appendFenced(stream, batch(records), expected),
  };
}

async function acknowledgeUnstored(
  journal: Journal,
  stream: string,
  records: Parameters<Journal["append"]>[1],
): ReturnType<Journal["append"]> {
  const prior = await journal.read(stream, 0);
  if (prior._tag !== "read") return prior;
  return {
    _tag: "appended",
    head: prior.head + records.length,
    entries: records.map((record, i) => ({ seq: prior.head + i + 1, record })),
  };
}

const mutations = {
  normalizesJson: ({ journal }) =>
    transformRecords(journal, (record) => {
      try {
        const value: unknown = JSON.parse(record);
        return JSON.stringify(value) ?? record;
      } catch {
        return record;
      }
    }),
  normalizesUnicode: ({ journal }) =>
    transformRecords(journal, (record) => record.normalize("NFC")),
  trimsRecords: ({ journal }) =>
    transformRecords(journal, (record) => record.trim()),
  clearsStreamOnInterrupt: ({ journal, cut, cleared }) => ({
    ...journal,
    async append(stream, records) {
      if (cut() === undefined)
        return (cleared.get(stream) ?? journal).append(stream, records);
      cleared.set(stream, memoryJournal({ fenced: true }));
      return {
        _tag: "journal_io",
        operation: "append",
        uncertain: true,
        message: "cleared on interrupt",
      };
    },
    read: (stream, after) =>
      (cleared.get(stream) ?? journal).read(stream, after),
    appendFenced: (stream, records, expected) =>
      (cleared.get(stream) ?? journal).appendFenced(stream, records, expected),
  }),
  checksThenWrites: ({ journal }) => ({
    ...journal,
    async appendFenced(stream, records, expected) {
      const before = await journal.read(stream, 0);
      if (before._tag !== "read") return before;
      return before.head === expected
        ? journal.append(stream, records)
        : { _tag: "journal_conflict", expected, head: before.head };
    },
  }),
  foldsStreamCase: ({ journal }) => ({
    ...journal,
    read: (stream, after) => journal.read(stream.toLowerCase(), after),
    append: (stream, records) => journal.append(stream.toLowerCase(), records),
    appendFenced: (stream, records, expected) =>
      journal.appendFenced(stream.toLowerCase(), records, expected),
  }),
  dropsBatchTail: ({ journal, cut }) => ({
    ...journal,
    async append(stream, records) {
      const point = cut();
      if (point === undefined) return journal.append(stream, records);
      for (let i = 0; i < records.length; i++) {
        if (i === point) break;
        const record = records[i];
        if (record !== undefined) await journal.append(stream, [record]);
      }
      return {
        _tag: "journal_io",
        operation: "append",
        message: "partial batch",
        uncertain: true,
      };
    },
  }),
  acknowledgesUnstored: ({ journal, cut }) => ({
    ...journal,
    async append(stream, records) {
      if (cut() === undefined) return journal.append(stream, records);
      return acknowledgeUnstored(journal, stream, records);
    },
  }),
  rewritesWholeLog: ({ journal, clock }) => ({
    ...journal,
    async append(stream, records) {
      const prior = await journal.read(stream, 0);
      if (prior._tag === "read") clock.ticks += prior.entries.length;
      return journal.append(stream, records);
    },
  }),
  acknowledgesMeasuredUnstored: ({ journal }) => ({
    ...journal,
    append: (stream, records) =>
      stream.startsWith("n") && records.length === 1
        ? acknowledgeUnstored(journal, stream, records)
        : journal.append(stream, records),
  }),
  losesOnReopen: ({ journal, opens }) => ({
    ...journal,
    async read(stream, after) {
      const result = await journal.read(stream, after);
      return result._tag === "read" && opens() > 1 && result.head > 32
        ? { _tag: "read", head: 0, entries: [] }
        : result;
    },
  }),
  misreportsBatchAcknowledgement: ({ journal }) => ({
    ...journal,
    async append(stream, records) {
      const ack = await journal.append(stream, records);
      return ack._tag === "appended" && stream === "s" && records.length > 3
        ? { ...ack, head: ack.head + 1 }
        : ack;
    },
  }),
  reordersRead: ({ journal, batches }) => ({
    ...journal,
    async read(stream, after) {
      const result = await journal.read(stream, after);
      return result._tag === "read" &&
        after === 0 &&
        (batches.get(stream) ?? 0) > 2
        ? { ...result, entries: [...result.entries].reverse() }
        : result;
    },
  }),
  ignoresAfter: ({ journal }) => ({
    ...journal,
    read: (stream) => journal.read(stream, 0),
  }),
  slicesFromEnd: ({ journal }) => ({
    ...journal,
    async read(stream, after) {
      const result = await journal.read(stream, 0);
      return result._tag === "read"
        ? { ...result, entries: result.entries.slice(after) }
        : result;
    },
  }),
  crossesStreams: ({ journal }) => ({
    ...journal,
    append: (stream, records) =>
      journal.append(stream === "a" ? "b" : stream, records),
  }),
  dropsIsolatedStream: ({ journal }) => ({
    ...journal,
    append: (stream, records) =>
      stream === "a"
        ? acknowledgeUnstored(journal, stream, records)
        : journal.append(stream, records),
  }),
  acceptsStaleExpected: ({ journal }) => ({
    ...journal,
    appendFenced: (stream, records) => journal.append(stream, records),
  }),
  acknowledgesFencedUnstored: ({ journal }) => ({
    ...journal,
    async appendFenced(stream, records, expected) {
      const prior = await journal.read(stream, 0);
      return prior._tag === "read" && expected === prior.head
        ? acknowledgeUnstored(journal, stream, records)
        : journal.appendFenced(stream, records, expected);
    },
  }),
  truncatesOnRead: ({ journal, torn, truncateTail }) => ({
    ...journal,
    async read(stream, after) {
      if (torn()) truncateTail();
      return journal.read(stream, after);
    },
  }),
  returnsTornTail: ({ journal, torn }) => ({
    ...journal,
    async read(stream, after) {
      const result = await journal.read(stream, after);
      return result._tag === "read" && torn()
        ? {
            ...result,
            head: result.head + 1,
            entries: [
              ...result.entries,
              { seq: result.head + 1, record: '["半' },
            ],
          }
        : result;
    },
  }),
} satisfies Record<Broken, Mutation>;

async function brokenFixture(name: Broken, clock: { ticks: number }) {
  // A logical byte-file fixture lets the portable kit isolate its K8 detector;
  // physical UTF-8 cuts against the real file driver live in node/journal.test.ts.
  const fixture = await memoryFixture();
  let cut: number | undefined;
  let torn = false;
  // Portable byte-image test double; the Node fixtures expose actual disk bytes.
  let storedBytes = Uint8Array.of(1, 2);

  let opens = 0;
  const cleared = new Map<string, FencedJournal>();
  const batches = new Map<string, number>();
  return {
    ...fixture,
    byteFile: broken[name] === "K8",
    interruptAt(point: number | undefined) {
      cut = point;
      if (name !== "dropsBatchTail") fixture.interruptAt(point);
    },
    async tearTail() {
      torn = true;
      storedBytes = Uint8Array.of(1, 2, 0xe5, 0x8d);
    },
    async readStoredBytes() {
      return storedBytes.slice();
    },
    async open(): Promise<Journal> {
      opens++;
      const base = await fixture.open();
      if (
        !("fenced" in base) ||
        base.fenced !== true ||
        !("appendFenced" in base)
      )
        throw new Error("Expected a fenced memory fixture");
      const journal = base as FencedJournal;
      const mutant = mutations[name]({
        journal,
        cleared,
        cut: () => cut,
        torn: () => torn,
        truncateTail: () => {
          storedBytes = storedBytes.slice(0, 2);
        },
        opens: () => opens,
        batches,
        clock,
      });
      return {
        ...mutant,
        async append(stream, records) {
          clock.ticks += 1;
          const ack = await mutant.append(stream, records);
          batches.set(stream, (batches.get(stream) ?? 0) + 1);
          return ack;
        },
      };
    },
  };
}

describe(
  "every broken driver is caught by its named case",
  { timeout: 120_000 },
  () => {
    it.each(
      Object.entries(broken) as [Broken, KitCase][],
    )("%s is detected by %s", async (name, expected) => {
      const clock = { ticks: 0 };
      const results = await journalConformance(
        () => brokenFixture(name, clock),
        {
          records: 64,
          now: () => clock.ticks,
          repeats: 1,
        },
      );
      const failed = results
        .filter((result) => result.status === "failed")
        .map((result) => result.id);
      console.info(JSON.stringify({ broken: name, expected, failed }));
      expect(failed).toContain(expected);
    });
  },
);

it("refuses a racing expected head on shared memory storage", async () => {
  const journal = memoryJournal({ fenced: true });
  const acks = await Promise.all([
    journal.appendFenced("s", ['"a"'], 0),
    journal.appendFenced("s", ['"b"'], 0),
  ]);
  expect(acks.map((ack) => ack._tag)).toEqual(["appended", "journal_conflict"]);
  const stored = await journal.read("s", 0);
  expect(stored).toEqual({
    _tag: "read",
    head: 1,
    entries: [{ seq: 1, record: '"a"' }],
  });
});
