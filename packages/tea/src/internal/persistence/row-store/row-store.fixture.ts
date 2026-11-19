import type { RowPort } from "../../../persistence";

export type Cell = { row: Record<string, unknown>; revision: number };
export type Database = ReturnType<typeof database>;

/**
 * Tables in memory with the one property of SQL a row store leans on: each
 * port call is a single statement, so its compare and its write cannot be
 * split by another request. `yieldAt` is where a test lets others run first.
 * `transaction` publishes its writes together, or none when `work` throws.
 */
export function database(yieldAt: () => Promise<void> = async () => {}) {
  const live = new Map<string, Cell>();
  const audit: string[] = [];
  const counts = { reads: 0, writes: 0 };
  const portOver = (cells: Map<string, Cell>, id: string): RowPort => ({
    read: async () => {
      await yieldAt();
      counts.reads += 1;
      return cells.get(id) ?? null;
    },
    insert: async (columns) => {
      await yieldAt();
      if (cells.has(id)) return false;
      counts.writes += 1;
      cells.set(id, { row: { ...columns }, revision: 1 });
      return true;
    },
    update: async (columns, expected) => {
      await yieldAt();
      if (cells.get(id)?.revision !== expected) return false;
      counts.writes += 1;
      cells.set(id, { row: { ...columns }, revision: expected + 1 });
      return true;
    },
    remove: async () => {
      cells.delete(id);
    },
  });
  return {
    live,
    audit,
    counts,
    port: (id: string): RowPort => portOver(live, id),
    seed: (id: string, row: Record<string, unknown>, revision = 1) => {
      live.set(id, { row, revision });
    },
    transaction: async <T>(
      work: (tx: {
        port(id: string): RowPort;
        note(line: string): void;
      }) => Promise<T>,
    ): Promise<T> => {
      const staged = new Map(live);
      const notes: string[] = [];
      const out = await work({
        port: (id) => portOver(staged, id),
        note: (line) => notes.push(line),
      });
      live.clear();
      for (const [k, v] of staged) live.set(k, v);
      audit.push(...notes);
      return out;
    },
  };
}
