import { inScope, type Place, placeOf, type ScopeZoning } from "../boundaries/rules.js";
import type { Placed } from "./features.js";
import { type Locus, locusOf } from "./locus.js";

// A file that imports a file under the technology's interpreter root, and where that file sits.
export type TechnologyReach = { readonly file: string; readonly place: Locus };

// One technology a scope gives a single interpreter (the `interpreters` key): the folder the
// interpreter sits in, the modules it covers as the rules file spells them, and every file outside
// the root that imports a file under it.
export type TechnologyRow = {
  readonly technology: string;
  readonly root: string;
  readonly modules: readonly string[];
  readonly reach: readonly TechnologyReach[];
};

type Declared = Readonly<
  Record<string, { readonly root: string; readonly modules: readonly string[] }>
>;

const byName = (a: string, b: string): number => a.localeCompare(b);

// Whether a file outside a technology's root imports a file under it, type-only imports and
// re-exports included, as B24 counts an import.
function reachesRoot({ module, place }: Placed, technology: string, zoning: ScopeZoning): boolean {
  if (isUnder(place, technology)) return false;
  return module.importEdges.some(
    (edge) => edge.target !== null && isUnder(placeOf(edge.target, zoning), technology),
  );
}

function isUnder(place: Place, technology: string): boolean {
  return place.kind === "interpreter" && place.technology === technology;
}

// The technologies a scope declares, by name.
export function technologyRows(
  scope: string,
  declared: Declared,
  zoning: ScopeZoning,
  placed: readonly Placed[],
): TechnologyRow[] {
  return Object.entries(declared)
    .sort(([a], [b]) => byName(a, b))
    .map(([technology, { root, modules }]) => ({
      technology,
      root: inScope(scope, root),
      modules: [...modules].sort(byName),
      reach: placed
        .filter((file) => reachesRoot(file, technology, zoning))
        .map(({ module, place }) => ({ file: inScope(scope, module.file), place: locusOf(place) }))
        .sort((a, b) => byName(a.file, b.file)),
    }));
}
