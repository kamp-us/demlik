import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
