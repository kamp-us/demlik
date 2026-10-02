import type { ImportEdge } from "../../schema.js";
import { type DoorUse, doorsOf } from "../door-uses.js";
import type { BoundaryViolation } from "../violation.js";
import {
  importTargetOf,
  isWorldLibrary,
  type Libraries,
  libraryTypeOf,
  ownerOf,
  undeclaredUnder,
} from "./libraries.js";
import type { ImportedFrom } from "./schema.js";

// The facts of one file the library rules read. `file` is repo-relative, as the ledger writes it.
export type LibraryFile = {
  readonly file: string;
  readonly importEdges: readonly ImportEdge[];
  readonly doorUses: readonly DoorUse[];
  readonly runtimeSpecifiers: ReadonlySet<string>;
};

export type LibraryJudgment = {
  readonly violations: readonly BoundaryViolation[];
  // Imports of a workspace package no library declares, from a library: counted, not judged.
  readonly unjudged: number;
};

const NOTHING: LibraryJudgment = { violations: [], unjudged: 0 };

type Context = {
  readonly libraries: Libraries;
  // The declared library the file belongs to, or null for a file in a feature scope.
  readonly importer: string | null;
  // Where the file sits for the libraries that say where they may be imported from.
  readonly zone: ImportedFrom | null;
  readonly file: LibraryFile;
};

// One library a file imports, however many of its specifiers or subpaths the file writes: the first
// specifier written, and type-only only when every one of them is.
type Reach = {
  readonly dir: string;
  readonly type: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
};

function reaches(ctx: Context): { readonly found: Reach[]; readonly undeclared: Set<string> } {
  const byDir = new Map<string, Reach>();
  const undeclared = new Set<string>();
  for (const edge of ctx.file.importEdges) {
    const target = importTargetOf(ctx.libraries, edge.specifier);
    if (target.kind === "undeclared") undeclared.add(target.dir);
    if (target.kind !== "library" || target.dir === ctx.importer) continue;
    const held = byDir.get(target.dir);
    byDir.set(target.dir, {
      dir: target.dir,
      type: target.type,
      specifier: held?.specifier ?? edge.specifier,
      typeOnly: (held?.typeOnly ?? true) && edge.typeOnly,
    });
  }
  return { found: [...byDir.values()], undeclared };
}

// One verdict per import: a library importing a type its own type does not list is B12, and only
// otherwise is the import judged by where the target may be imported from (B14).
function reachViolation(ctx: Context, reach: Reach): BoundaryViolation | null {
  const edge = {
    from: ctx.file.file,
    to: reach.dir,
    specifier: reach.specifier,
    typeOnly: reach.typeOnly,
  };
  const importerType = ctx.importer === null ? null : libraryTypeOf(ctx.libraries, ctx.importer);
  if (importerType !== null && !importerType.imports.includes(reach.type)) {
    return { kind: "library-imports-up", ...edge };
  }
  const zones = libraryTypeOf(ctx.libraries, reach.dir)?.importedFrom;
  if (zones === undefined || zones.includes("any")) return null;
  if (ctx.zone !== null && zones.includes(ctx.zone)) return null;
  return { kind: "adapter-library-imported-outside-driven", ...edge };
}

// A world library imported in any spelling, once per specifier as written; type-only only when
// every spelling of it is.
function worldSpecifiers(ctx: Context): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const edge of ctx.file.importEdges) {
    if (!isWorldLibrary(ctx.libraries, edge.specifier)) continue;
    found.set(edge.specifier, (found.get(edge.specifier) ?? true) && edge.typeOnly);
  }
  return found;
}

// A pure library's every use of a catalog door, and every import of a world library. A call on an
// object the file was handed (`deps.clock.now()`) is no door the file can name, so it is not seen.
function impureViolations(ctx: Context): BoundaryViolation[] {
  const type = ctx.importer === null ? null : libraryTypeOf(ctx.libraries, ctx.importer);
  if (type === null || !type.pure) return [];
  const entry = (specifier: string, typeOnly: boolean): BoundaryViolation => ({
    kind: "impure-library",
    from: ctx.file.file,
    to: null,
    specifier,
    typeOnly,
  });
  return [
    ...doorsOf(ctx.file).map((door) => entry(door, false)),
    ...[...worldSpecifiers(ctx)].map(([specifier, typeOnly]) => entry(specifier, typeOnly)),
  ];
}

// B12, B13 and B14 for one file of a scope. A file inside a library nested in the scope belongs to
// that library's own scope and is judged there.
export function judgeLibraries(
  libraries: Libraries,
  scope: string,
  file: LibraryFile,
  zone: ImportedFrom | null,
): LibraryJudgment {
  const importer = ownerOf(libraries, file.file);
  if (importer !== null && importer !== scope) return NOTHING;
  const ctx: Context = { libraries, importer, zone, file };
  const { found, undeclared } = reaches(ctx);
  const imports = found.flatMap((reach) => reachViolation(ctx, reach) ?? []);
  return {
    violations: [...imports, ...impureViolations(ctx)],
    unjudged: importer === null ? 0 : undeclared.size,
  };
}

// B11: every package below the root that no library names. The scope is the root, `from` the
// package's directory and `specifier` that directory below the root.
export function undeclaredLibraries(libraries: Libraries, root: string): BoundaryViolation[] {
  return undeclaredUnder(libraries, root).map((dir) => ({
    kind: "library-undeclared",
    from: dir,
    to: null,
    specifier: root === "." ? dir : dir.slice(root.length + 1),
    typeOnly: false,
  }));
}
