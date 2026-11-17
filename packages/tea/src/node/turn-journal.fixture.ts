/** SQLite transaction fixture for a third-party journal driver. */
import { DatabaseSync } from "node:sqlite";
import type {
  FencedJournal,
  JournalAppend,
  JournalConflict,
  JournalRefusal,
} from "../internal/journal";

type StoredRow = { readonly pos: number; readonly body: string };
function openTurn(path: string) {
  const db = new DatabaseSync(path);
  // Keep full synchronization while avoiding a rollback-journal create/delete per transaction.
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS entries(stream TEXT, id TEXT, body TEXT, pos INTEGER, PRIMARY KEY(stream,id), UNIQUE(stream,pos))",
  );
  const read = db.prepare(
    "SELECT pos, CAST(body AS BLOB) AS body FROM entries WHERE stream=? AND pos>? ORDER BY pos",
  );
  const get = db.prepare(
    "SELECT pos, CAST(body AS BLOB) AS body FROM entries WHERE stream=? AND id=?",
  );
  const head = db.prepare(
    "SELECT COALESCE(MAX(pos),0) AS pos FROM entries WHERE stream=?",
  );
  const put = db.prepare("INSERT INTO entries VALUES(?,?,?,?)");
  // Node 22's TEXT reader stops at NUL; the stored UTF-8 bytes are complete.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function stored(row: Record<string, unknown>): StoredRow {
    if (typeof row.pos !== "number" || !(row.body instanceof Uint8Array))
      throw new Error("Invalid stored row");
    return { pos: row.pos, body: decoder.decode(row.body) };
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

export function sqliteJournal(
  path: string,
  interrupt: (point: number) => void = () => {},
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
