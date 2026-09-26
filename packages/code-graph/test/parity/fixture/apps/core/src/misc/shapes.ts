// A file of callable shapes the extractor has to name and measure.
import { Database } from "better-sqlite3";
import { createHash } from "hashlib";

export function parse(x: string): number;
export function parse(x: number): number;
export function parse(x: string | number): number {
  return Number(x);
}

function local(): number {
  return parse("1");
}
export { local, local as aliased };

export default function () {
  return local();
}

export const arrow = async (n: number): Promise<number> => {
  // A comment inside the body.
  for (const i of [1, 2, 3]) {
    if (i > n) {
      while (n < i) {
        n++;
      }
    } else if (i === n && n > 0) {
      n = n ?? 0;
    }
  }
  try {
    return n > 1 ? n : n || 1;
  } catch {
    return 0;
  }
};

export const table = {
  "quoted-key": () => 1,
  [String("computed")]: () => 2,
  method() {
    return 3;
  },
  get value() {
    return 4;
  },
};

export class Store {
  #count = 0;
  static readonly shared = new Store();
  handler = (x: number) => x + this.#count;

  constructor(private readonly db: Database) {}

  save(sql: string): void {
    this.db.exec(sql);
    this.db.prepare(sql).run();
  }

  digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  async fetchIt(url: string): Promise<unknown> {
    const response = await fetch(url);
    return response.json();
  }
}

/**
 * A docblock above a switch.
 */
export function route(kind: string): number {
  switch (kind) {
    case "a":
      return 1;
    case "b":
    case "c":
      return 2;
    default:
      return 0;
  }
}

// const commentedOut = route("a");
/* ---------------------------------------- */
// TODO: remove me
