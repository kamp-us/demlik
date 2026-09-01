// ───────────────────────────────────────────────────────────────────────────
// @demlik/tea/node — fileJournal, the on-disk journal substrate beside
// fileStore. Drives the shared behavioural conformance suite (equivalence with
// memoryJournal), then pins the properties that are the file substrate's own:
// readable JSONL on disk, the stale-PID lock steal, and — the real local twin
// of phoenix spike #6673 — two SEPARATE journal instances over one directory
// racing to append, where only the file lock (not a shared in-process mutex)
// serialises them into one order.
// ───────────────────────────────────────────────────────────────────────────
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeJournalConformance } from "../journal/conformance";
import { fileJournal } from "./index";

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tea-journal-"));
  dirs.push(dir);
  return dir;
};

const parseRec = (raw: unknown): { readonly tag: string } => {
  if (typeof raw !== "object" || raw === null || !("tag" in raw)) {
    throw new Error("fileJournal record is not a { tag } shape");
  }
  return { tag: String((raw as { tag: unknown }).tag) };
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describeJournalConformance("fileJournal", () =>
  fileJournal(freshDir(), parseRec),
);

describe("fileJournal: readable JSONL on disk", () => {
  it("writes one { seq, record } JSON object per line", async () => {
    const dir = freshDir();
    const journal = fileJournal(dir, parseRec);
    await journal.append("s", { tag: "a" });
    await journal.append("s", { tag: "b" });
    const lines = readFileSync(join(dir, "s.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { seq: 1, record: { tag: "a" } },
      { seq: 2, record: { tag: "b" } },
    ]);
  });
});

describe("fileJournal: the lock steals a dead holder's stale lock", () => {
  it("appends past a lock file left by a PID that is not alive", async () => {
    const dir = freshDir();
    const journal = fileJournal(dir, parseRec);
    // A PID above the max is never a live process → process.kill(pid, 0) throws
    // ESRCH, so the lock is proven stale and stolen rather than waited on.
    writeFileSync(join(dir, "s.jsonl.lock"), "2147483647");
    expect(await journal.append("s", { tag: "a" })).toEqual({ seq: 1 });
    expect((await journal.list("s")).map((e) => e.record.tag)).toEqual(["a"]);
  });
});

describe("fileJournal: two instances race, the file lock picks one order", () => {
  it("serialises separate instances over one directory into a gapless seq", async () => {
    const dir = freshDir();
    const a = fileJournal(dir, parseRec);
    const b = fileJournal(dir, parseRec);
    const perWriter = 12;
    await Promise.all([
      ...Array.from({ length: perWriter }, () => a.append("s", { tag: "A" })),
      ...Array.from({ length: perWriter }, () => b.append("s", { tag: "B" })),
    ]);
    const seqs = (await a.list("s")).map((e) => e.seq);
    expect(seqs).toEqual(
      Array.from({ length: perWriter * 2 }, (_v, i) => i + 1),
    );
  });
});
