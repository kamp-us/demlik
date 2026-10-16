import type { ImportEdge } from "../../schema.js";
import { type ImpureUse, impureNamesOf } from "../impure-uses.js";
import { inScope, type Place } from "../rules.js";
import type { BoundaryViolation } from "../violation.js";

// The facts of one file the impure rule reads. `file` is scope-relative.
export type ImpureFile = {
  readonly file: string;
  readonly importEdges: readonly Pick<ImportEdge, "specifier" | "target" | "typeOnly">[];
  readonly impureUses: readonly ImpureUse[];
  // The specifiers the file opens when it runs: a module row asks this, not the edge.
  readonly runtimeSpecifiers: ReadonlySet<string>;
};

export type ImpureContext = {
  readonly scope: string;
  readonly module: ImpureFile;
  readonly place: Place;
};

// A file in a zone that may not be impure, once per row of `IMPURE_GLOBALS` it uses by name or
// opens as a module. A place outside every feature is no zone: a pure library is judged beside its
// imports, in `libraries/violations.ts`.
export function impureViolations(ctx: ImpureContext): BoundaryViolation[] {
  const { place } = ctx;
  if (place.kind !== "feature" || place.zone.rule.mayBeImpure) return [];
  return impureNamesOf(ctx.module).map((name) => ({
    kind: "impure",
    from: inScope(ctx.scope, ctx.module.file),
    to: null,
    specifier: name,
    typeOnly: false,
  }));
}
