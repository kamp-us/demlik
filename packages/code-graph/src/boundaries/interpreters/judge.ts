import type { ImportEdge } from "../../schema.js";
import { inScope, type Place, placeOf, type ScopeZoning } from "../rules.js";
import type { BoundaryViolation } from "../violation.js";
import { covers, type Technology } from "./interpreters.js";

// The facts of one file the interpreter rules read. `file` is scope-relative.
export type InterpreterFile = {
  readonly file: string;
  readonly importEdges: readonly ImportEdge[];
};

// B24: a file that may hold a technology's adapter and imports a module the technology covers. Only
// `ports.ts` and an adapter zone are judged (`adapter` is the layout's own flag, so the port layout
// reads the same): `application/` and `index.ts` hold no adapter, and a technology no scope lists is
// never judged. Every edge counts, type-only, re-export and dynamic ones included. One entry per file
// per technology, type-only only when every matching import is.
export function technologyViolations(
  technologies: readonly Technology[],
  scope: string,
  file: InterpreterFile,
  place: Place,
): BoundaryViolation[] {
  if (place.kind !== "feature" || !(place.zone.name === "ports" || place.zone.adapter)) return [];
  return technologies.flatMap((technology): BoundaryViolation[] => {
    const reached = file.importEdges.filter((edge) => covers(technology, edge));
    if (reached.length === 0) return [];
    return [
      {
        kind: "technology-outside-interpreter",
        from: inScope(scope, file.file),
        to: null,
        specifier: technology.name,
        typeOnly: reached.every((edge) => edge.typeOnly),
      },
    ];
  });
}

type Reach = { readonly toFeature: string; readonly specifier: string; readonly typeOnly: boolean };

// B25: a file under an interpreter root importing any file of a feature, `index.ts` included. It is
// the only verdict for these edges, where B4 would judge a file outside every feature. One entry per
// file and target, the first specifier written, type-only only when every import of the target is.
export function interpreterImportsFeature(
  scope: string,
  zoning: ScopeZoning,
  file: InterpreterFile,
  place: Place,
): BoundaryViolation[] {
  if (place.kind !== "interpreter") return [];
  const reached = new Map<string, Reach>();
  for (const edge of file.importEdges) {
    if (edge.target === null) continue;
    const to = placeOf(edge.target, zoning);
    if (to.kind !== "feature") continue;
    const held = reached.get(edge.target);
    reached.set(edge.target, {
      toFeature: to.feature,
      specifier: held?.specifier ?? edge.specifier,
      typeOnly: (held?.typeOnly ?? true) && edge.typeOnly,
    });
  }
  return [...reached].map(
    ([target, reach]): BoundaryViolation => ({
      kind: "interpreter-imports-feature",
      from: inScope(scope, file.file),
      to: inScope(scope, target),
      ...reach,
    }),
  );
}
