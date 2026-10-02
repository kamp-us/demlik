import type { ImportEdge } from "../../schema.js";
import type { Libraries } from "../libraries/libraries.js";
import { inScope, type Place, placeOf, type ScopeZoning } from "../rules.js";
import type { BoundaryViolation } from "../violation.js";
import { applicationViolations } from "./application.js";
import type { Shape } from "./shape.js";

// The facts of one file the shape rules read. `file` is scope-relative, and `offendingForm` the
// first form that keeps an `index.ts` from being named re-exports, read only where B15 is listed.
export type ShapedFile = {
  readonly file: string;
  readonly importEdges: readonly ImportEdge[];
  readonly runtimeSpecifiers: ReadonlySet<string>;
  readonly offendingForm: string | null;
};

export type ShapeContext = {
  readonly scope: string;
  readonly shape: Shape;
  readonly libraries: Libraries;
  readonly zoning: ScopeZoning;
};

// A declared library's entry file, below its directory, as `featureFileOf` assumes the `src/`
// layout. An inner `index.ts` (`src/schema/index.ts`) is no entry.
const LIBRARY_ENTRY = "src/index.ts";

// B15: an entry file holding more than named re-exports. A hexagonal feature's is the `index` zone
// (a `rules`-layout feature's is not judged), and a declared library's `src/index.ts` is its own
// scope's.
function entryViolations(ctx: ShapeContext, file: ShapedFile, place: Place): BoundaryViolation[] {
  const { scope, shape, libraries } = ctx;
  if (!shape.kinds.has("index-not-exports-only") || file.offendingForm === null) return [];
  const inFeature = place.kind === "feature" && place.zone.rule.exportsOnly;
  if (!inFeature && !(libraries.typeOfDir.has(scope) && file.file === LIBRARY_ENTRY)) return [];
  return [
    {
      kind: "index-not-exports-only",
      from: inScope(scope, file.file),
      to: null,
      specifier: file.offendingForm,
      typeOnly: false,
    },
  ];
}

// B16: the imports of an `application/` file of a hexagonal feature. `judged` is the edges B1 and
// B6 already judged, which B16 leaves to them.
function applicationImports(
  ctx: ShapeContext,
  file: ShapedFile,
  place: Place,
  judged: ReadonlySet<ImportEdge>,
): BoundaryViolation[] {
  const { scope, shape, libraries, zoning } = ctx;
  if (!shape.kinds.has("application-import-outside-allowlist")) return [];
  if (place.kind !== "feature" || place.zone.rule.importAllowlist === null) return [];
  const own = place.zone.rule.importAllowlist;
  const world = { rules: shape, libraries, placeOf: (target: string) => placeOf(target, zoning) };
  return applicationViolations({ ...file, scope, feature: place.feature, own, judged }, world);
}

// B15 and B16 for one file of a scope: the kinds `applicationShape` lists, and nothing for one it
// does not.
export function judgeShape(
  ctx: ShapeContext,
  file: ShapedFile,
  place: Place,
  judged: ReadonlySet<ImportEdge>,
): BoundaryViolation[] {
  return [...entryViolations(ctx, file, place), ...applicationImports(ctx, file, place, judged)];
}
