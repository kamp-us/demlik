import type { ImportEdge, ModuleNode } from "../schema.js";
import type { DoorUse } from "./door-uses.js";
import { declaredDoorOf, moduleDoorsOpened } from "./doors.js";
import {
  type BoundaryRules,
  type FeatureFile,
  featureFileOf,
  type ScopeZoning,
  scopeZoning,
} from "./rules.js";

type FeaturePlace = { readonly kind: "feature" } & FeatureFile;

type Place = FeaturePlace | { readonly kind: "lib" } | { readonly kind: "elsewhere" };

// An import of a file of the importer's own feature, judged by the importer's zone.
type ZoneEdge = {
  readonly from: string;
  readonly feature: string;
  readonly to: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
};

// A world door used in a zone that judges it itself: `specifier` is the door.
type ZoneDoor = {
  readonly from: string;
  readonly feature: string;
  readonly to: null;
  readonly specifier: string;
  readonly typeOnly: false;
};

export type BoundaryViolation =
  | {
      readonly kind: "cross-feature";
      readonly from: string;
      readonly fromFeature: string;
      readonly to: string;
      readonly toFeature: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      readonly kind: "impure-rules";
      readonly from: string;
      readonly feature: string;
      readonly to: string | null;
      readonly specifier: string;
      readonly typeOnly: boolean;
      // A world door read by name (`process.env`, `fetch`), not an import. `specifier` is then the
      // door, which an import of a package of that name must not collide with.
      readonly global?: true;
    }
  | {
      readonly kind: "lib-imports-feature";
      readonly from: string;
      readonly to: string;
      readonly toFeature: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      readonly kind: "outside-imports-feature-internal";
      readonly from: string;
      readonly to: string;
      readonly toFeature: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      readonly kind: "door-outside-owner";
      readonly from: string;
      readonly to: null;
      readonly specifier: string;
      readonly typeOnly: false;
    }
  | ({ readonly kind: "application-imports-adapter" } & ZoneEdge)
  | ({ readonly kind: "impure-application" } & ZoneDoor)
  | ({ readonly kind: "driving-reaches-driven" } & ZoneEdge)
  | ({ readonly kind: "door-outside-driven-adapter" } & ZoneDoor)
  | {
      // An entry of a hexagonal feature that no zone names: `from` is the entry's own path and
      // `specifier` the entry below the feature (`domain`, `adapters/shared`, `helpers.ts`).
      readonly kind: "unknown-zone";
      readonly from: string;
      readonly feature: string;
      readonly to: null;
      readonly specifier: string;
      readonly typeOnly: false;
    };

export type BoundaryKind = BoundaryViolation["kind"];

// What a crossing is: an import edge, a world door used by name or opened, or a feature's entry.
type Crossing = "import" | "door" | "entry";

const CROSSINGS = {
  "application-imports-adapter": "import",
  "cross-feature": "import",
  "door-outside-driven-adapter": "door",
  "door-outside-owner": "door",
  "driving-reaches-driven": "import",
  "impure-application": "door",
  "impure-rules": "import",
  "lib-imports-feature": "import",
  "outside-imports-feature-internal": "import",
  "unknown-zone": "entry",
} as const satisfies Record<BoundaryKind, Crossing>;

// A `global` impure-rules entry is a door read by name, not the import its kind otherwise is.
export function crossingOf(entry: {
  readonly kind: BoundaryKind;
  readonly global?: true;
}): Crossing {
  return entry.global === true ? "door" : CROSSINGS[entry.kind];
}

// What `boundary-ceilings.json` never counted: a world door used by name, an import edge it is not.
export function isDoorUse(entry: { readonly kind: BoundaryKind; readonly global?: true }): boolean {
  return crossingOf(entry) === "door";
}

export type BoundaryModule = Pick<ModuleNode, "file" | "importEdges"> & {
  readonly doorUses: readonly DoorUse[];
  // The specifiers the file opens when it runs. `importEdges` is the graph's and keeps a type-only
  // `import { type Stats }` as a value import; a module door asks this.
  readonly runtimeSpecifiers: ReadonlySet<string>;
};

export type ScopeBoundaryReport = {
  readonly scope: string;
  readonly features: readonly string[];
  readonly filesScanned: number;
  readonly violations: readonly BoundaryViolation[];
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
  const { doorUses, importEdges, runtimeSpecifiers } = ctx.module;
  const used = new Set([
    ...doorUses.map((use) => use.door),
    ...moduleDoorsOpened(importEdges, runtimeSpecifiers),
  ]);
  return [...used].map((door) => ({ kind: "impure-application", ...zoneDoor(ctx, feature, door) }));
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

export function analyzeBoundaries(
  scope: string,
  modules: readonly BoundaryModule[],
  rules: BoundaryRules,
): ScopeBoundaryReport {
  const zoning = scopeZoning(rules, scope);
  const doors = rules.doors[scope] ?? {};
  const violations: BoundaryViolation[] = [];
  // One per entry, however many files sit under it.
  const unknownEntries = new Map<string, BoundaryViolation>();
  for (const module of modules) {
    const fromPlace = placeOf(module.file, zoning);
    if (fromPlace.kind === "feature" && fromPlace.zone.name === "unknown") {
      const entry = unknownZone(scope, fromPlace);
      unknownEntries.set(entry.from, entry);
    }
    for (const edge of module.importEdges) {
      const found = violationOf({
        scope,
        from: module.file,
        fromPlace,
        edge,
        zoning,
        contracts: rules.contracts,
      });
      if (found !== null) violations.push(found);
    }
    violations.push(...doorViolations({ scope, module, place: fromPlace, doors }));
  }
  violations.push(...unknownEntries.values());
  violations.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.from.localeCompare(b.from) ||
      a.specifier.localeCompare(b.specifier) ||
      Number(isDoorUse(a)) - Number(isDoorUse(b)),
  );
  return {
    scope,
    features: [...zoning.features].sort((a, b) => a.localeCompare(b)),
    filesScanned: modules.length,
    violations,
  };
}
