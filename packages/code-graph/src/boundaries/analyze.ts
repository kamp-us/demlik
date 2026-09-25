import type { ImportEdge, ModuleNode } from "../schema.js";
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
    };

export type BoundaryKind = BoundaryViolation["kind"];

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

export function analyzeBoundaries(
  scope: string,
  modules: readonly ModuleNode[],
  rules: BoundaryRules,
): ScopeBoundaryReport {
  const features = rules.features[scope] ?? [];
  const layout: Layout = { features: new Set(features), lib: new Set(rules.lib) };
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
  }
  violations.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.from.localeCompare(b.from) ||
      a.specifier.localeCompare(b.specifier),
  );
  return {
    scope,
    features: [...features].sort((a, b) => a.localeCompare(b)),
    filesScanned: modules.length,
    violations,
  };
}
