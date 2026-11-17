import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FencedJournal,
  Journal,
  JournalAppend,
  JournalConflict,
  JournalRefusal,
} from "../internal/journal";
import {
  describeJournalConformance,
  type JournalKitFactory,
} from "../internal/journal/conformance";
import { fileJournal } from "./index";

const writes = vi.hoisted(() => ({
  cut: undefined as number | undefined,
  short: false,
  zero: false,
}));
vi.mock("node:fs", async (original) => {
  const native = await original<typeof import("node:fs")>();
  return {
    ...native,
    writeSync(fd: number, buffer: Uint8Array, offset: number, length: number) {
      if (writes.zero) return 0;
      const limit = writes.cut ?? buffer.length;
      if (offset >= limit) throw new Error("interrupted write");
      const count = native.writeSync(
        fd,
        buffer,
        offset,
        Math.min(length, limit - offset, writes.short ? 3 : length),
      );
      if (writes.cut !== undefined && offset + count >= limit)
        throw new Error("interrupted write");
      return count;
    },
  };
});

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = fs.mkdtempSync(join(tmpdir(), "tea-journal-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  writes.cut = undefined;
  writes.short = false;
  writes.zero = false;
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("fileJournal", () => {
  it("stores one atomic batch frame per line without parsing its records", async () => {
    const dir = freshDir();
    const journal = fileJournal(dir);
    const records = ['{ "value": 1 }', '"半🌱"'] as const;
    expect(await journal.append("s", records)).toEqual({
      _tag: "appended",
      head: 2,
      entries: [
        { seq: 1, record: records[0] },
        { seq: 2, record: records[1] },
      ],
    });
    expect(fs.readFileSync(join(dir, "s.jsonl"), "utf8")).toBe(
      `${JSON.stringify(records)}\n`,
    );
    await journal.close();
    expect(await fileJournal(dir).read("s", 0)).toEqual({
      _tag: "read",
      head: 2,
      entries: [
        { seq: 1, record: records[0] },
        { seq: 2, record: records[1] },
      ],
    });
  });

  it("completes short writes and refuses a write that makes no progress", async () => {
    const dir = freshDir();
    const journal = fileJournal(dir);
    writes.short = true;
    expect(await journal.append("s", ['"半🌱"'])).toMatchObject({
      _tag: "appended",
      head: 1,
    });
    expect(await fileJournal(dir).read("s", 0)).toMatchObject({
      _tag: "read",
      entries: [{ seq: 1, record: '"半🌱"' }],
    });
    writes.zero = true;
    expect(await journal.append("s", ['"next"'])).toMatchObject({
      _tag: "journal_io",
      operation: "append",
      uncertain: true,
      message: "Storage write made no progress",
    });
  });

  it("refreshes an already open reader and preserves a torn UTF-8 tail until append", async () => {
    const dir = freshDir();
    const writer = fileJournal(dir);
    const reader = fileJournal(dir);
    expect(await reader.read("s", 0)).toEqual({
      _tag: "read",
      head: 0,
      entries: [],
    });
    await writer.append("s", ['"first"']);
    expect(await reader.read("s", 0)).toMatchObject({ _tag: "read", head: 1 });
    await writer.append("s", ['"second"']);
    expect(await reader.read("s", 1)).toEqual({
      _tag: "read",
      head: 2,
      entries: [{ seq: 2, record: '"second"' }],
    });
    const path = join(dir, "s.jsonl");
    fs.appendFileSync(path, Buffer.from('["半🌱').subarray(0, -1));
    const torn = fs.readFileSync(path);
    expect(await reader.read("s", 2)).toEqual({
      _tag: "read",
      head: 2,
      entries: [],
    });
    expect(fs.readFileSync(path)).toEqual(torn);
    expect(await writer.append("s", ['"third"'])).toMatchObject({
      _tag: "appended",
      head: 3,
    });
    await reader.close();
    expect(await reader.read("s", 0)).toMatchObject({ _tag: "read", head: 3 });
  });

  it("returns malformed complete frames as corruption without rewriting bytes", async () => {
    const dir = freshDir();
    const path = join(dir, "s.jsonl");
    fs.writeFileSync(path, "[42]\n");
    const journal = fileJournal(dir);
    expect(await journal.read("s", 0)).toMatchObject({
      _tag: "journal_corrupt",
    });
    expect(await journal.append("s", ['"next"'])).toMatchObject({
      _tag: "journal_corrupt",
    });
    expect(fs.readFileSync(path, "utf8")).toBe("[42]\n");
  });
});

it("fences separate file instances against the real head under the shared lock", async () => {
  const dir = freshDir();
  const a = fileJournal(dir, { fenced: true });
  const b = fileJournal(dir, { fenced: true });
  await a.read("s", 0);
  await b.read("s", 0);
  const results = await Promise.all([
    a.appendFenced("s", ['"a"'], 0),
    b.appendFenced("s", ['"b"'], 0),
  ]);
  expect(results.filter((result) => result._tag === "appended")).toHaveLength(
    1,
  );
  expect(
    results.filter((result) => result._tag === "journal_conflict"),
  ).toEqual([{ _tag: "journal_conflict", expected: 0, head: 1 }]);
  const before = fs.readFileSync(join(dir, "s.jsonl"));
  expect(await a.appendFenced("s", ['"ahead"'], 2)).toEqual({
    _tag: "journal_conflict",
    expected: 2,
    head: 1,
  });
  expect(fs.readFileSync(join(dir, "s.jsonl"))).toEqual(before);
  expect(await b.appendFenced("s", ['"next"'], 1)).toEqual({
    _tag: "appended",
    head: 2,
    entries: [{ seq: 2, record: '"next"' }],
  });
});

const fileFixture =
  (fenced: boolean): JournalKitFactory =>
  async () => {
    const dir = freshDir();
    return {
      byteFile: true,
      async open() {
        if (!fenced) return fileJournal(dir);
        const journal = fileJournal(dir, { fenced: true });
        const heads = new Map<string, number>();
        return {
          ...journal,
          async read(stream, after) {
            const result = await journal.read(stream, after);
            if (result._tag === "read") heads.set(stream, result.head);
            return result;
          },
          async append(stream, records) {
            const result = await journal.appendFenced(
              stream,
              records,
              heads.get(stream) ?? 0,
            );
            if (result._tag === "journal_conflict")
              throw new Error(JSON.stringify(result));
            if (result._tag === "appended") heads.set(stream, result.head);
            return result;
          },
        } satisfies FencedJournal;
      },
      interruptAt(point) {
        writes.cut = point;
      },
      writePoints: (records) =>
        Array.from(
          { length: Buffer.byteLength(`${JSON.stringify(records)}\n`) + 1 },
          (_, i) => i,
        ),
      async tearTail() {
        fs.appendFileSync(
          join(dir, "s.jsonl"),
          Buffer.from('["半').subarray(0, 4),
        );
      },
      async dispose() {
        writes.cut = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  };

type StoredRow = { readonly pos: number; readonly body: string };
function openTurn(path: string) {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS entries(stream TEXT, id TEXT, body TEXT, pos INTEGER, PRIMARY KEY(stream,id), UNIQUE(stream,pos))",
  );
  const read = db.prepare(
    "SELECT pos, body FROM entries WHERE stream=? AND pos>? ORDER BY pos",
  );
  const get = db.prepare(
    "SELECT pos, body FROM entries WHERE stream=? AND id=?",
  );
  const head = db.prepare(
    "SELECT COALESCE(MAX(pos),0) AS pos FROM entries WHERE stream=?",
  );
  const put = db.prepare("INSERT INTO entries VALUES(?,?,?,?)");
  function stored(row: Record<string, unknown>): StoredRow {
    if (typeof row.pos !== "number" || typeof row.body !== "string")
      throw new Error("Invalid stored row");
    return { pos: row.pos, body: row.body };
  }
  const turn = {
    read: (stream: string, after: number) =>
      read.all(stream, after).map(stored),
    get(stream: string, id: string) {
      const row = get.get(stream, id);
      return row ? stored(row) : undefined;
    },
    head(stream: string): number {
      const pos = head.get(stream)?.pos;
      if (typeof pos !== "number") throw new Error("Invalid stored head");
      return pos;
    },
    append(stream: string, id: string, line: string) {
      const prior = turn.get(stream, id);
      if (prior) return { rev: prior.pos, pos: prior.pos };
      const pos = turn.head(stream) + 1;
      put.run(stream, id, line, pos);
      return { rev: pos, pos };
    },
  };
  return { turn, db };
}

function sqliteJournal(
  path: string,
  interrupt: (point: number) => void,
): FencedJournal {
  const { turn, db } = openTurn(path);
  let closed = false;
  async function append(
    stream: string,
    records: readonly [string, ...string[]],
    expected?: number,
  ): Promise<JournalAppend | JournalRefusal | JournalConflict> {
    let active = false;
    let committed = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      active = true;
      const head = turn.head(stream);
      if (expected !== undefined && expected !== head) {
        db.exec("ROLLBACK");
        active = false;
        return { _tag: "journal_conflict", expected, head };
      }
      const entries = records.map((record, i) => {
        interrupt(i);
        const { pos } = turn.append(stream, String(head + i + 1), record);
        return { seq: pos, record };
      });
      interrupt(records.length);
      db.exec("COMMIT");
      active = false;
      committed = true;
      interrupt(records.length + 1);
      return { _tag: "appended", head: head + entries.length, entries };
    } catch (error) {
      if (active) db.exec("ROLLBACK");
      return {
        _tag: "journal_io",
        operation: "append",
        message: String(error),
        uncertain: committed,
      };
    }
  }
  return {
    fenced: true,
    async append(stream, records) {
      const result = await append(stream, records);
      if (result._tag === "journal_conflict")
        throw new Error("Unconditional append cannot conflict");
      return result;
    },
    appendFenced: append,
    async read(stream, after) {
      try {
        return {
          _tag: "read",
          head: turn.head(stream),
          entries: turn
            .read(stream, after)
            .map((row) => ({ seq: row.pos, record: row.body })),
        };
      } catch (error) {
        return {
          _tag: "journal_io",
          operation: "read",
          message: String(error),
          uncertain: false,
        };
      }
    },
    async close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  };
}

const sqliteFixture: JournalKitFactory = async () => {
  const dir = freshDir();
  const opened = new Set<Journal>();
  let cut: number | undefined;
  return {
    byteFile: false,
    async open() {
      const journal = sqliteJournal(join(dir, "journal.db"), (point) => {
        if (point === cut) throw new Error(`interrupted at write ${cut}`);
      });
      opened.add(journal);
      return journal;
    },
    interruptAt(point) {
      cut = point;
    },
    writePoints: (records) =>
      Array.from({ length: records.length + 2 }, (_, i) => i),
    async dispose() {
      for (const journal of opened) await journal.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

const drivers = {
  file: fileFixture(false),
  fileFenced: fileFixture(true),
  sqlite: sqliteFixture,
} satisfies Record<string, JournalKitFactory>;
for (const [label, make] of Object.entries(drivers)) {
  for (let repeat = 1; repeat <= 3; repeat++) {
    describeJournalConformance(`${label} ${repeat}`, make, {
      records: 10000,
      now: () => performance.now(),
    });
  }
}
