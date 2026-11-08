import type { ImportEdge } from "../../schema.js";
import { placeOf, type ScopeZoning } from "../rules.js";
import type { ExportEntry } from "./exports.js";
import type { ImportedTable, TableFacts } from "./tables.js";
import type { UnfollowedKind } from "./unfollowed.js";

// The one place that says whose a table is. A file names a table through the module it imported it
// from, and that module may only re-export it: this follows the name through every re-export to the
// module that defines it, by ECMAScript's own algorithm, ResolveExport (ECMA-262, 16.2.1.7.2.2,
// https://tc39.es/ecma262/#sec-resolveexport): local exports first, then indirect ones
// (`export { a as b } from`, `export * as ns from`), then `export *`; a name two stars supply is
// ambiguous; and a circle of re-exports is cut by the pairs already visited, not by a depth. It
// reads the facts of the scope's files and never the modules behind them, runs no type checker and
// follows no data flow. B23, the owners view and the census all ask it.

// What a name a file imports comes to.
//  - `table`: the table `table`, defined in a tables file, which the feature `owner` declares. The
//    table's identity is the name that file exports it under, whatever it was called on the way.
//  - `none`: a followed name that holds no table: a namespace taken whole, a name no chain defines (a
//    type-only re-export).
//  - `unfollowed`: where the walk stops short of the answer, and why. A binding of a file that is no
//    tables file is one: whatever it holds, the run does not follow the value, so a write of it is
//    counted.
export type Followed =
  | { readonly kind: "table"; readonly owner: string; readonly table: string }
  | { readonly kind: "none" }
  | { readonly kind: "unfollowed"; readonly why: UnfollowedKind };

// A file the follower reads: its path in the scope, its edges (a specifier to the loaded file it
// resolves to) and its facts.
export type FollowedFile = {
  readonly file: string;
  readonly importEdges: readonly ImportEdge[];
  readonly tableFacts: TableFacts;
};

// What the table `imported` names in `from`, a file of the scope, comes to.
export type Follow = (from: string, imported: ImportedTable) => Followed;

// What ResolveExport answers for one name of one module.
type Resolution =
  | { readonly kind: "binding"; readonly file: string; readonly name: string }
  | { readonly kind: "namespace"; readonly file: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unfollowed"; readonly why: UnfollowedKind };

const MISSING: Resolution = { kind: "missing" };
const NONE: Followed = { kind: "none" };
const unfollowed = (why: UnfollowedKind): Resolution => ({ kind: "unfollowed", why });

// The scope's files, indexed when first asked, so a run whose rules file lists no table kind never
// builds the index. `targetOf` is the loaded file a specifier written in `file` resolves to.
type Modules = {
  readonly get: (file: string) => FollowedFile | undefined;
  readonly targetOf: (file: string, source: string) => string | undefined;
};

function modulesOf(files: readonly FollowedFile[]): Modules {
  let byFile: ReadonlyMap<string, FollowedFile> | undefined;
  const get = (file: string): FollowedFile | undefined => {
    byFile ??= new Map(files.map((f) => [f.file, f]));
    return byFile.get(file);
  };
  const targets = new Map<string, ReadonlyMap<string, string>>();
  const targetOf = (file: string, source: string): string | undefined => {
    if (!targets.has(file)) {
      const edges = get(file)?.importEdges ?? [];
      targets.set(
        file,
        new Map(edges.flatMap((e) => (e.target === null ? [] : [[e.specifier, e.target]]))),
      );
    }
    return targets.get(file)?.get(source);
  };
  return { get, targetOf };
}

// One request: the module asked, and the pairs (module, name) the request has already visited, the
// spec's resolveSet.
type Ask = {
  readonly modules: Modules;
  readonly file: string;
  readonly visited: Set<string>;
};

// A module followed from the one that wrote its specifier. A specifier no loaded file answers leaves
// the run blind to what it would have brought.
function through(ask: Ask, source: string, then: (target: string) => Resolution): Resolution {
  const target = ask.modules.targetOf(ask.file, source);
  return target === undefined ? unfollowed("unloaded-module") : then(target);
}

// The entries that answer for one name. A star is not one: it is asked only when no other entry has
// the name, and its answers can disagree.
type Named = Exclude<ExportEntry, { readonly kind: "star" }>;
type Entry<K extends Named["kind"]> = Extract<Named, { readonly kind: K }>;
type Says = (entry: Named, name: string, ask: Ask) => Resolution | null;

// What each kind of entry says about a name: one row per kind, so a form added to the export table
// is a row the compiler asks for.
const SAYS: {
  readonly [K in Named["kind"]]: (entry: Entry<K>, name: string, ask: Ask) => Resolution | null;
} = {
  local: (entry, name, ask) =>
    entry.name === name ? { kind: "binding", file: ask.file, name } : null,
  indirect: (entry, name, ask) =>
    entry.name === name
      ? through(ask, entry.source, (target) =>
          resolveExport(ask.modules, target, entry.from, ask.visited),
        )
      : null,
  namespace: (entry, name, ask) =>
    entry.name === name
      ? through(ask, entry.source, (target) => ({ kind: "namespace", file: target }))
      : null,
  assignment: () => unfollowed("export-equals"),
};

// The table is indexed by an entry's kind, which TypeScript cannot correlate with the entry.
const say: Says = (entry, name, ask) => (SAYS[entry.kind] as Says)(entry, name, ask);

// ResolveExport(name) of a module. `default` is never followed, and no star supplies it.
function resolveExport(
  modules: Modules,
  file: string,
  name: string,
  visited: Set<string>,
): Resolution {
  if (name === "default") return unfollowed("default-export");
  const key = `${file}\0${name}`;
  if (visited.has(key)) return MISSING;
  visited.add(key);
  const entries = modules.get(file)?.tableFacts.exports ?? [];
  const ask: Ask = { modules, file, visited };
  for (const entry of entries) {
    const said = entry.kind === "star" ? null : say(entry, name, ask);
    if (said !== null) return said;
  }
  return viaStars(entries, name, ask);
}

function sameResolution(a: Resolution, b: Resolution): boolean {
  if (a.kind === "binding" && b.kind === "binding") return a.file === b.file && a.name === b.name;
  return a.kind === "namespace" && b.kind === "namespace" && a.file === b.file;
}

// The `export *` of a module, when no other entry has the name. A star that supplies it is the
// answer; two that supply it differently make it ambiguous; one the run cannot read may supply it,
// which is the answer only when no other star does (a working program has no ambiguity).
function viaStars(entries: readonly ExportEntry[], name: string, ask: Ask): Resolution {
  let found: Resolution | null = null;
  let unread: Resolution | null = null;
  for (const entry of entries) {
    if (entry.kind !== "star") continue;
    const resolution = through(ask, entry.source, (target) =>
      resolveExport(ask.modules, target, name, ask.visited),
    );
    if (resolution.kind === "unfollowed") {
      if (resolution.why === "ambiguous-star") return resolution;
      unread ??= resolution;
    } else if (resolution.kind !== "missing") {
      if (found !== null && !sameResolution(found, resolution)) return unfollowed("ambiguous-star");
      found ??= resolution;
    }
  }
  return found ?? unread ?? MISSING;
}

// What a walk comes to, as the answer a file gets for the table it named. `declaring` says which
// feature a file is the tables file of.
function answerOf(resolution: Resolution, declaring: (file: string) => string | null): Followed {
  switch (resolution.kind) {
    case "binding": {
      const owner = declaring(resolution.file);
      // A binding of a file that is no tables file (`export const o = orders`) holds a value, and so
      // does a member of one (`schema.users` of `export const schema = { users }`): which table it
      // is, if any, is data flow, which the run does not read. A member of a table is a column.
      return owner === null
        ? { kind: "unfollowed", why: "untraced-write" }
        : { kind: "table", owner, table: resolution.name };
    }
    case "unfollowed":
      return resolution;
    case "namespace":
    case "missing":
      return NONE;
    default: {
      const exhaustive: never = resolution;
      return exhaustive;
    }
  }
}

// The follower of one scope's files.
export function followerOf(files: readonly FollowedFile[], zoning: ScopeZoning): Follow {
  const modules = modulesOf(files);

  // A request that has visited nothing is a function of the module and the name alone.
  const settled = new Map<string, Resolution>();
  const resolveFresh = (file: string, name: string): Resolution => {
    const key = `${file}\0${name}`;
    const known = settled.get(key);
    if (known !== undefined) return known;
    const resolution = resolveExport(modules, file, name, new Set());
    settled.set(key, resolution);
    return resolution;
  };

  // The walk of a path from a module's exports: a namespace is entered one name at a time, until a
  // binding answers. What the path has left past a binding is a member of what the binding holds.
  const walk = (file: string, [head, ...tail]: readonly string[]): Resolution => {
    const resolution = head === undefined ? MISSING : resolveFresh(file, head);
    return resolution.kind === "namespace" && tail.length > 0
      ? walk(resolution.file, tail)
      : resolution;
  };

  // The feature whose tables file is `file`, null for any other file.
  const featureDeclaring = (file: string): string | null => {
    const place = placeOf(file, zoning);
    return place.kind === "feature" && place.zone.rule.declaresTables ? place.feature : null;
  };

  return (from, imported) => {
    const target = modules.targetOf(from, imported.source);
    if (target === undefined) return { kind: "unfollowed", why: "unloaded-module" };
    return answerOf(walk(target, imported.path), featureDeclaring);
  };
}
