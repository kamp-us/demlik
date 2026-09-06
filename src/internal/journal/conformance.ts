/**
 * The behavioural contract every `Journal<R>` substrate must satisfy, run once
 * per substrate. `memoryJournal` and the Node `fileJournal` both drive this
 * suite, which is the proof that they are behaviourally equivalent for
 * append/list/changes (the ratified acceptance criterion). Substrate-specific
 * concerns — the file lock's stale-PID steal, cross-instance racing — live
 * beside each substrate's own test, not here.
 */

import { describe, expect, it } from "vitest";
import type { Journal } from "./index";

type Rec = { readonly tag: string };

export function describeJournalConformance(
  label: string,
  make: () => Journal<Rec>,
): void {
  describe(`Journal conformance — ${label}`, () => {
    it("append assigns a per-stream total order starting at 1", async () => {
      const journal = make();
      expect(await journal.append("s", { tag: "a" })).toEqual({ seq: 1 });
      expect(await journal.append("s", { tag: "b" })).toEqual({ seq: 2 });
      expect(await journal.append("s", { tag: "c" })).toEqual({ seq: 3 });
    });

    it("list returns every entry of a stream in seq order", async () => {
      const journal = make();
      await journal.append("s", { tag: "a" });
      await journal.append("s", { tag: "b" });
      expect(await journal.list("s")).toEqual([
        { stream: "s", seq: 1, record: { tag: "a" } },
        { stream: "s", seq: 2, record: { tag: "b" } },
      ]);
    });

    it("list is empty for an unwritten stream", async () => {
      expect(await make().list("never-written")).toEqual([]);
    });

    it("streams carry independent seq counters", async () => {
      const journal = make();
      await journal.append("x", { tag: "x1" });
      await journal.append("y", { tag: "y1" });
      expect(await journal.append("x", { tag: "x2" })).toEqual({ seq: 2 });
      expect(await journal.append("y", { tag: "y2" })).toEqual({ seq: 2 });
      expect((await journal.list("x")).map((e) => e.record.tag)).toEqual([
        "x1",
        "x2",
      ]);
      expect((await journal.list("y")).map((e) => e.record.tag)).toEqual([
        "y1",
        "y2",
      ]);
    });

    it("changes delivers appends made after subscribing", async () => {
      const journal = make();
      const seen: JournalEntryShape[] = [];
      const unsubscribe = journal.changes((entry) =>
        seen.push({
          stream: entry.stream,
          seq: entry.seq,
          tag: entry.record.tag,
        }),
      );
      await journal.append("s", { tag: "a" });
      await journal.append("s", { tag: "b" });
      expect(seen).toEqual([
        { stream: "s", seq: 1, tag: "a" },
        { stream: "s", seq: 2, tag: "b" },
      ]);
      unsubscribe();
      await journal.append("s", { tag: "c" });
      expect(seen).toHaveLength(2);
    });

    it("withLock is re-entrant: an append inside fx runs under the held lock", async () => {
      const journal = make();
      const seq = await journal.withLock("s", async () => {
        const first = await journal.append("s", { tag: "a" });
        const second = await journal.append("s", { tag: "b" });
        return [first.seq, second.seq];
      });
      expect(seq).toEqual([1, 2]);
      expect(await journal.list("s")).toHaveLength(2);
    });

    it("concurrent appends to one stream converge on a gapless order", async () => {
      const journal = make();
      const count = 24;
      await Promise.all(
        Array.from({ length: count }, (_v, i) =>
          journal.append("s", { tag: `r${i}` }),
        ),
      );
      const seqs = (await journal.list("s")).map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: count }, (_v, i) => i + 1));
    });
  });
}

type JournalEntryShape = { stream: string; seq: number; tag: string };
