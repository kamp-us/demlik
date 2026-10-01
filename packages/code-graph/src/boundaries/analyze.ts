import type { ImportEdge, ModuleNode } from "../schema.js";
import type { DoorUse } from "./door-uses.js";
import { declaredDoorOf, moduleDoorsOpened } from "./doors.js";
import type { BoundaryRules } from "./rules.js";

type Place =
  | { readonly kind: "feature"; readonly feature: string; readonly zone: FeatureZone }
  | { readonly kind: "lib" }
  | { readonly kind: "elsewhere" };

type FeatureZone = "index" | "rules" | "internal";

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
    };

export type BoundaryKind = BoundaryViolation["kind"];

// What `boundary-ceilings.json` never counted: a world door used by name, an import edge it is not.
export function isDoorUse(entry: { readonly kind: BoundaryKind; readonly global?: true }): boolean {
  return entry.kind === "door-outside-owner" || entry.global === true;
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

type Layout = {
  readonly features: ReadonlySet<string>;
  readonly lib: ReadonlySet<string>;
};

function zoneOf(rest: readonly string[]): FeatureZone {
  if (rest.length === 1 && rest[0] === "index.ts") return "index";
  if (rest.length > 1 && rest[0] === "rules") return "rules";
  return "internal";
}

function placeOf(file: string, layout: Layout): Place {
  const [src, folder, ...rest] = file.split("/");
  if (src !== "src" || folder === undefined || rest.length === 0) return { kind: "elsewhere" };
  if (layout.features.has(folder)) return { kind: "feature", feature: folder, zone: zoneOf(rest) };
  if (layout.lib.has(folder)) return { kind: "lib" };
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
  readonly layout: Layout;
  readonly contracts: readonly string[];
};

function rulesViolation(ctx: EdgeContext, feature: string): BoundaryViolation | null {
  const { edge } = ctx;
  if (edge.target === null) {
    if (isBare(edge.specifier) && isContract(edge.specifier, ctx.contracts)) return null;
  } else {
    const to = placeOf(edge.target, ctx.layout);
    if (to.kind === "feature" && to.feature === feature && to.zone === "rules") return null;
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

type FeaturePlace = Extract<Place, { readonly kind: "feature" }>;

function crossingOf(ctx: EdgeContext, target: string, to: FeaturePlace): BoundaryViolation | null {
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
      if (to.feature === fromPlace.feature || to.zone === "index") return null;
      return { kind: "cross-feature", fromFeature: fromPlace.feature, ...crossing };
    case "lib":
      return { kind: "lib-imports-feature", ...crossing };
    case "elsewhere":
      if (to.zone === "index") return null;
      return { kind: "outside-imports-feature-internal", ...crossing };
    default: {
      const exhaustive: never = fromPlace;
      return exhaustive;
    }
  }
}

function violationOf(ctx: EdgeContext): BoundaryViolation | null {
  const { fromPlace, edge } = ctx;
  if (fromPlace.kind === "feature" && fromPlace.zone === "rules") {
    return rulesViolation(ctx, fromPlace.feature);
  }
  if (edge.target === null) return null;
  const to = placeOf(edge.target, ctx.layout);
  return to.kind === "feature" ? crossingOf(ctx, edge.target, to) : null;
}

type ModuleContext = {
  readonly scope: string;
  readonly module: BoundaryModule;
  readonly place: Place;
  readonly doors: Readonly<Record<string, readonly string[]>>;
};

// Inside `rules/` no door has an owner, so every use of any catalog door is the zone's own
// violation, once per door. A door module imported there is already an edge, judged above.
function globalsInRules(ctx: ModuleContext, feature: string): BoundaryViolation[] {
  const used = new Set(ctx.module.doorUses.map((use) => use.door));
  return [...used].map((door) => ({
    kind: "impure-rules",
    from: inScope(ctx.scope, ctx.module.file),
    feature,
    to: null,
    specifier: door,
    typeOnly: false,
    global: true,
  }));
}

// Anywhere else only a declared door is policed: a use belongs to the most specific declared door
// that is a path prefix of it, and is a violation unless this file is one of that door's owners.
function outsideOwner(ctx: ModuleContext): BoundaryViolation[] {
  const declared = Object.keys(ctx.doors);
  if (declared.length === 0) return [];
  const moduleDoors = moduleDoorsOpened(ctx.module.importEdges, ctx.module.runtimeSpecifiers);
  const paths = [
    ...ctx.module.doorUses.map((use) => use.path),
    ...moduleDoors.map((door) => [door]),
  ];
  const doors = new Set(paths.flatMap((path) => declaredDoorOf(path, declared) ?? []));
  return [...doors]
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
  if (place.kind === "feature" && place.zone === "rules") return globalsInRules(ctx, place.feature);
  return outsideOwner(ctx);
}

export function analyzeBoundaries(
  scope: string,
  modules: readonly BoundaryModule[],
  rules: BoundaryRules,
): ScopeBoundaryReport {
  const features = rules.features[scope] ?? [];
  const layout: Layout = { features: new Set(features), lib: new Set(rules.lib) };
  const doors = rules.doors[scope] ?? {};
  const violations: BoundaryViolation[] = [];
  for (const module of modules) {
    const fromPlace = placeOf(module.file, layout);
    for (const edge of module.importEdges) {
      const found = violationOf({
        scope,
        from: module.file,
        fromPlace,
        edge,
        layout,
        contracts: rules.contracts,
      });
      if (found !== null) violations.push(found);
    }
    violations.push(...doorViolations({ scope, module, place: fromPlace, doors }));
  }
  violations.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.from.localeCompare(b.from) ||
      a.specifier.localeCompare(b.specifier) ||
      Number(isDoorUse(a)) - Number(isDoorUse(b)),
  );
  return {
    scope,
    features: [...features].sort((a, b) => a.localeCompare(b)),
    filesScanned: modules.length,
    violations,
  };
}
