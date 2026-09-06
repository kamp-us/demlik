// ───────────────────────────────────────────────────────────────────────────
// @demlik/tea/journal — the in-process substrate. Drives the shared behavioural
// conformance suite (equivalence with the Node file substrate), then pins the
// two properties that are memoryJournal's own: reference semantics (mirroring
// memoryStore) and that concurrent appenders to one stream converge on one
// order — the local, single-process twin of phoenix spike #6673.
// ───────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { describeJournalConformance } from "./conformance";
import { memoryJournal } from "./index";

describeJournalConformance("memoryJournal", () => memoryJournal());

describe("memoryJournal: reference semantics (mirrors memoryStore)", () => {
  it("stores the record by reference — a later mutation is observable", async () => {
    const journal = memoryJournal<{ items: string[] }>();
    const record = { items: ["a"] };
    await journal.append("s", record);
    record.items.push("b");
    const [entry] = await journal.list("s");
    expect(entry?.record.items).toEqual(["a", "b"]);
  });
});

describe("memoryJournal: racing appenders converge on one order", () => {
  it("assigns each of two racing appenders a distinct, gapless seq", async () => {
    const journal = memoryJournal<{ writer: string }>();
    const perWriter = 20;
    await Promise.all([
      ...Array.from({ length: perWriter }, () =>
        journal.append("s", { writer: "A" }),
      ),
      ...Array.from({ length: perWriter }, () =>
        journal.append("s", { writer: "B" }),
      ),
    ]);
    const seqs = (await journal.list("s")).map((e) => e.seq);
    expect(seqs).toEqual(
      Array.from({ length: perWriter * 2 }, (_v, i) => i + 1),
    );
  });
});
