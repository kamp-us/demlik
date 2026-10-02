import type { ImportEdge, ModuleNode } from "../schema.js";
import type { SiteRow } from "./deployables/census.js";
import type { BindingSite, Deployables } from "./deployables/deployables.js";
import { judgeDeployables } from "./deployables/judge.js";
import { type DoorUse, doorsOf } from "./door-uses.js";
import { declaredDoorOf, moduleDoorsOpened } from "./doors.js";
import { type Libraries, ownerOf } from "./libraries/libraries.js";
import type { ImportedFrom } from "./libraries/schema.js";
import { judgeLibraries, undeclaredLibraries } from "./libraries/violations.js";
import {
  type BoundaryRules,
  type FeatureFile,
  featureFileOf,
  type ScopeZoning,
  scopeZoning,
} from "./rules.js";
import { type BoundaryViolation, isDoorUse, type ZoneDoor, type ZoneEdge } from "./violation.js";

type FeaturePlace = { readonly kind: "feature" } & FeatureFile;

type Place = FeaturePlace | { readonly kind: "lib" } | { readonly kind: "elsewhere" };

export type BoundaryModule = Pick<ModuleNode, "file" | "importEdges"> & {
  readonly doorUses: readonly DoorUse[];
  // The specifiers the file opens when it runs. `importEdges` is the graph's and keeps a type-only
  // `import { type Stats }` as a value import; a module door asks this.
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

function placeOf(file: string, zoning: ScopeZoning): Place {
  const inFeature = featureFileOf(file, zoning);
  if (inFeature !== null) return { kind: "feature", ...inFeature };
  const [src, folder, ...rest] = file.split("/");
  if (src === "src" && folder !== undefined && rest.length > 0 && zoning.lib.has(folder)) {
    return { kind: "lib" };
  }
  return { kind: "elsewhere" };
}

function isContract(specifier: string, contracts: readonly string[]): boolean {
  return contracts.some((c) => specifier === c || specifier.startsWith(`${c}/`));
}

function isBare(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function inScope(scope: string, file: string): string {
  return scope === "." ? file : `${scope}/${file}`;
}

type EdgeContext = {
  readonly scope: string;
  readonly from: string;
  readonly fromPlace: Place;
  readonly edge: ImportEdge;
  readonly zoning: ScopeZoning;
  readonly contracts: readonly string[];
};

function rulesViolation(ctx: EdgeContext, feature: string): BoundaryViolation | null {
  const { edge } = ctx;
  if (edge.target === null) {
    if (isBare(edge.specifier) && isContract(edge.specifier, ctx.contracts)) return null;
  } else {
    const to = placeOf(edge.target, ctx.zoning);
    if (to.kind === "feature" && to.feature === feature && to.zone.name === "rules") return null;
  }
  return {
    kind: "impure-rules",
    from: inScope(ctx.scope, ctx.from),
    feature,
    to: edge.target === null ? null : inScope(ctx.scope, edge.target),
    specifier: edge.specifier,
    typeOnly: edge.typeOnly,
  };
}

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
    case "impure-rules":
      return null;
    case "application-imports-adapter":
      return to.zone.entry.startsWith("adapters/") ? { kind, ...edge } : null;
    case "driving-reaches-driven":
      return to.zone.name === "application" || to.zone.name === "driven" ? { kind, ...edge } : null;
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
  const { fromPlace, edge } = ctx;
  if (fromPlace.kind === "feature" && fromPlace.zone.rule.imports === "impure-rules") {
    return rulesViolation(ctx, fromPlace.feature);
  }
  if (edge.target === null) return null;
  const to = placeOf(edge.target, ctx.zoning);
  return to.kind === "feature" ? crossingFrom(ctx, edge.target, to) : null;
}

type ModuleContext = {
  readonly scope: string;
  readonly module: BoundaryModule;
  readonly place: Place;
  readonly doors: Readonly<Record<string, readonly string[]>>;
};

function zoneDoor(ctx: ModuleContext, feature: string, door: string): ZoneDoor {
  return {
    from: inScope(ctx.scope, ctx.module.file),
    feature,
    to: null,
    specifier: door,
    typeOnly: false,
  };
}

// Inside `rules/` no door has an owner, so every use of any catalog door is the zone's own
// violation, once per door. A door module imported there is already an edge, judged above.
function globalsInRules(ctx: ModuleContext, feature: string): BoundaryViolation[] {
  const used = new Set(ctx.module.doorUses.map((use) => use.door));
  return [...used].map((door) => ({
    kind: "impure-rules",
    ...zoneDoor(ctx, feature, door),
    global: true,
  }));
}

// `application/` imports bare packages freely, so a door module it runs is judged here beside the
// doors it uses by name: every catalog door, declared or not, once per door.
function impureApplication(ctx: ModuleContext, feature: string): BoundaryViolation[] {
  return doorsOf(ctx.module).map((door) => ({
    kind: "impure-application",
    ...zoneDoor(ctx, feature, door),
  }));
}

// The declared doors a file uses or opens: a use belongs to the most specific declared door that is
// a path prefix of it.
function declaredDoorsUsed(ctx: ModuleContext): string[] {
  const declared = Object.keys(ctx.doors);
  if (declared.length === 0) return [];
  const moduleDoors = moduleDoorsOpened(ctx.module.importEdges, ctx.module.runtimeSpecifiers);
  const paths = [
    ...ctx.module.doorUses.map((use) => use.path),
    ...moduleDoors.map((door) => [door]),
  ];
  return [...new Set(paths.flatMap((path) => declaredDoorOf(path, declared) ?? []))];
}

// A declared door's use is a violation unless this file is one of that door's owners.
function outsideOwner(ctx: ModuleContext): BoundaryViolation[] {
  return declaredDoorsUsed(ctx)
    .filter((door) => !ctx.doors[door]?.includes(ctx.module.file))
    .map((door) => ({
      kind: "door-outside-owner",
      from: inScope(ctx.scope, ctx.module.file),
      to: null,
      specifier: door,
      typeOnly: false,
    }));
}

function doorViolations(ctx: ModuleContext): BoundaryViolation[] {
  const { place } = ctx;
  if (place.kind !== "feature") return outsideOwner(ctx);
  const rule = place.zone.rule.doors;
  switch (rule) {
    case "door-outside-owner":
      return outsideOwner(ctx);
    case "impure-rules":
      return globalsInRules(ctx, place.feature);
    case "impure-application":
      return impureApplication(ctx, place.feature);
    case "door-outside-driven-adapter":
      return declaredDoorsUsed(ctx).map((door) => ({
        kind: rule,
        ...zoneDoor(ctx, place.feature, door),
      }));
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

function unknownZone(scope: string, place: FeaturePlace): BoundaryViolation {
  return {
    kind: "unknown-zone",
    from: inScope(scope, `src/${place.feature}/${place.zone.entry}`),
    feature: place.feature,
    to: null,
    specifier: place.zone.entry,
    typeOnly: false,
  };
}

// Which `importedFrom` zone a file satisfies: a hexagonal feature's `adapters/driven/` is `driven`,
// and a file outside every feature is a `configurator`.
function libraryZoneOf(place: Place): ImportedFrom | null {
  return place.kind === "feature" ? place.zone.rule.libraryZone : "configurator";
}

type ScopeContext = {
  readonly scope: string;
  readonly rules: BoundaryRules;
  readonly zoning: ScopeZoning;
  readonly libraries: Libraries;
  readonly deployables: Deployables;
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
    owners: ctx.rules.bindingOwners[scope] ?? {},
  });
  const sites = module.bindingSites.map((site) => ({ file: from, ...site }));
  return { violations, sites };
}

function analyzeModule(ctx: ScopeContext, module: BoundaryModule, fromPlace: Place): Found {
  const { scope, rules, zoning, libraries } = ctx;
  const edges = module.importEdges.flatMap(
    (edge) =>
      violationOf({
        scope,
        from: module.file,
        fromPlace,
        edge,
        zoning,
        contracts: rules.contracts,
      }) ?? [],
  );
  const doors = doorViolations({
    scope,
    module,
    place: fromPlace,
    doors: rules.doors[scope] ?? {},
  });
  const file = { ...module, file: inScope(scope, module.file) };
  const judged = judgeLibraries(libraries, scope, file, libraryZoneOf(fromPlace));
  const across = acrossDeployables(ctx, module, fromPlace);
  return {
    violations: [...edges, ...doors, ...judged.violations, ...across.violations],
    unjudged: judged.unjudged,
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
  libraries: Libraries,
  deployables: Deployables,
): ScopeAnalysis {
  const zoning = scopeZoning(rules, scope);
  const ctx: ScopeContext = { scope, rules, zoning, libraries, deployables };
  const violations: BoundaryViolation[] = [];
  const sites: SiteRow[] = [];
  // One per entry, however many files sit under it.
  const unknownEntries = new Map<string, BoundaryViolation>();
  let unjudged = 0;
  for (const module of modules) {
    const fromPlace = placeOf(module.file, ctx.zoning);
    if (fromPlace.kind === "feature" && fromPlace.zone.name === "unknown") {
      const entry = unknownZone(scope, fromPlace);
      unknownEntries.set(entry.from, entry);
    }
    const found = analyzeModule(ctx, module, fromPlace);
    violations.push(...found.violations);
    sites.push(...found.sites);
    unjudged += found.unjudged;
  }
  violations.push(...unknownEntries.values(), ...undeclaredLibraries(libraries, scope));
  violations.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.from.localeCompare(b.from) ||
      a.specifier.localeCompare(b.specifier) ||
      Number(isDoorUse(a)) - Number(isDoorUse(b)),
  );
  const features = [...ctx.zoning.features].sort((a, b) => a.localeCompare(b));
  return {
    report: { scope, features, filesScanned: modules.length, violations },
    unjudged,
    sites,
  };
}
