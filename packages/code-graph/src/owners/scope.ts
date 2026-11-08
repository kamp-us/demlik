import { type BoundaryRules, placeOf, scopeZoning } from "../boundaries/rules.js";
import { loadScope } from "../boundaries/run/load.js";
import type { Reads } from "../boundaries/run/reads.js";
import { isTestFile } from "../boundaries/zones/test-role.js";
import { featuresOf, type OwnedFeature, type Placed } from "./features.js";
import { type TechnologyRow, technologyRows } from "./technologies.js";
import { type WorkerRow, workersOf } from "./workers.js";

// What one declared scope owns: the tables and ports of its features and who reaches into the
// tables, the workers whose bindings its files reference, and the technologies it gives one
// interpreter.
export type ScopeOwners = {
  readonly scope: string;
  readonly features: readonly OwnedFeature[];
  readonly workers: readonly WorkerRow[];
  readonly technologies: readonly TechnologyRow[];
};

// One scope, read as the gate reads it (`loadScope`), so a scope the gate refuses is refused here.
// A file `testFiles` lists is no part of the view, as it is no part of B23.
export function ownersOfScope(
  scope: string,
  rules: BoundaryRules,
  reads: Reads,
  repoRoot: string,
): ScopeOwners {
  const zoning = scopeZoning(rules, scope);
  const placed: Placed[] = loadScope(scope, rules, reads, repoRoot)
    .filter((module) => !isTestFile(reads.shape.tests, scope, module.file))
    .map((module) => ({ module, place: placeOf(module.file, zoning) }));
  return {
    scope,
    features: featuresOf({ scope, tables: reads.tables, zoning }, placed, repoRoot),
    workers: workersOf(
      {
        scope,
        deployables: reads.deployables,
        libraries: reads.libraries,
        owners: rules.bindingOwners[scope] ?? {},
      },
      placed,
    ),
    technologies: technologyRows(scope, rules.interpreters[scope] ?? {}, zoning, placed),
  };
}
