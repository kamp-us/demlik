import type { ImportEdge } from "../../schema.js";
import { isRelativeName } from "../../syntax/imports.js";
import { moduleDoorsOpened } from "../doors.js";
import {
  importedFromOutside,
  importTargetOf,
  inPackageGlobs,
  type Libraries,
} from "../libraries/libraries.js";
import { inScope, type Place } from "../rules.js";
import type { BoundaryViolation } from "../violation.js";
import type { Shape } from "./shape.js";

// One `application/` file of a hexagonal feature, as B16 reads it. `file` is scope-relative, `own`
// the zones of the feature the file may import (the zone table's allowlist), and `judged` the
// import edges another kind already judged: B1 for another feature's internals, B6 for the
// feature's own adapters.
export type ApplicationFile = {
  readonly scope: string;
  readonly file: string;
  readonly feature: string;
  readonly own: readonly string[];
  readonly importEdges: readonly ImportEdge[];
  readonly runtimeSpecifiers: ReadonlySet<string>;
  readonly judged: ReadonlySet<ImportEdge>;
};

export type ApplicationWorld = {
  readonly rules: Pick<Shape, "mayImport" | "pure">;
  readonly libraries: Libraries;
  readonly placeOf: (file: string) => Place;
};

// An import outside the allowlist: `to` is the file it lands in when the scope loads it, null for a
// package or a path the scope does not load.
type Outside = { readonly to: string | null };

const PACKAGE_OR_PATH: Outside = { to: null };

function outsideFile(
  file: ApplicationFile,
  world: ApplicationWorld,
  target: string,
): Outside | null {
  const place = world.placeOf(target);
  switch (place.kind) {
    case "lib":
      return null;
    case "elsewhere":
      return { to: target };
    case "feature":
      // Another feature's front door: its internals were B1's. Its own zones are an allowlist.
      if (place.feature !== file.feature) return null;
      return file.own.includes(place.zone.name) ? null : { to: target };
    default: {
      const exhaustive: never = place;
      return exhaustive;
    }
  }
}

// A package is allowed as `pureDependencies` names it, or as a library whose type
// `applicationMayImport` lists. A library that names where it may be imported from, and not here,
// is B14's: one verdict per import.
function outsidePackage(world: ApplicationWorld, specifier: string): Outside | null {
  if (isRelativeName(specifier) || specifier.startsWith("/")) return PACKAGE_OR_PATH;
  const target = importTargetOf(world.libraries, specifier);
  if (target.kind === "library" && importedFromOutside(world.libraries, target.dir, null)) {
    return null;
  }
  const listed = target.kind === "library" && world.rules.mayImport.has(target.type);
  return listed || inPackageGlobs(world.rules.pure, specifier) ? null : PACKAGE_OR_PATH;
}

// What is left of an import once the kinds that judge a part of it have had theirs: B1 and B6
// (`judged`), and B7 for a module door the file opens when it runs. A type-only import of `node:fs`
// opens nothing, so it stays here.
function outsideOf(
  file: ApplicationFile,
  world: ApplicationWorld,
  edge: ImportEdge,
): Outside | null {
  if (file.judged.has(edge)) return null;
  if (moduleDoorsOpened([edge], file.runtimeSpecifiers).length > 0) return null;
  return edge.target === null
    ? outsidePackage(world, edge.specifier)
    : outsideFile(file, world, edge.target);
}

type Reach = {
  readonly to: string | null;
  readonly specifier: string;
  readonly typeOnly: boolean;
};

// B16: one entry per file and import target however many specifiers reach it, the first one
// written, and type-only only when every import of the target is.
export function applicationViolations(
  file: ApplicationFile,
  world: ApplicationWorld,
): BoundaryViolation[] {
  const reached = new Map<string, Reach>();
  for (const edge of file.importEdges) {
    const outside = outsideOf(file, world, edge);
    if (outside === null) continue;
    const to = outside.to === null ? null : inScope(file.scope, outside.to);
    const key = to ?? edge.specifier;
    const held = reached.get(key);
    reached.set(key, {
      to,
      specifier: held?.specifier ?? edge.specifier,
      typeOnly: (held?.typeOnly ?? true) && edge.typeOnly,
    });
  }
  return [...reached.values()].map(
    (reach): BoundaryViolation => ({
      kind: "application-import-outside-allowlist",
      from: inScope(file.scope, file.file),
      ...reach,
    }),
  );
}
