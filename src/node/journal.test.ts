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

describe("fileJournal: an interleaved second append does not steal the seq", () => {
  it("serialises a second append DISPATCHED while the first holds the lock", async () => {
    const dir = freshDir();
    const journal = fileJournal(dir, parseRec);

    // A deterministic handshake, not a wall-clock spin on the lock file: A takes
    // the stream lock via `withLock` and parks inside the critical section until
    // B is proven dispatched. Only once A provably holds the lock (`aHasLock`
    // resolved) is B initiated — a second, INDEPENDENT top-level append that
    // must queue on the lock rather than race it. This is the shape a
    // re-entrancy check keyed on an instance-wide "held" Set waves through
    // inline: it sees "s" already held (by A) and runs B's append concurrently,
    // so both read length 0, both compute seq 1, and A's record is clobbered.
    // Serialisation keyed on the async call chain queues B on the mutex instead.
    //
    // Every ordering point here is a resolved promise, never elapsed time: the
    // earlier spin-until-`existsSync(lockPath)` could miss the brief window in
    // which the lock file exists (A's whole append can complete within one
    // event-loop turn), then spin ~10_000 iterations past the 5s timeout — a
    // concurrency proof that intermittently timed out and proved nothing.
    let signalAHasLock!: () => void;
    let signalBDispatched!: () => void;
    const aHasLock = new Promise<void>((resolve) => {
      signalAHasLock = resolve;
    });
    const bDispatched = new Promise<void>((resolve) => {
      signalBDispatched = resolve;
    });

    const a = journal.withLock("s", async () => {
      signalAHasLock(); // A now holds the stream lock, mid-critical-section
      await bDispatched; // …and keeps holding it until B is proven dispatched
      return journal.append("s", { tag: "A" }); // re-entrant append under the held lock
    });

    await aHasLock; // A provably holds the lock before B is initiated
    const b = journal.append("s", { tag: "B" }); // dispatched while A holds it —
    signalBDispatched(); // B is already queued on the mutex; let A finish and release

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
