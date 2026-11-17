import { describe, expect, it } from "vitest";
import { memoryJournal } from "./index";

describe("memoryJournal", () => {
  it("acknowledges the stored text and positions of a complete batch", async () => {
    const journal = memoryJournal();
    const records = ['{"value":1}', '{ "value": 2 }'] as const;
    expect(await journal.read("s", 0)).toEqual({
      _tag: "read",
      head: 0,
      entries: [],
    });
    expect(await journal.append("s", records)).toEqual({
      _tag: "appended",
      head: 2,
      entries: [
        { seq: 1, record: records[0] },
        { seq: 2, record: records[1] },
      ],
    });
    expect(await journal.read("s", 1)).toEqual({
      _tag: "read",
      head: 2,
      entries: [{ seq: 2, record: records[1] }],
    });
  });

  it("refuses both stale and ahead expectations without writing", async () => {
    const journal = memoryJournal({ fenced: true });
    await journal.append("s", ['"first"']);
    for (const expected of [0, 2]) {
      expect(await journal.appendFenced("s", ['"refused"'], expected)).toEqual({
        _tag: "journal_conflict",
        expected,
        head: 1,
      });
    }
    expect(await journal.appendFenced("s", ['"second"'], 1)).toEqual({
      _tag: "appended",
      head: 2,
      entries: [{ seq: 2, record: '"second"' }],
    });
    expect(await journal.read("s", 0)).toEqual({
      _tag: "read",
      head: 2,
      entries: [
        { seq: 1, record: '"first"' },
        { seq: 2, record: '"second"' },
      ],
    });
  });
});
