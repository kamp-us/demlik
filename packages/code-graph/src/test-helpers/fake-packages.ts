import fs from "node:fs";
import path from "node:path";

const FAKE_PACKAGES: Readonly<Record<string, string>> = {
  "drizzle-orm": `export declare class PgDatabase {
  insert(table: unknown): unknown;
  update(table: unknown): unknown;
  delete(table: unknown): unknown;
  execute(query: unknown): Promise<unknown>;
  select(): { from(table: unknown): { execute(): Promise<unknown> } };
}
export declare class PgTransaction extends PgDatabase {}
export declare const db: PgDatabase;
`,
  "@types/better-sqlite3": `export declare class Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}
export declare class Database {
  prepare(source: string): Statement;
  exec(source: string): this;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
}
`,
  "@types/hashlib": `export declare class Hash {
  update(data: string): Hash;
  digest(encoding: string): string;
}
export declare function createHash(algorithm: string): Hash;
`,
};

export function writeFakePackages(root: string): void {
  for (const [name, declarations] of Object.entries(FAKE_PACKAGES)) {
    const dir = path.join(root, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version: "0.0.0", types: "index.d.ts" }),
    );
    fs.writeFileSync(path.join(dir, "index.d.ts"), declarations);
  }
}
