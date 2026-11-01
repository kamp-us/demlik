import { join, posix } from "node:path";
import { jsonLike } from "./dependencies.js";
import { describeRef, type EntryRef, packageEntries } from "./entries.js";
import type { Exists } from "./heal.js";
import type { PathMove } from "./manifest.js";
import {
  packageLabel,
  packageOf,
  type Workspace,
  type WorkspacePackage,
} from "./workspace.js";

/** An entry apply can cut out of the package a row leaves: an `exports` subpath or a tsup `entry` row. */
type RemovableRef = Extract<EntryRef, { kind: "export" | "tsup" }>;

/**
 * What becomes of one entry naming a file a row moves. A row crossing a package line leaves an
 * `exports` subpath or tsup `entry` row naming a file that has gone, so apply removes it. Every
 * other entry stops the row: `main`, `module`, `types`, `bin`, a wrangler `main` and the `.` export
 * have no sound edit, and inside one package an entry should follow the file, which is the
 * person's edit to make.
 */
type Fate =
  | { readonly kind: "remove"; readonly ref: RemovableRef }
  | { readonly kind: "refuse"; readonly ref: EntryRef };

function fateOf(ref: EntryRef, crossing: boolean): Fate {
  switch (ref.kind) {
    case "field":
    case "wrangler":
      return { kind: "refuse", ref };
    case "export":
      return crossing && ref.key !== "."
        ? { kind: "remove", ref }
        : { kind: "refuse", ref };
    case "tsup":
      return crossing ? { kind: "remove", ref } : { kind: "refuse", ref };
  }
}

/** A row its old package's entries stop, and why, as one line of the refusal. */
export type EntryRefusal = {
  readonly row: PathMove;
  readonly pkg: WorkspacePackage;
  readonly why: string;
};

/** One file the rewrite commit edits to drop stale entries: repo-relative, and how its text changes. */
export type EntryEdit = {
  readonly path: string;
  readonly rewrite: (text: string) => string;
};

/**
 * The entries the rows' old packages hold for the files the rows move. `removed` names each entry
 * the rewrite commit cuts, as `<file> exports ./one` or `<file> entry src/one.ts`, sorted;
 * `edits` are the cuts; `refused` the rows no edit can carry.
 */
export type StaleEntries = {
  readonly removed: readonly string[];
  readonly edits: readonly EntryEdit[];
  readonly refused: readonly EntryRefusal[];
};

/** `text`, a `package.json`, with each of `keys` gone from its `exports` map. */
function withoutExports(text: string, keys: ReadonlySet<string>): string {
  const json = JSON.parse(text) as { exports?: Record<string, unknown> };
  const exports = json.exports;
  if (typeof exports !== "object" || exports === null) return text;
  json.exports = Object.fromEntries(
    Object.entries(exports).filter(([key]) => !keys.has(key)),
  );
  return jsonLike(json, text);
}

/**
 * Read each package a row leaves the way `move plan` reads it to pin entry files, against `tree`,
 * the tree before any row is renamed, so a resumed run reads the same entries the first one did.
 * A tsup config whose `entry` its syntax cannot carry stops every row leaving its package, since
 * apply cannot tell what it names.
 */
export function staleEntries(
  repoRoot: string,
  workspace: Workspace,
  rows: readonly PathMove[],
  tree: Exists,
): StaleEntries {
  const byPackage = new Map<
    string,
    { pkg: WorkspacePackage; rows: PathMove[] }
  >();
  for (const row of rows) {
    const pkg = packageOf(workspace, row.from);
    const entry = byPackage.get(pkg.root) ?? { pkg, rows: [] };
    entry.rows.push(row);
    byPackage.set(pkg.root, entry);
  }

  const removed = new Set<string>();
  const edits: EntryEdit[] = [];
  const refused: EntryRefusal[] = [];
  for (const { pkg, rows: leaving } of byPackage.values()) {
    const { named, tsup } = packageEntries(repoRoot, pkg.root, (relative) =>
      tree(join(repoRoot, pkg.root, relative)),
    );
    const keys = new Set<string>();
    const sources = new Set<string>();
    for (const row of leaving) {
      if (tsup !== undefined && tsup.unreadable.length > 0)
        refused.push({
          row,
          pkg,
          why: `${tsup.file} entry cannot be read from its syntax (${tsup.unreadable.join("; ")}), so apply cannot tell whether it names the file`,
        });
      const crossing = packageOf(workspace, row.to).root !== pkg.root;
      for (const { by } of named.filter(({ path }) => path === row.from)) {
        const fate = fateOf(by, crossing);
        if (fate.kind === "refuse") {
          refused.push({ row, pkg, why: `${describeRef(by)} names it` });
          continue;
        }
        removed.add(posix.join(pkg.root, describeRef(fate.ref)));
        if (fate.ref.kind === "export") keys.add(fate.ref.key);
        else sources.add(fate.ref.source);
      }
    }
    if (keys.size > 0)
      edits.push({
        path: posix.join(pkg.root, "package.json"),
        rewrite: (text) => withoutExports(text, keys),
      });
    if (tsup !== undefined && sources.size > 0)
      edits.push({
        path: posix.join(pkg.root, tsup.file),
        rewrite: (text) => tsup.without(text, sources),
      });
  }
  return { removed: [...removed].sort(), edits, refused: dedupe(refused) };
}

/** Each refusal once: one export key named through two condition targets is one reason. */
function dedupe(refused: readonly EntryRefusal[]): EntryRefusal[] {
  const seen = new Set<string>();
  return refused.filter(({ row, why }) => {
    const key = `${row.from}\0${row.to}\0${why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Throw, naming every row and the entry that stops it, when any does. Nothing is committed yet. */
export function refuseEntries(refused: readonly EntryRefusal[]): void {
  if (refused.length === 0) return;
  throw new Error(
    `rows move a file their old package names in an entry apply does not remove (main, module, types, bin, a wrangler main, the "." export, or an exports or tsup entry of a package the row stays inside), or leave a package whose tsup entry apply cannot read. Repoint or remove the entry, commit, and apply again; refusing before any commit:\n${refused.map(({ row, pkg, why }) => `  ${row.from} -> ${row.to}  (${packageLabel(pkg)}: ${why})`).join("\n")}`,
  );
}
