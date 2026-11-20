import fc from "fast-check";
import type {
  FencedJournal,
  Journal,
  JournalAppend,
  JournalConflict,
  JournalRead,
} from "./index";

export type KitCase = "K1" | "K2" | "K3" | "K4" | "K5" | "K6" | "K7" | "K8";
/** Physical controls belong to the fixture, never to a journal driver. */
export interface JournalKitFixture {
  open(): Promise<Journal>;
  interruptAt(point: number | undefined): void;
  writePoints(records: readonly string[]): readonly number[];
  dispose(): Promise<void>;
  readonly byteFile: boolean;
  tearTail?(stream: string): Promise<void>;
  readStoredBytes?(stream: string): Promise<Uint8Array>;
}
export type JournalKitFactory = () => Promise<JournalKitFixture>;
export type KitResult = {
  readonly id: KitCase;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail?: string;
};
export type KitOptions = {
  readonly records: number;
  readonly now: () => number;
  readonly seed?: number;
  /** Generated histories per case; defaults to 100. */
  readonly runs?: number;
  readonly repeats?: number;
  readonly replay?: { readonly id: KitCase; readonly path: string };
};
type Batch = readonly [string, ...string[]];
type JournalModel = Map<string, readonly string[]>;
type History = readonly {
  readonly stream: string;
  readonly batches: readonly Batch[];
}[];
type KitScript = {
  readonly history: History;
  readonly stream: number;
  readonly records: Batch;
  readonly after: number;
  readonly points: readonly number[];
  readonly expected: number;
  readonly contenders: number;
};
type CaseContext = {
  readonly model: JournalModel;
  readonly script: KitScript;
  readonly fixture: JournalKitFixture;
  readonly scale: number | undefined;
  readonly sample: number;
  readonly repeat: number;
  readonly stream: string;
  append(
    stream: string,
    records: Batch,
    interrupted?: boolean,
  ): Promise<number>;
  appendFenced(
    stream: string,
    records: Batch,
    expected: number,
  ): Promise<number>;
  read(stream: string, after: number, fresh?: boolean): Promise<void>;
  reopen(): Promise<void>;
  verify(): Promise<void>;
  race(
    stream: string,
    batches: readonly Batch[],
    separate: boolean,
  ): Promise<void>;
  interrupt(point: number): void;
  tearTail(stream: string): Promise<void>;
};
type KitCheck = {
  readonly run: (context: CaseContext) => Promise<unknown>;
  readonly applies?: (journal: Journal, fixture: JournalKitFixture) => boolean;
  readonly samples?: number;
  readonly fixedRepeats?: number;
  readonly summarize?: (samples: readonly unknown[]) => unknown;
};

const modelRead = (
  model: JournalModel,
  stream: string,
  after: number,
): JournalRead => {
  const records = model.get(stream) ?? [];
  return {
    _tag: "read",
    head: records.length,
    entries: records
      .map((record, i) => ({ seq: i + 1, record }))
      .filter((entry) => entry.seq > after),
  };
};
const modelAppend = (
  model: JournalModel,
  stream: string,
  records: Batch,
): JournalAppend => {
  const head = model.get(stream)?.length ?? 0;
  return {
    _tag: "appended",
    head: head + records.length,
    entries: records.map((record, i) => ({ seq: head + i + 1, record })),
  };
};
const modelFenced = (
  model: JournalModel,
  stream: string,
  records: Batch,
  expected: number,
): JournalAppend | JournalConflict => {
  const head = model.get(stream)?.length ?? 0;
  return expected === head
    ? modelAppend(model, stream, records)
    : { _tag: "journal_conflict", expected, head };
};
const isFenced = (journal: Journal): journal is FencedJournal =>
  "fenced" in journal && journal.fenced === true;
const names = [
  "s",
  "S",
  "é",
  "e\u0301",
  "",
  "/",
  "%",
  ".",
  " ",
  "a",
  "b",
] as const;
const noncanonical = '{ "a": 1 }';
const nonJson = "opaque 半🌱\u0000\n";
const texts = [
  "",
  "🌱",
  "é",
  "e\u0301",
  "\u0000",
  "\\u0000",
  "\u0001\b\t\n\v\f\r\u001f\u007f",
  "\u2028\u2029",
  "\ufeff",
  '"',
  "\\",
  '["a","b"]\n',
  '{"seq":1,"record":"a"}\n',
  noncanonical,
  "1.0",
  "1e2",
  "-0",
  '["\\u00e9","é"]',
  '{"a":1,"a":2}',
  '{"z":1,"a":2}',
  '{"a":1}\n',
  nonJson,
  "long".repeat(1024),
] as const;
// Any well-formed Unicode text. Built from code points, because `fc.string({ unit })`
// does not exist on the oldest fast-check the `./pbt` entry supports (3.0.0).
const codePoint = fc
  .integer({ min: 0, max: 0x10ffff })
  .filter((point) => point < 0xd800 || point > 0xdfff)
  .map((point) => String.fromCodePoint(point));
const encoded = fc.oneof(
  fc.constantFrom(...texts),
  fc.array(codePoint, { maxLength: 40 }).map((points) => points.join("")),
);
const batchArbitrary = fc
  .tuple(encoded, fc.array(encoded, { maxLength: 3 }))
  .map(([first, rest]): Batch => [first, ...rest]);
const position = fc.oneof(
  fc.integer({ min: -10, max: 80 }),
  fc.integer({ min: -10, max: 80 }).map((n) => n + 0.5),
  fc.constantFrom(-Infinity, Infinity, NaN),
);
const scriptArbitrary: fc.Arbitrary<KitScript> = fc.record({
  history: fc
    .tuple(
      fc.tuple(
        ...names.map((stream) =>
          fc
            .array(batchArbitrary, { maxLength: 3 })
            .map((batches) => ({ stream, batches })),
        ),
      ),
      fc.array(
        fc.record({
          stream: fc.string({ maxLength: 20 }),
          batches: fc.array(batchArbitrary, { maxLength: 3 }),
        }),
        { maxLength: 3 },
      ),
    )
    .map(([required, extra]) => [...required, ...extra]),
  stream: fc.nat(),
  records: batchArbitrary,
  after: position,
  points: fc.array(fc.nat(), { minLength: 2, maxLength: 3 }),
  expected: position,
  contenders: fc.integer({ min: 2, max: 8 }),
});
// Rotate all three shapes across first/interior/last and singleton positions
// over the three fixed runs; each timed pair still appends identical text.
const scaleBatch = (count: number, variant: number): Batch => {
  const record = (i: number) =>
    [
      JSON.stringify({ value: i, pad: "x".repeat(80), unicode: "半🌱" }),
      noncanonical,
      nonJson,
    ][(i + variant) % 3] ?? nonJson;
  return [
    record(0),
    ...Array.from({ length: count - 1 }, (_, i) => record(i + 1)),
  ];
};

function difference(
  actual: unknown,
  expected: unknown,
  path = "answer",
): string | undefined {
  if (Object.is(actual, expected)) return;
  if (
    typeof actual !== "object" ||
    actual === null ||
    typeof expected !== "object" ||
    expected === null
  )
    return `${path}: expected ${fc.stringify(expected)}, received ${fc.stringify(actual)}`;
  const left = new Map(Object.entries(actual));
  const right = Object.entries(expected);
  if (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length !== expected.length
  )
    return `${path}.length: expected ${expected.length}, received ${actual.length}`;
  for (const [key, value] of right) {
    if (!left.has(key)) return `${path}.${key}: missing`;
    const diff = difference(left.get(key), value, `${path}.${key}`);
    if (diff) return diff;
  }
  if (left.size !== right.length)
    return `${path}: expected ${right.length} fields/items, received ${left.size}`;
}
class ScriptFailure extends Error {
  constructor(
    readonly calls: readonly string[],
    readonly firstDifference: string,
  ) {
    super(firstDifference);
  }
}

/** Every case, generated or fixed, enters through this history/action/recovery envelope. */
async function withModel(
  make: JournalKitFactory,
  script: KitScript,
  check: KitCheck,
  options: KitOptions,
  scale?: number,
  sample = 0,
  repeat = 0,
): Promise<{ readonly skipped: boolean; readonly detail?: unknown }> {
  const fixture = await make();
  const opened = new Set<Journal>();
  const calls: string[] = [];
  const model: JournalModel = new Map(
    script.history.map(({ stream }) => [stream, []]),
  );
  let bytesMustStay = false;
  const equal = (actual: unknown, expected: unknown) => {
    const diff = difference(actual, expected);
    if (diff) throw new ScriptFailure([...calls], diff);
  };
  const open = async () => {
    calls.push("open()");
    const reader = await fixture.open();
    opened.add(reader);
    return reader;
  };
  const close = async (reader: Journal) => {
    calls.push("close()");
    equal(await reader.close(), undefined);
    opened.delete(reader);
  };
  let journal: Journal;
  try {
    journal = await open();
    const read = async (stream: string, after: number, fresh = false) => {
      const reader = fresh ? await open() : journal;
      calls.push(`read(${JSON.stringify(stream)}, ${String(after)})`);
      const snapshot = fixture.readStoredBytes?.bind(fixture);
      const before =
        bytesMustStay && snapshot
          ? new Uint8Array(await snapshot(stream))
          : undefined;
      equal(await reader.read(stream, after), modelRead(model, stream, after));
      if (before && snapshot)
        equal(new Uint8Array(await snapshot(stream)), before);
      if (fresh) await close(reader);
    };
    const reopen = async () => {
      await close(journal);
      journal = await open();
    };
    const apply = async (
      stream: string,
      records: Batch,
      expected?: number,
      interrupted = false,
    ) => {
      const prior = model.get(stream) ?? [];
      const wanted =
        expected === undefined
          ? modelAppend(model, stream, records)
          : modelFenced(model, stream, records, expected);
      calls.push(
        `${expected === undefined ? "append" : "appendFenced"}(${JSON.stringify(stream)}, ${JSON.stringify(records)}${expected === undefined ? "" : `, ${String(expected)}`})`,
      );
      const start = options.now();
      const ack =
        expected === undefined
          ? await journal.append(stream, records)
          : isFenced(journal)
            ? await journal.appendFenced(stream, records, expected)
            : (() => {
                throw new Error("Expected a fenced driver");
              })();
      const elapsed = options.now() - start;
      fixture.interruptAt(undefined);
      if (ack._tag === "appended" || ack._tag === "journal_conflict") {
        equal(ack, wanted);
        if (ack._tag === "appended") model.set(stream, [...prior, ...records]);
      } else {
        if (!interrupted || ack._tag !== "journal_io") equal(ack, wanted);
        await reopen();
        calls.push(
          `read(${JSON.stringify(stream)}, 0) // settle interrupted append`,
        );
        const recovered = await journal.read(stream, 0);
        const unchanged = modelRead(model, stream, 0);
        const committed = new Map(model).set(stream, [...prior, ...records]);
        const whole = modelRead(committed, stream, 0);
        if (
          ack._tag === "journal_io" &&
          ack.uncertain &&
          !difference(recovered, whole)
        )
          model.set(stream, [...prior, ...records]);
        else equal(recovered, unchanged);
      }
      return elapsed;
    };
    const verify = async () => {
      for (const stream of model.keys()) {
        await read(stream, 0);
        await read(stream, script.after);
      }
    };
    const context: CaseContext = {
      model,
      script,
      fixture,
      scale,
      sample,
      repeat,
      stream:
        script.history[script.stream % script.history.length]?.stream ?? "s",
      append: (stream, records, interrupted) =>
        apply(stream, records, undefined, interrupted),
      appendFenced: (stream, records, expected) =>
        apply(stream, records, expected),
      read,
      reopen,
      verify,
      interrupt(point) {
        calls.push(`interruptAt(${point})`);
        fixture.interruptAt(point);
      },
      async tearTail(stream) {
        if (!fixture.readStoredBytes || !fixture.tearTail)
          throw new Error(
            "A byte-file fixture must provide tearTail and readStoredBytes",
          );
        calls.push(`tearTail(${JSON.stringify(stream)})`);
        await fixture.tearTail(stream);
        bytesMustStay = true;
      },
      async race(stream, batches, separate) {
        const expected = model.get(stream)?.length ?? 0;
        const readers = separate
          ? await Promise.all(batches.map(() => open()))
          : batches.map(() => journal);
        calls.push(
          `Promise.all(${JSON.stringify(batches)}.map(batch => ${separate ? "freshInstance" : "journal"}.appendFenced(${JSON.stringify(stream)}, batch, ${expected})))`,
        );
        const answers = await Promise.all(
          batches.map((records, i) => {
            const reader = readers[i];
            if (!reader || !isFenced(reader))
              throw new Error("Expected a fenced driver");
            return reader.appendFenced(stream, records, expected);
          }),
        );
        equal(answers.filter((ack) => ack._tag === "appended").length, 1);
        const winner = answers.findIndex((ack) => ack._tag === "appended");
        const records = batches[winner];
        if (!records) throw new Error("Missing winning batch");
        const wanted = modelAppend(model, stream, records);
        answers.forEach((ack, i) => {
          equal(
            ack,
            i === winner
              ? wanted
              : { _tag: "journal_conflict", expected, head: wanted.head },
          );
        });
        model.set(stream, [...(model.get(stream) ?? []), ...records]);
        await read(stream, 0);
        if (separate) for (const reader of readers) await close(reader);
      },
    };
    // Capability checks still enter the envelope; unavailable widenings do no I/O.
    if (check.applies && !check.applies(journal, fixture))
      return { skipped: true };
    // Mandatory values supplement generated histories without constraining their shrinking.
    await context.append("s", texts);
    await context.append("S", script.records);
    for (const { stream, batches } of script.history)
      for (const records of batches) await context.append(stream, records);
    await verify();
    const detail = await check.run(context);
    await reopen();
    await verify();
    for (const stream of model.keys()) {
      await context.append(stream, [script.records[0]]);
      await read(stream, 0);
    }
    // An append on the last stream must not damage an earlier stream either.
    await reopen();
    await verify();
    return { skipped: false, detail };
  } catch (error) {
    if (error instanceof ScriptFailure) throw error;
    throw new ScriptFailure(
      [...calls],
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    fixture.interruptAt(undefined);
    for (const reader of opened) await reader.close();
    await fixture.dispose();
  }
}

async function order(c: CaseContext) {
  const records = c.scale ? scaleBatch(c.scale, c.repeat) : c.script.records;
  for (const record of records) await c.append(c.stream, [record]);
  await c.read(c.stream, 0);
}
async function readFrom(c: CaseContext) {
  await c.append(
    c.stream,
    c.scale ? scaleBatch(c.scale, c.repeat) : c.script.records,
  );
  const head = c.model.get(c.stream)?.length ?? 0;
  for (const after of [
    -1,
    1.5,
    8,
    -Infinity,
    Infinity,
    NaN,
    0,
    1,
    7,
    head / 2,
    head - 1,
    head,
    head + 1,
    c.script.after,
  ])
    await c.read(c.stream, after);
}
async function allOrNone(c: CaseContext) {
  const records = c.scale ? scaleBatch(3, c.repeat) : c.script.records;
  const points = c.fixture.writePoints(records);
  const chosen = c.scale
    ? points
    : [
        ...new Set(
          c.script.points.map((point) => points[point % points.length]),
        ),
      ];
  for (const point of chosen) {
    if (point === undefined)
      throw new Error("Fixture exposes no interruption points");
    // Preserve acknowledged history on the target, including when generated history is empty.
    await c.append(c.stream, [c.script.records[0]]);
    c.interrupt(point);
    await c.append(c.stream, records, true);
    await c.reopen();
    await c.verify();
  }
  return { physicalCuts: chosen.length };
}
async function reopen(c: CaseContext) {
  await c.append(
    c.stream,
    c.scale ? scaleBatch(c.scale, c.repeat) : c.script.records,
  );
  await c.read(c.stream, 0);
  await c.reopen();
  await c.verify();
}
const median = (values: readonly number[]) => {
  const value = [...values].sort((a, b) => a - b)[
    Math.floor(values.length / 2)
  ];
  if (value === undefined) throw new Error("No cost samples");
  return value;
};
async function flatCost(c: CaseContext) {
  if (!c.scale) {
    await c.append(c.stream, c.script.records);
    return;
  }
  const encoded = scaleBatch(1, c.repeat);
  for (const n of [10, 10000] as const)
    await c.append(`n${n}`, scaleBatch(n - 1, c.repeat));
  for (let warm = 0; warm < 10; warm++) await c.append("warm", encoded);
  const times: Record<10 | 10000, number> = { 10: 0, 10000: 0 };
  const order: readonly (10 | 10000)[] =
    c.sample % 2 ? [10000, 10] : [10, 10000];
  for (const n of order) {
    await c.read(`n${n}`, n - 1);
    times[n] = await c.append(`n${n}`, encoded);
    await c.read(`n${n}`, n - 1);
  }
  return { at10: times[10], at10000: times[10000] };
}
/**
 * How much more one append may cost at 10,000 records than at 10. A driver that
 * rewrites or re-reads its whole log pays about 1,000x (10,000 / 10); an indexed
 * table or a B-tree pays its depth, a few x (SQLite measured 3.5x on CI). 30x sits
 * between the two with room on both sides, so K5 catches a linear append and not
 * a logarithmic one, nor sub-millisecond timer noise.
 */
const K5_MAX_GROWTH = 30;
function appendCosts(samples: readonly unknown[]) {
  const measured = samples.slice(5).map((value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("at10" in value) ||
      !("at10000" in value) ||
      typeof value.at10 !== "number" ||
      typeof value.at10000 !== "number"
    )
      throw new Error("Missing paired append measurement");
    return { at10: value.at10, at10000: value.at10000 };
  });
  const at10 = median(measured.map((pair) => pair.at10));
  const at10000 = median(measured.map((pair) => pair.at10000));
  if (at10000 > K5_MAX_GROWTH * at10)
    throw new Error(`K5: ${at10000} > ${K5_MAX_GROWTH} * ${at10} ms`);
  return { at10, at10000, ratio: at10000 / at10 };
}
async function streams(c: CaseContext) {
  await c.append(c.stream, c.script.records);
  await c.verify();
}
async function fenced(c: CaseContext) {
  const head = c.model.get(c.stream)?.length ?? 0;
  for (const expected of [head - 1, head + 1, c.script.expected, head])
    await c.appendFenced(c.stream, c.script.records, expected);
  const contenders = Array.from(
    { length: c.script.contenders },
    (_, i): Batch => [
      JSON.stringify({ contender: i, record: c.script.records[0] }),
      ...c.script.records.slice(1),
    ],
  );
  await c.race(c.stream, contenders, false);
  await c.race(c.stream, contenders, true);
}
async function tornTail(c: CaseContext) {
  await c.append(c.stream, c.script.records);
  await c.tearTail(c.stream);
  await c.read(c.stream, c.script.after);
  await c.read(c.stream, 0);
  await c.read(c.stream, 0, true);
  await c.append(c.stream, [c.script.records[0]]);
}
const cases = {
  K1: { run: order },
  K2: { run: readFrom },
  K3: { run: allOrNone, fixedRepeats: 1 },
  K4: { run: reopen },
  K5: { run: flatCost, samples: 21, summarize: appendCosts },
  K6: { run: streams },
  K7: { run: fenced, applies: isFenced },
  K8: { run: tornTail, applies: (_, fixture) => fixture.byteFile },
} satisfies Record<KitCase, KitCheck>;

export async function journalConformance(
  make: JournalKitFactory,
  options: KitOptions,
): Promise<readonly KitResult[]> {
  const results: KitResult[] = [];
  const seed = options.seed ?? 9542026;
  for (const id of Object.keys(cases) as KitCase[]) {
    const check: KitCheck = cases[id];
    const started = options.now();
    let skipped = false;
    const property = await fc.check(
      fc.asyncProperty(scriptArbitrary, async (script) => {
        skipped = (await withModel(make, script, check, options)).skipped;
      }),
      {
        seed,
        numRuns: options.runs ?? 100,
        ...(options.replay?.id === id ? { path: options.replay.path } : {}),
      },
    );
    const generatedMs = options.now() - started;
    if (property.failed) {
      const error = property.errorInstance;
      results.push({
        id,
        status: "failed",
        detail: JSON.stringify({
          elapsedMs: options.now() - started,
          generatedMs,
          seed: property.seed,
          path: property.counterexamplePath,
          script:
            error instanceof ScriptFailure
              ? error.calls
              : property.counterexample,
          firstDifference:
            error instanceof ScriptFailure
              ? error.firstDifference
              : String(error),
        }),
      });
      continue;
    }
    const fixed: unknown[] = [];
    const fixedRepeats = check.fixedRepeats ?? options.repeats ?? 3;
    try {
      for (let repeat = 0; repeat < fixedRepeats; repeat++) {
        const script = fc.sample(scriptArbitrary, {
          seed: seed + repeat,
          numRuns: 1,
        })[0];
        if (!script) throw new Error("Missing fixed scale script");
        const samples: unknown[] = [];
        for (let sample = 0; sample < (check.samples ?? 1); sample++) {
          const result = await withModel(
            make,
            { ...script, stream: 0 },
            check,
            options,
            options.records,
            sample,
            repeat,
          );
          skipped = result.skipped;
          if (result.detail !== undefined) samples.push(result.detail);
        }
        if (samples.length)
          fixed.push(check.summarize ? check.summarize(samples) : samples[0]);
      }
      results.push({
        id,
        status: skipped ? "skipped" : "passed",
        detail: JSON.stringify({
          seed,
          elapsedMs: options.now() - started,
          generatedMs,
          fixedMs: options.now() - started - generatedMs,
          generatedRuns: property.numRuns,
          fixedRuns: fixedRepeats,
          records: options.records,
          fixed,
        }),
      });
    } catch (error) {
      results.push({
        id,
        status: "failed",
        detail: JSON.stringify({
          seed,
          elapsedMs: options.now() - started,
          generatedMs,
          fixed: true,
          script: error instanceof ScriptFailure ? error.calls : [],
          firstDifference:
            error instanceof ScriptFailure
              ? error.firstDifference
              : String(error),
        }),
      });
    }
  }
  return results;
}
