import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineMachine,
  isFencedStore,
  NoCellError,
  type Refusal,
  type RuntimeErrorPhase,
  refuse,
  StoreConflictError,
  StoreRefusedError,
  type Transitions,
} from "../../../index";
import { type RowPort, rowStore } from "../../../persistence";
import { run } from "../../../promise";
import { type Database, database } from "./row-store.fixture";

type Job =
  | { readonly _tag: "queued" }
  | { readonly _tag: "running"; readonly by: string }
  | { readonly _tag: "cancelling"; readonly by: string }
  | { readonly _tag: "done" };
type JobMsg =
  | { readonly _tag: "claim"; readonly by: string }
  | { readonly _tag: "cancel" }
  | { readonly _tag: "finish" };
type JobCmd = {
  readonly _tag: "notify";
  readonly to: string;
  readonly about: Job["_tag"];
};

const update: Transitions<Job, JobMsg, JobCmd> = {
  queued: {
    claim: (_s, m) => [
      { _tag: "running", by: m.by },
      [{ _tag: "notify", to: m.by, about: "running" }],
    ],
  },
  running: {
    cancel: (s) => [
      { _tag: "cancelling", by: s.by },
      [{ _tag: "notify", to: s.by, about: "cancelling" }],
    ],
    finish: (s) => [
      { _tag: "done" },
      [{ _tag: "notify", to: s.by, about: "done" }],
    ],
  },
  cancelling: {
    finish: (s) => [
      { _tag: "done" },
      [{ _tag: "notify", to: s.by, about: "done" }],
    ],
  },
  done: {},
};

const job = defineMachine({
  types: { model: {} as Job, msg: {} as JobMsg, cmd: {} as JobCmd },
  init: (loaded) => [loaded ?? { _tag: "queued" }, []],
  update,
});

const jobRow = z.union([
  z.object({ status: z.enum(["queued", "done"]), claimed_by: z.null() }),
  z.object({
    status: z.enum(["running", "cancelling"]),
    claimed_by: z.string(),
  }),
]);
const encode = (s: Job) => ({
  status: s._tag,
  claimed_by: "by" in s ? s.by : null,
});
const parse = (row: unknown): Job | Refusal => {
  const parsed = jobRow.safeParse(row);
  if (!parsed.success) {
    return refuse(`unreadable job row: ${parsed.error.message}`);
  }
  const { data } = parsed;
  return data.claimed_by === null
    ? { _tag: data.status }
    : { _tag: data.status, by: data.claimed_by };
};

const storeOf = (port: RowPort) =>
  rowStore(port, { parse, encode, fenced: true });
const seedJob = (db: Database, id: string, state: Job, revision = 1) =>
  db.seed(id, encode(state), revision);

interface Report {
  readonly error: unknown;
  readonly phase: RuntimeErrorPhase;
}
interface Outcome {
  /** What boot and the dispatch rejected with, in that order. */
  readonly rejected: unknown[];
  /** What `onError` was told, with the phase it was told under. */
  readonly reported: Report[];
}
const errorsOf = ({ rejected, reported }: Outcome): unknown[] => [
  ...rejected,
  ...reported.map(({ error }) => error),
];

/** One request: one `run`, one Msg, one `stop`. Every error it met, boot included, comes back as a value. */
async function request(
  port: RowPort,
  msg: JobMsg,
  sent: JobCmd[],
): Promise<Outcome> {
  const rejected: unknown[] = [];
  const reported: Report[] = [];
  const booting = run(job, {
    store: storeOf(port),
    boot: "restored",
    interpret: {
      notify: async (cmd) => {
        sent.push(cmd);
      },
    },
    onError: (error, { phase }) => reported.push({ error, phase }),
  });
  const rt = await booting.ready.catch((error: unknown) => {
    rejected.push(error);
    return undefined;
  });
  if (rt !== undefined) {
    await rt.dispatch(msg).catch((error: unknown) => rejected.push(error));
    await rt.idle();
  }
  await booting.stop();
  return { rejected, reported };
}

/** A deterministic, seeded number of microtask yields (0 to 3) before each port call. */
function shuffledYields(seed: number): () => Promise<void> {
  let x = seed >>> 0;
  return async () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    for (let i = (x >>> 24) % 4; i > 0; i -= 1) await Promise.resolve();
  };
}

/** Every read answers only after `count` reads were made, so all requesters see the same revision. */
function readsMeet(count: number): () => Promise<void> {
  let seen = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    seen += 1;
    if (seen === count) open();
    await opened;
  };
}
const held = (port: RowPort, meet: () => Promise<void>): RowPort => ({
  ...port,
  read: async () => {
    const read = await port.read();
    await meet();
    return read;
  },
});

/** The first read answers `stale`; every later read, such as a diagnostic one, asks the real port. */
const staleFirstRead = (
  port: RowPort,
  stale: { readonly row: unknown; readonly revision: number },
): RowPort => {
  let served = false;
  return {
    ...port,
    read: async () => {
      if (served) return port.read();
      served = true;
      return stale;
    },
  };
};

describe(
  "the user's job: many requests move many rows, and each row moves once",
  { timeout: 120_000 },
  () => {
    it("20 jobs, 50 claimers each, 25 seeded interleavings: one owner and one notice per job", async () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        const db = database(shuffledYields(seed));
        const sent: JobCmd[] = [];
        const ids = Array.from({ length: 20 }, (_, i) => `job-${i}`);
        for (const id of ids) seedJob(db, id, { _tag: "queued" });
        await Promise.all(
          ids.flatMap((id) =>
            Array.from({ length: 50 }, (_, w) =>
              request(db.port(id), { _tag: "claim", by: `${id}/w${w}` }, sent),
            ),
          ),
        );
        for (const id of ids) {
          const cell = db.live.get(id);
          expect(cell?.row.status).toBe("running");
          expect(String(cell?.row.claimed_by).startsWith(`${id}/`)).toBe(true);
          expect(cell?.revision).toBe(2);
          expect(sent.filter((c) => c.to.startsWith(`${id}/`))).toEqual([
            { _tag: "notify", to: cell?.row.claimed_by, about: "running" },
          ]);
        }
      }
    });

    it("a job walks its whole life across separate requests, and the state in between has a name", async () => {
      const db = database();
      const sent: JobCmd[] = [];
      seedJob(db, "j1", { _tag: "queued" });
      await request(db.port("j1"), { _tag: "claim", by: "w1" }, sent);
      await request(db.port("j1"), { _tag: "cancel" }, sent);
      expect(db.live.get("j1")?.row).toEqual({
        status: "cancelling",
        claimed_by: "w1",
      });
      await request(db.port("j1"), { _tag: "finish" }, sent);
      expect(db.live.get("j1")).toEqual({
        row: { status: "done", claimed_by: null },
        revision: 4,
      });
      expect(sent.map((c) => c.about)).toEqual([
        "running",
        "cancelling",
        "done",
      ]);
    });
  },
);

describe("rowStore: passes", () => {
  it("a row that was never saved reads as nothing at version 0", async () => {
    expect(await storeOf(database().port("j1")).loadFenced()).toEqual({
      raw: null,
      version: 0,
    });
  });

  it("asks for the fence by name and gets a fenced store", () => {
    expect(isFencedStore(storeOf(database().port("j1")))).toBe(true);
  });

  it("the first save inserts revision 1, and the state lands in the row's own columns", async () => {
    const db = database();
    expect(
      await storeOf(db.port("j1")).saveFenced({ _tag: "running", by: "w1" }, 0),
    ).toBe(1);
    expect(db.live.get("j1")).toEqual({
      row: { status: "running", claimed_by: "w1" },
      revision: 1,
    });
  });

  it("a save at the current revision advances it by exactly one", async () => {
    const db = database();
    const store = storeOf(db.port("j1"));
    await store.saveFenced({ _tag: "queued" }, 0);
    expect(await store.saveFenced({ _tag: "running", by: "w1" }, 1)).toBe(2);
  });

  it("a version-blind save writes the revision after the one it just read", async () => {
    const db = database();
    const store = storeOf(db.port("j1"));
    await store.save({ _tag: "queued" });
    await store.save({ _tag: "running", by: "w1" });
    expect(db.live.get("j1")).toEqual({
      row: { status: "running", claimed_by: "w1" },
      revision: 2,
    });
  });

  it("load answers the row's raw columns, not the fenced wrapper, and null once the row is gone", async () => {
    const db = database();
    const store = storeOf(db.port("j1"));
    expect(await store.load()).toBeNull();
    await store.saveFenced({ _tag: "running", by: "w1" }, 0);
    expect(await store.load()).toEqual({ status: "running", claimed_by: "w1" });
    await store.delete();
    expect(await store.load()).toBeNull();
  });

  it("migrate answers null for null without asking parse, and forwards any other raw value untouched", () => {
    const parser = vi.fn((_row: unknown): Job | Refusal => ({
      _tag: "queued",
    }));
    const store = rowStore(database().port("j1"), {
      parse: parser,
      encode,
      fenced: true,
    });
    expect(store.migrate(null)).toBeNull();
    expect(parser).not.toHaveBeenCalled();
    const raw = { status: "queued", claimed_by: null };
    expect(store.migrate(raw)).toEqual({ _tag: "queued" });
    expect(parser).toHaveBeenCalledTimes(1);
    expect(parser.mock.calls[0]?.[0]).toBe(raw);
  });

  it("a row re-created after delete starts again at revision 1", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "running", by: "w1" }, 5);
    const store = storeOf(db.port("j1"));
    await store.delete();
    expect(await store.saveFenced({ _tag: "queued" }, 0)).toBe(1);
    expect(db.live.get("j1")).toEqual({
      row: { status: "queued", claimed_by: null },
      revision: 1,
    });
  });

  it("delete removes the row, and the next read is version 0 again; deleting nothing resolves", async () => {
    const db = database();
    const store = storeOf(db.port("j1"));
    await expect(store.delete()).resolves.toBeUndefined();
    await store.saveFenced({ _tag: "queued" }, 0);
    await store.delete();
    expect(await store.loadFenced()).toEqual({ raw: null, version: 0 });
  });
});

describe("rowStore: the example parser", () => {
  const unreadableValues: [string, unknown][] = [
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "running"],
    ["an array", []],
  ];
  const unreadableColumns: [string, Record<string, unknown>][] = [
    ["an empty row", {}],
    ["an unknown status", { status: "paused", claimed_by: null }],
    ["running with no claimed_by", { status: "running" }],
    ["running with a null claimed_by", { status: "running", claimed_by: null }],
    ["running with a numeric claimed_by", { status: "running", claimed_by: 7 }],
    ["queued with a claimed_by", { status: "queued", claimed_by: "w1" }],
  ];

  it.each([
    ...unreadableValues,
    ...unreadableColumns,
  ])("refuses %s, and does not throw", (_name, row) => {
    expect(() => parse(row)).not.toThrow();
    expect(parse(row)).toMatchObject({ _tag: "refusal" });
  });

  it.each([
    ["queued", { status: "queued", claimed_by: null }, { _tag: "queued" }],
    ["done", { status: "done", claimed_by: null }, { _tag: "done" }],
    [
      "running",
      { status: "running", claimed_by: "w1" },
      { _tag: "running", by: "w1" },
    ],
    [
      "cancelling",
      { status: "cancelling", claimed_by: "w1" },
      { _tag: "cancelling", by: "w1" },
    ],
  ])("reads a %s row", (_name, row, state) => {
    expect(parse(row)).toEqual(state);
  });

  it.each(
    unreadableColumns,
  )("a run on %s stops at boot, writes nothing and runs no Cmd", async (_name, row) => {
    const db = database();
    const sent: JobCmd[] = [];
    db.seed("j1", row, 3);
    const booting = run(job, {
      store: storeOf(db.port("j1")),
      boot: "restored",
      interpret: {
        notify: async (cmd) => {
          sent.push(cmd);
        },
      },
      onError: () => {},
    });
    await expect(booting.ready).rejects.toBeInstanceOf(StoreRefusedError);
    await booting.stop();
    expect(db.counts.writes).toBe(0);
    expect(db.live.get("j1")).toEqual({ row, revision: 3 });
    expect(sent).toEqual([]);
  });
});

describe("rowStore: an existing row is a State or a refusal", () => {
  it("parse cannot answer null, because absence is decided only by the port finding no row", () => {
    rowStore(database().port("j1"), {
      // @ts-expect-error a row that exists is a State or a refusal, never nothing
      parse: (): Job | null => null,
      encode,
      fenced: true,
    });
  });

  it("a parse that answers null for an existing row is refused at boot, not booted fresh over it", async () => {
    const db = database();
    const sent: JobCmd[] = [];
    const row = { status: "queued", claimed_by: null };
    db.seed("j1", row, 3);
    const answersNull = rowStore(db.port("j1"), {
      parse: (() => null) as unknown as (row: unknown) => Job | Refusal,
      encode,
      fenced: true,
    });
    expect(answersNull.migrate(row)).toMatchObject({ _tag: "refusal" });
    const booting = run(job, {
      store: answersNull,
      boot: "restored",
      interpret: {
        notify: async (cmd) => {
          sent.push(cmd);
        },
      },
      onError: () => {},
    });
    await expect(booting.ready).rejects.toBeInstanceOf(StoreRefusedError);
    await booting.stop();
    expect(db.counts.writes).toBe(0);
    expect(db.live.get("j1")).toEqual({ row, revision: 3 });
    expect(sent).toEqual([]);
  });
});

describe("rowStore: refusals", () => {
  it("two writers at version 0: one insert wins, the loser's state is not there", async () => {
    const db = database();
    const [one, two] = [storeOf(db.port("j1")), storeOf(db.port("j1"))];
    expect(await one.saveFenced({ _tag: "running", by: "won" }, 0)).toBe(1);
    await expect(
      two.saveFenced({ _tag: "running", by: "lost" }, 0),
    ).rejects.toBeInstanceOf(StoreConflictError);
    expect(db.live.get("j1")?.row).toEqual({
      status: "running",
      claimed_by: "won",
    });
  });

  it("a stale save is refused with both versions and changes nothing", async () => {
    const db = database();
    const store = storeOf(db.port("j1"));
    await store.saveFenced({ _tag: "queued" }, 0);
    await store.saveFenced({ _tag: "running", by: "w1" }, 1);
    await expect(store.saveFenced({ _tag: "done" }, 1)).rejects.toMatchObject({
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(db.live.get("j1")).toEqual({
      row: { status: "running", claimed_by: "w1" },
      revision: 2,
    });
  });

  it("a row deleted between the read and the save is a conflict against version 0", async () => {
    const db = database();
    const store = storeOf(db.port("j1"));
    await store.saveFenced({ _tag: "queued" }, 0);
    db.live.delete("j1");
    await expect(store.saveFenced({ _tag: "done" }, 1)).rejects.toMatchObject({
      expectedVersion: 1,
      actualVersion: 0,
    });
  });

  it("the second version is what the diagnostic read saw after the refusal, even when another writer moved the row since", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "running", by: "w1" }, 2);
    const port = db.port("j1");
    const racing: RowPort = {
      ...port,
      update: async (columns, expected) => {
        const written = await port.update(columns, expected);
        seedJob(db, "j1", { _tag: "done" }, 9);
        return written;
      },
    };
    await expect(
      storeOf(racing).saveFenced({ _tag: "done" }, 1),
    ).rejects.toMatchObject({ expectedVersion: 1, actualVersion: 9 });
    expect(db.live.get("j1")?.revision).toBe(9);
  });

  it("a refused save whose diagnostic read finds the expected revision, or no row after an insert, is a conflict of equal versions", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "running", by: "w1" }, 2);
    const port = db.port("j1");
    const changedNothing: RowPort = { ...port, update: async () => false };
    await expect(
      storeOf(changedNothing).saveFenced({ _tag: "done" }, 2),
    ).rejects.toMatchObject({ expectedVersion: 2, actualVersion: 2 });
    const vanished: RowPort = {
      ...database().port("j2"),
      insert: async () => false,
    };
    await expect(
      storeOf(vanished).saveFenced({ _tag: "queued" }, 0),
    ).rejects.toMatchObject({ expectedVersion: 0, actualVersion: 0 });
  });

  it("a diagnostic read that fails rejects the save with its own failure, and nothing was written", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "running", by: "w1" }, 2);
    const down = new Error("connection lost");
    const port = db.port("j1");
    const failing: RowPort = {
      ...port,
      read: async () => {
        throw down;
      },
    };
    await expect(storeOf(failing).saveFenced({ _tag: "done" }, 1)).rejects.toBe(
      down,
    );
    expect(db.live.get("j1")).toEqual({
      row: { status: "running", claimed_by: "w1" },
      revision: 2,
    });
  });

  it("two version-blind saves that read the same revision: one lands, the other conflicts, and the winner stays stored", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "queued" });
    const meet = readsMeet(2);
    const [a, b] = [
      storeOf(held(db.port("j1"), meet)),
      storeOf(held(db.port("j1"), meet)),
    ];
    const settled = await Promise.allSettled([
      a.save({ _tag: "running", by: "a" }),
      b.save({ _tag: "running", by: "b" }),
    ]);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(StoreConflictError);
    const winner = settled[0]?.status === "fulfilled" ? "a" : "b";
    expect(db.live.get("j1")).toEqual({
      row: { status: "running", claimed_by: winner },
      revision: 2,
    });
  });

  it("a row the parser cannot read is refused, not guessed at", async () => {
    const db = database();
    db.seed("j1", { status: "paused", claimed_by: null }, 3);
    const store = storeOf(db.port("j1"));
    expect(store.migrate((await store.loadFenced()).raw)).toMatchObject({
      _tag: "refusal",
    });
  });

  it("a run still live when its row is deleted is refused at its next save", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "queued" });
    const store = storeOf(db.port("j1"));
    const rt = await run(job, {
      store,
      boot: "restored",
      interpret: { notify: async () => {} },
      onError: () => {},
    }).ready;
    await store.delete();
    await expect(
      rt.dispatch({ _tag: "claim", by: "w1" }),
    ).rejects.toMatchObject({
      _tag: "store_conflict",
      expectedVersion: 1,
      actualVersion: 0,
    });
    await rt.stop();
  });
});

describe("a request through the engine", () => {
  it("a Msg the state does not accept costs one read and no write, and no Cmd runs", async () => {
    const db = database();
    const sent: JobCmd[] = [];
    seedJob(db, "j1", { _tag: "done" }, 7);
    const outcome = await request(db.port("j1"), { _tag: "cancel" }, sent);
    expect(outcome.reported).toEqual([]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]).toBeInstanceOf(NoCellError);
    expect(db.live.get("j1")).toEqual({
      row: { status: "done", claimed_by: null },
      revision: 7,
    });
    expect(db.counts).toEqual({ reads: 1, writes: 0 });
    expect(sent).toEqual([]);
  });

  it("an accepted Msg costs one read and one write, and reports nothing at stop", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "queued" }, 7);
    const outcome = await request(
      db.port("j1"),
      { _tag: "claim", by: "w1" },
      [],
    );
    expect(errorsOf(outcome)).toEqual([]);
    expect(db.live.get("j1")?.revision).toBe(8);
    expect(db.counts).toEqual({ reads: 1, writes: 1 });
  });

  it("a request that changes nothing cannot make a legal one lose", async () => {
    const db = database();
    const sent: JobCmd[] = [];
    seedJob(db, "j1", { _tag: "queued" });
    const meet = readsMeet(2);
    const [legal, empty] = await Promise.all([
      request(held(db.port("j1"), meet), { _tag: "claim", by: "w1" }, sent),
      request(held(db.port("j1"), meet), { _tag: "finish" }, sent),
    ]);
    expect(errorsOf(legal)).toEqual([]);
    expect(empty.reported).toEqual([]);
    expect(empty.rejected).toHaveLength(1);
    expect(empty.rejected[0]).toBeInstanceOf(NoCellError);
    expect(db.live.get("j1")).toEqual({
      row: { status: "running", claimed_by: "w1" },
      revision: 2,
    });
    expect(sent).toEqual([{ _tag: "notify", to: "w1", about: "running" }]);
  });

  it("a birth inserts: a row never saved is created by the request, then moved once by its Msg", async () => {
    const db = database();
    const outcome = await request(
      db.port("j9"),
      { _tag: "claim", by: "w1" },
      [],
    );
    expect(errorsOf(outcome)).toEqual([]);
    expect(db.live.get("j9")).toEqual({
      row: { status: "running", claimed_by: "w1" },
      revision: 2,
    });
    expect(db.counts).toEqual({ reads: 1, writes: 2 });
  });

  it("two requests birth one row together: one insert wins, the other is told with a StoreConflictError", async () => {
    const db = database();
    const sent: JobCmd[] = [];
    const meet = readsMeet(2);
    const both = await Promise.all([
      request(held(db.port("j9"), meet), { _tag: "claim", by: "w1" }, sent),
      request(held(db.port("j9"), meet), { _tag: "claim", by: "w2" }, sent),
    ]);
    const lost = both.filter((outcome) =>
      errorsOf(outcome).some((e) => e instanceof StoreConflictError),
    );
    expect(lost).toHaveLength(1);
    const [loser] = lost;
    expect(loser?.rejected).toHaveLength(1);
    expect(loser?.rejected[0]).toBeInstanceOf(StoreConflictError);
    expect(loser?.rejected[0]).toMatchObject({ expectedVersion: 0 });
    expect(sent).toHaveLength(1);
    expect(db.live.get("j9")?.revision).toBe(2);
    expect(sent[0]?.to).toBe(db.live.get("j9")?.row.claimed_by);
  });

  it("finish and cancel race on one running job, 25 interleavings: both loaded revision 1, one is applied, only its Cmd runs", async () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const db = database(shuffledYields(seed));
      const sent: JobCmd[] = [];
      seedJob(db, "j1", { _tag: "running", by: "w1" });
      const meet = readsMeet(2);
      const outcomes = await Promise.all([
        request(held(db.port("j1"), meet), { _tag: "finish" }, sent),
        request(held(db.port("j1"), meet), { _tag: "cancel" }, sent),
      ]);
      const winners = outcomes.flatMap((outcome, index) =>
        errorsOf(outcome).length === 0 ? [index] : [],
      );
      const losers = outcomes.filter((outcome) => errorsOf(outcome).length > 0);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.rejected).toHaveLength(1);
      expect(losers[0]?.rejected[0]).toBeInstanceOf(StoreConflictError);
      const about = winners[0] === 0 ? "done" : "cancelling";
      expect(sent).toEqual([{ _tag: "notify", to: "w1", about }]);
      expect(db.live.get("j1")?.row.status).toBe(about);
      expect(db.live.get("j1")?.revision).toBe(2);
    }
  });

  it("a stale dispatch rejects, and stop reports its refused final save", async () => {
    const db = database();
    const won: JobCmd[] = [];
    const lost: JobCmd[] = [];
    seedJob(db, "j1", { _tag: "queued" });
    const stale = staleFirstRead(db.port("j1"), {
      row: encode({ _tag: "queued" }),
      revision: 1,
    });
    await request(db.port("j1"), { _tag: "claim", by: "won" }, won);
    const outcome = await request(stale, { _tag: "claim", by: "lost" }, lost);
    const errors = errorsOf(outcome);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e instanceof StoreConflictError)).toBe(true);
    expect(outcome.rejected).toMatchObject([
      { expectedVersion: 1, actualVersion: 2 },
    ]);
    expect(outcome.reported.map(({ phase }) => phase)).toEqual(["stop-save"]);
    expect(db.live.get("j1")).toEqual({
      row: { status: "running", claimed_by: "won" },
      revision: 2,
    });
    expect(won).toEqual([{ _tag: "notify", to: "won", about: "running" }]);
    expect(lost).toEqual([]);
  });
});

describe("the host's own transaction", () => {
  const claimInside = async (db: Database, port?: (real: RowPort) => RowPort) =>
    db.transaction(async (tx) => {
      tx.note("claimed j1");
      const real = tx.port("j1");
      const [first] = errorsOf(
        await request(
          port ? port(real) : real,
          { _tag: "claim", by: "w1" },
          [],
        ),
      );
      if (first !== undefined) throw first;
    });

  it("the save and a sibling write commit together", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "queued" });
    await claimInside(db);
    expect(db.audit).toEqual(["claimed j1"]);
    expect(db.live.get("j1")).toEqual({
      row: { status: "running", claimed_by: "w1" },
      revision: 2,
    });
  });

  it("a lost fence inside the transaction takes the sibling write down with it", async () => {
    const db = database();
    seedJob(db, "j1", { _tag: "queued" }, 4);
    await expect(
      claimInside(db, (real) =>
        staleFirstRead(real, { row: encode({ _tag: "queued" }), revision: 3 }),
      ),
    ).rejects.toMatchObject({ expectedVersion: 3, actualVersion: 4 });
    expect(db.audit).toEqual([]);
    expect(db.live.get("j1")?.revision).toBe(4);
  });
});
