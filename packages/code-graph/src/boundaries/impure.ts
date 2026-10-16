import type { ImportEdge } from "../schema.js";

// An impure use is a way a file reaches outside itself: an env var, the terminal, the clock, the
// network, a module that touches the disk. `IMPURE_GLOBALS` is the whole vocabulary, one row per
// global or module (or per family of them), and the only place one is named. The detector and the
// `impure` kind read it, so adding one is adding a row here and a fixture case beside the
// detector's test, which the compiler demands.
//
//  - `path`: a static property path read off a global (`Date.now`, `fetch`). Any runtime reference
//    to the path, or to anything below it, is one use.
//  - `members`: a global whose every static member is its own row (`process.<member>`). The row
//    names the family and a use names the member it read, so `process.hrtime()` and
//    `process.hrtime.bigint()` are two reads of one use, `process.hrtime`.
//  - `bare-new`: `new <ctor>` with no argument (`new Date()` reads the clock; `new Date(x)` does not).
//  - `module`: a runtime import edge naming the module or a subpath of it, with or without `node:`.
type ImpureRow =
  | { readonly shape: "path" }
  | { readonly shape: "members"; readonly of: string }
  | { readonly shape: "bare-new"; readonly ctor: string }
  | { readonly shape: "module" };

export const IMPURE_GLOBALS = {
  "process.<member>": { shape: "members", of: "process" },
  "Date.now": { shape: "path" },
  "Math.random": { shape: "path" },
  "crypto.randomUUID": { shape: "path" },
  "crypto.getRandomValues": { shape: "path" },
  "performance.now": { shape: "path" },
  fetch: { shape: "path" },
  setTimeout: { shape: "path" },
  setInterval: { shape: "path" },
  globalThis: { shape: "path" },
  console: { shape: "path" },
  "new Date()": { shape: "bare-new", ctor: "Date" },
  "node:fs": { shape: "module" },
  "node:child_process": { shape: "module" },
} as const satisfies Record<string, ImpureRow>;

// A row of the table: `Date.now`, `node:fs`, or the family `process.<member>`.
export type ImpureRowName = keyof typeof IMPURE_GLOBALS;

// An impure use as a ledger entry spells it: a row's own name, or for a `members` row the member a
// use read (`process.hrtime`).
export type ImpureName = string;

const ROWS: Readonly<Record<ImpureRowName, ImpureRow>> = IMPURE_GLOBALS;

export const IMPURE_ROWS = Object.keys(ROWS) as ImpureRowName[];

// A chain rooted here is read without the root: `globalThis.process.env.CI` is `process.env.CI`.
export const GLOBAL_OBJECT = "globalThis";

// A use read off a static path: its name is the path's first `prefix.length + members` segments,
// so a `path` row (`members: 0`) is its own prefix and a `members` row adds the member after it.
type PathRow = { readonly prefix: readonly string[]; readonly members: 0 | 1 };

// Each shape is indexed the way it is looked up: path and member rows by prefix, `new` rows by
// constructor name, module rows by the specifier without `node:`. The switch is exhaustive, so a
// new shape does not compile until it says how it is found.
function indexRows() {
  const paths: PathRow[] = [];
  const news = new Map<string, ImpureName>();
  const modules = new Map<string, ImpureName>();
  for (const name of IMPURE_ROWS) {
    const row = ROWS[name];
    switch (row.shape) {
      case "path":
        paths.push({ prefix: name.split("."), members: 0 });
        break;
      case "members":
        paths.push({ prefix: [row.of], members: 1 });
        break;
      case "bare-new":
        news.set(row.ctor, name);
        break;
      case "module":
        modules.set(name.replace(/^node:/, ""), name);
        break;
      default: {
        const exhaustive: never = row;
        return exhaustive;
      }
    }
  }
  return { paths, news, modules };
}

const { paths: PATH_ROWS, news: NEW_ROWS, modules: MODULE_ROWS } = indexRows();

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

// The use a static path falls under, or null: `process.stdin.isTTY` falls under `process.stdin`,
// and a bare `process` under none. No row's prefix is a prefix of another's, so there is at most one.
export function impurePathOf(path: readonly string[]): ImpureName | null {
  for (const { prefix, members } of PATH_ROWS) {
    const named = prefix.length + members;
    if (path.length >= named && startsWith(path, prefix)) return path.slice(0, named).join(".");
  }
  return null;
}

export function impureBareNewOf(ctor: string): ImpureName | null {
  return NEW_ROWS.get(ctor) ?? null;
}

// A runtime import of a module the table lists: unresolved inside the scope (a builtin, not a file
// of the scope's own named `fs`) and not type-only, which opens nothing.
export function impureModuleOf(
  edge: Pick<ImportEdge, "specifier" | "target" | "typeOnly">,
): ImpureName | null {
  if (edge.target !== null || edge.typeOnly) return null;
  const [head = ""] = edge.specifier.replace(/^node:/, "").split("/");
  return MODULE_ROWS.get(head) ?? null;
}

// The modules of the table a file opens when it runs. The edge pass folds
// `import { type Stats } from "m"` into a value import and keeps one edge per specifier, so whether
// the file runs the module is the syntax's answer (`runtime`), and the edge only says where the
// specifier resolves.
export function impureModulesOpened(
  edges: readonly Pick<ImportEdge, "specifier" | "target" | "typeOnly">[],
  runtime: ReadonlySet<string>,
): ImpureName[] {
  return edges
    .filter((edge) => runtime.has(edge.specifier))
    .flatMap((edge) => impureModuleOf(edge) ?? []);
}
