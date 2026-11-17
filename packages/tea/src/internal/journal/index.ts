/**
 * Opaque, well-formed Unicode text, returned exactly, code unit for code unit.
 * A driver never parses, trims, normalizes or re-encodes it. Tea writes JSON
 * text into it; a driver must not rely on that.
 */
export type EncodedRecord = string;
export type JournalEntry = {
  readonly seq: number;
  readonly record: EncodedRecord;
};
export type JournalRefusal =
  | {
      readonly _tag: "journal_io";
      readonly operation: "read" | "append" | "close";
      readonly message: string;
      readonly uncertain: boolean;
    }
  | { readonly _tag: "journal_corrupt"; readonly message: string };
export type JournalConflict = {
  readonly _tag: "journal_conflict";
  readonly expected: number;
  readonly head: number;
};
export type JournalRead = {
  readonly _tag: "read";
  readonly head: number;
  readonly entries: readonly JournalEntry[];
};
export type JournalAppend = {
  readonly _tag: "appended";
  readonly head: number;
  readonly entries: readonly JournalEntry[];
};

/**
 * Ordered storage of opaque text. One active writer per stream is required.
 * An append stores the entire nonempty batch or none of it.
 * `read(stream, after)` returns every stored entry whose `seq` is greater than `after`, in order, for ANY number; it never refuses a position.
 * After an uncertain append, reopen and read;
 * the refusal does not authorize blindly retrying the batch.
 */
export interface Journal {
  read(stream: string, after: number): Promise<JournalRead | JournalRefusal>;
  append(
    stream: string,
    records: readonly [EncodedRecord, ...EncodedRecord[]],
  ): Promise<JournalAppend | JournalRefusal>;
  close(): Promise<void | JournalRefusal>;
}
/** Methods beside the base methods, matching FencedStore's widening pattern. */
export interface FencedJournal extends Journal {
  readonly fenced: true;
  appendFenced(
    stream: string,
    records: readonly [EncodedRecord, ...EncodedRecord[]],
    expected: number,
  ): Promise<JournalAppend | JournalRefusal | JournalConflict>;
}

/** In-process storage; opt into atomic expected-head comparison explicitly. */
export function memoryJournal(options: {
  readonly fenced: true;
}): FencedJournal;
export function memoryJournal(options?: { readonly fenced?: false }): Journal;
export function memoryJournal(
  options: { readonly fenced?: boolean } = {},
): Journal | FencedJournal {
  const streams = new Map<
    string,
    { head: number; batches: JournalEntry[][] }
  >();
  const base: Journal = {
    async read(stream, after) {
      const stored = streams.get(stream);
      const selected: JournalEntry[][] = [];
      if (stored) {
        for (let i = stored.batches.length - 1; i >= 0; i--) {
          const batch = stored.batches[i];
          if (!batch || (batch.at(-1)?.seq ?? 0) <= after) break;
          selected.push(batch.filter((entry) => entry.seq > after));
        }
      }
      return {
        _tag: "read",
        head: stored?.head ?? 0,
        entries: selected.reverse().flat(),
      };
    },
    async append(stream, records) {
      try {
        const stored = streams.get(stream) ?? { head: 0, batches: [] };
        const entries = records.map((record, i) => ({
          seq: stored.head + i + 1,
          record,
        }));
        stored.batches.push(entries);
        stored.head += entries.length;
        streams.set(stream, stored);
        return { _tag: "appended", head: stored.head, entries };
      } catch (error) {
        return {
          _tag: "journal_io",
          operation: "append",
          message: String(error),
          uncertain: true,
        };
      }
    },
    async close() {},
  };
  if (options.fenced !== true) return base;
  return {
    ...base,
    fenced: true,
    async appendFenced(stream, records, expected) {
      const head = streams.get(stream)?.head ?? 0;
      return expected === head
        ? base.append(stream, records)
        : { _tag: "journal_conflict", expected, head };
    },
  };
}
