import type { ImportEdge, ModuleNode } from "../schema.js";
import type { SiteRow } from "./deployables/census.js";
import { type BindingSite, type Deployables, isWorkerMain } from "./deployables/deployables.js";
import { judgeDeployables } from "./deployables/judge.js";
import type { ImpureUse } from "./impure-uses.js";
import type { NamedFile } from "./libraries/allowance.js";
import { type Libraries, ownerOf } from "./libraries/libraries.js";
import type { ImportedFrom } from "./libraries/schema.js";
import { judgeLibraries, undeclaredLibraries } from "./libraries/violations.js";
import {
  type BoundaryRules,
  type FeaturePlace,
  inScope,
  type Place,
  placeOf,
  type ScopeZoning,
  scopeZoning,
} from "./rules.js";
import { judgeShape } from "./shape/judge.js";
import type { Shape, ShapeFacts } from "./shape/shape.js";
import type { BoundaryViolation, ZoneEdge } from "./violation.js";
import { impureViolations } from "./zones/impure-violations.js";
import { type DrivenReads, drivenReadsOf, type ScopeReads, scopeReadsOf } from "./zones/reads.js";
import { type RootReach, rootReachOf, testReachViolations } from "./zones/test-reach.js";
import { isTestFile, judgedInTestFile } from "./zones/test-role.js";

export type BoundaryModule = Pick<ModuleNode, "file" | "importEdges"> &
  ShapeFacts &
  NamedFile & {
    readonly impureUses: readonly ImpureUse[];
    // The specifiers the file opens when it runs. `importEdges` is the graph's and keeps a type-only
    // `import { type Stats }` as a value import; a module row of `IMPURE_GLOBALS` asks this.
    readonly runtimeSpecifiers: ReadonlySet<string>;
    // The bindings of the worker that owns the file that it references, read only when the rules
    // file lists a deployable kind.
    readonly bindingSites: readonly BindingSite[];
  };

export type ScopeBoundaryReport = {
  readonly scope: string;
  readonly features: readonly string[];
  readonly filesScanned: number;
  readonly violations: readonly BoundaryViolation[];
  // The worker call graph's report only: the workers the deploy configs name.
  readonly workers?: readonly string[];
};

type EdgeContext = {
  readonly scope: string;
  readonly from: string;
  readonly fromPlace: Place;
  readonly edge: ImportEdge;
  readonly zoning: ScopeZoning;
  // Whether the scope's read allowance licenses a driving file's import of a driven file.
  readonly reads: DrivenReads;
};

// An import between two files of one feature: only the importer's zone can forbid it.
function withinFeature(
  ctx: EdgeContext,
  from: FeaturePlace,
  target: string,
  to: FeaturePlace,
): BoundaryViolation | null {
  const edge: ZoneEdge = {
    from: inScope(ctx.scope, ctx.from),
    feature: from.feature,
    to: inScope(ctx.scope, target),
    specifier: ctx.edge.specifier,
    typeOnly: ctx.edge.typeOnly,
  };
  const kind = from.zone.rule.imports;
  switch (kind) {
    case null:
      return null;
    case "application-imports-adapter":
      return to.zone.adapter ? { kind, ...edge } : null;
    case "driving-reaches-driven": {
      if (to.zone.name === "application") return { kind, ...edge };
      if (to.zone.name !== "driven") return null;
      const verdict = ctx.reads(target);
      if (verdict.licensed) return null;
      return { kind, ...edge, ...(verdict.write === undefined ? {} : { write: verdict.write }) };
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function crossingFrom(
  ctx: EdgeContext,
  target: string,
  to: FeaturePlace,
): BoundaryViolation | null {
  const { fromPlace, edge } = ctx;
  const crossing = {
    from: inScope(ctx.scope, ctx.from),
    to: inScope(ctx.scope, target),
    toFeature: to.feature,
    specifier: edge.specifier,
    typeOnly: edge.typeOnly,
  };
  switch (fromPlace.kind) {
    case "feature":
      if (to.feature === fromPlace.feature) return withinFeature(ctx, fromPlace, target, to);
      if (to.zone.rule.openToFeatures) return null;
      return { kind: "cross-feature", fromFeature: fromPlace.feature, ...crossing };
    case "lib":
      return { kind: "lib-imports-feature", ...crossing };
    case "elsewhere":
      if (to.zone.rule.openToOutside) return null;
      return { kind: "outside-imports-feature-internal", ...crossing };
    default: {
      const exhaustive: never = fromPlace;
      return exhaustive;
    }
  }
}

function violationOf(ctx: EdgeContext): BoundaryViolation | null {
  const { edge } = ctx;
  if (edge.target === null) return null;
  const to = placeOf(edge.target, ctx.zoning);
  return to.kind === "feature" ? crossingFrom(ctx, edge.target, to) : null;
}

// B10's entry for a file in a per-feature hexagon that no zone holds. A port scope has none: it lists
// all three of its folders, and each holds every file below it.
function unknownEntryOf(scope: string, place: Place): BoundaryViolation | null {
  if (place.kind !== "feature" || place.layout !== "per-feature") return null;
  if (place.zone.name !== "unknown") return null;
  return {
    kind: "unknown-zone",
    from: inScope(scope, `src/${place.feature}/${place.zone.entry}`),
    feature: place.feature,
    to: null,
    specifier: place.zone.entry,
    typeOnly: false,
  };
}

// Which `importedFrom` zone a file satisfies: a hexagonal feature's driven zone is `driven`, and a
// file outside every feature is a `configurator`.
function libraryZoneOf(place: Place): ImportedFrom | null {
  return place.kind === "feature" ? place.zone.rule.libraryZone : "configurator";
}

// What a run reads once, before any scope is judged, that every scope's judgment asks of.
export type ScopeInputs = {
  readonly libraries: Libraries;
  readonly deployables: Deployables;
  readonly shape: Shape;
};

type ScopeContext = ScopeInputs & {
  readonly scope: string;
  readonly rules: BoundaryRules;
  readonly zoning: ScopeZoning;
  // The scope's read allowance and the writes of the files it lists, or null for a scope with none.
  readonly allowance: ScopeReads | null;
  // The scope's composition roots and every file that opens one when it runs, empty for a rules file
  // that lists no `compositionRoots`.
  readonly reach: RootReach;
};

// What one file of a scope crosses: its violations, how many imports of undeclared packages its
// library left unjudged, and the binding sites the census counts. The scope's own entries (an
// unknown zone, a package no library names) are the caller's.
type Found = {
  readonly violations: BoundaryViolation[];
  readonly unjudged: number;
  readonly sites: SiteRow[];
};

const NOT_JUDGED: Pick<Found, "violations" | "sites"> = { violations: [], sites: [] };

// B17 and B19 for one file, and the sites it holds. A file inside a library nested in the scope
// belongs to that library's own scope and is judged there, as for B12-B14.
function acrossDeployables(
  ctx: ScopeContext,
  module: BoundaryModule,
  place: Place,
): Pick<Found, "violations" | "sites"> {
  const { scope, libraries, deployables } = ctx;
  if (deployables.kinds.size === 0) return NOT_JUDGED;
  const from = inScope(scope, module.file);
  const nested = ownerOf(libraries, from);
  if (nested !== null && nested !== scope) return NOT_JUDGED;
  const violations = judgeDeployables(deployables, {
    scope,
    file: module.file,
    from,
    importEdges: module.importEdges,
    bindingSites: module.bindingSites,
    driven: place.kind === "feature" && place.zone.rule.touchesBindings,
    isMain: isWorkerMain(deployables, from),
    owners: ctx.rules.bindingOwners[scope] ?? {},
  });
  const sites = module.bindingSites.map((site) => ({ file: from, ...site }));
  return { violations, sites };
}

// One file's verdicts. Every kind judges it, and then the test role drops the kinds that do not
// judge a test file (`zones/test-role.ts`); B20 judges a test file and nothing else. One verdict per
// import: the edges B1 and B6 judged are left to them by B16.
function analyzeModule(ctx: ScopeContext, module: BoundaryModule, fromPlace: Place): Found {
  const { scope, zoning, libraries, shape } = ctx;
  const reads = drivenReadsOf(ctx.allowance, module, libraries);
  const edges = module.importEdges.map((edge) => ({
    edge,
    violation: violationOf({
      scope,
      from: module.file,
      fromPlace,
      edge,
      zoning,
      reads,
    }),
  }));
  const judged = new Set(edges.filter((e) => e.violation !== null).map((e) => e.edge));
  const impure = impureViolations({ scope, module, place: fromPlace });
  const file = { ...module, file: inScope(scope, module.file) };
  const libs = judgeLibraries(libraries, scope, file, libraryZoneOf(fromPlace));
  const across = acrossDeployables(ctx, module, fromPlace);
  const isTest = isTestFile(shape.tests, scope, module.file);
  const violations = [
    ...edges.flatMap((e) => e.violation ?? []),
    ...impure,
    ...libs.violations,
    ...across.violations,
    ...judgeShape(ctx, module, fromPlace, judged),
    ...(isTest ? testReachViolations(ctx.reach, scope, module) : []),
  ];
  return {
    violations: isTest ? judgedInTestFile(violations) : violations,
    unjudged: libs.unjudged,
    sites: across.sites,
  };
}

// A scope's report, the imports of undeclared packages its libraries left unjudged, and every
// binding site its files hold.
export type ScopeAnalysis = {
  readonly report: ScopeBoundaryReport;
  readonly unjudged: number;
  readonly sites: readonly SiteRow[];
};

export function analyzeBoundaries(
  scope: string,
  modules: readonly BoundaryModule[],
  rules: BoundaryRules,
  inputs: ScopeInputs,
): ScopeAnalysis {
  const zoning = scopeZoning(rules, scope);
  const allowance = scopeReadsOf(inputs.shape.allowance, scope, modules);
  const reach = rootReachOf(inputs.shape.roots, scope, modules);
  const ctx: ScopeContext = { ...inputs, scope, rules, zoning, allowance, reach };
  const violations: BoundaryViolation[] = [];
  const sites: SiteRow[] = [];
  // One per entry, however many files sit under it.
  const unknownEntries = new Map<string, BoundaryViolation>();
  let unjudged = 0;
  for (const module of modules) {
    const fromPlace = placeOf(module.file, ctx.zoning);
    // A test file sits in no zone, so an entry that holds only test files is no entry.
    const isTest = isTestFile(inputs.shape.tests, scope, module.file);
    const unknown = isTest ? null : unknownEntryOf(scope, fromPlace);
    if (unknown !== null) unknownEntries.set(unknown.from, unknown);
    const found = analyzeModule(ctx, module, fromPlace);
    violations.push(...found.violations);
    sites.push(...found.sites);
    unjudged += found.unjudged;
  }
  violations.push(...unknownEntries.values(), ...undeclaredLibraries(inputs.libraries, scope));
  violations.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.from.localeCompare(b.from) ||
      a.specifier.localeCompare(b.specifier),
  );
  const features = [...ctx.zoning.features].sort((a, b) => a.localeCompare(b));
  return {
    report: { scope, features, filesScanned: modules.length, violations },
    unjudged,
    sites,
  };
}
