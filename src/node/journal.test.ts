// ───────────────────────────────────────────────────────────────────────────
// @demlik/tea/node — fileJournal, the on-disk journal substrate beside
// fileStore. Drives the shared behavioural conformance suite (equivalence with
// memoryJournal), then pins the properties that are the file substrate's own:
// readable JSONL on disk, the stale-PID lock steal, and — the real local twin
// of phoenix spike #6673 — two SEPARATE journal instances over one directory
// racing to append, where only the file lock (not a shared in-process mutex)
// serialises them into one order.
// ───────────────────────────────────────────────────────────────────────────
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

describe("fileJournal: an interleaved second append does not steal the seq", () => {
  it("serialises a second append DISPATCHED while the first holds the lock", async () => {
    const dir = freshDir();
    const journal = fileJournal(dir, parseRec);
    const lockPath = join(dir, "s.jsonl.lock");

    // Interleaved dispatch, not a synchronous Promise.all burst: A is initiated
    // first and B only after A is proven to hold the stream lock (its lock file
    // is on disk, mid-append). This is the shape a re-entrancy check keyed on an
    // instance-wide "held" Set waves through inline — B runs concurrently with A,
    // both read length 0, both compute seq 1, and A's record is clobbered.
    // Serialisation keyed on the async call chain queues B on the mutex instead.
    const a = journal.append("s", { tag: "A" });
    for (let spin = 0; spin < 10_000 && !existsSync(lockPath); spin++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(existsSync(lockPath)).toBe(true); // A is mid-append, holding the lock
    const b = journal.append("s", { tag: "B" });

    const [ra, rb] = await Promise.all([a, b]);
    expect(new Set([ra.seq, rb.seq])).toEqual(new Set([1, 2])); // no collision
    const entries = await journal.list("s");
    expect(entries.map((e) => e.seq)).toEqual([1, 2]); // gapless
    expect(entries.map((e) => e.record.tag).sort()).toEqual(["A", "B"]); // both kept
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
