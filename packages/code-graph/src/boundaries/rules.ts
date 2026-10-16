import { z } from "zod";
import { DEPLOYABLE_KEYS } from "./deployables/schema.js";
import { type ImportedFrom, LIBRARY_KEYS } from "./libraries/schema.js";
import { SHAPE_KEYS } from "./shape/schema.js";

// The per-scope count file the ledger replaced. `--boundaries --migrate-ceilings` reads it once,
// and the gate refuses to run while it stands without a ledger.
export const LEGACY_CEILINGS_FILENAME = "boundary-ceilings.json";

const FolderSchema = z
  .string()
  .min(1)
  .regex(/^[^/]+$/, "a top-level folder under src/, not a path");

export const BoundaryRulesSchema = z
  .object({
    features: z.record(z.string().min(1), z.array(FolderSchema).min(1)).default({}),
    lib: z.array(FolderSchema).default(["lib"]),
    ...LIBRARY_KEYS,
    ...DEPLOYABLE_KEYS,
    ...SHAPE_KEYS,
  })
  .strict();
export type BoundaryRules = z.infer<typeof BoundaryRulesSchema>;

// What a zone's own imports are judged as, past B1: an edge into a zone of the same feature.
type ImportRule = "application-imports-adapter" | "driving-reaches-driven" | null;

type ZoneRule = {
  readonly imports: ImportRule;
  // Whether a file here may reach the outside world through a row of `IMPURE_GLOBALS`. Only
  // `adapters/driven/` may; an entry no zone names is judged as an entry (B10), not as impure.
  readonly mayBeImpure: boolean;
  // Whether another feature, and a file in no feature and no `lib` folder, may import a file here.
  readonly openToFeatures: boolean;
  readonly openToOutside: boolean;
  // The `importedFrom` zone a file here satisfies, for the libraries that name where they may be
  // imported from (B14): only `adapters/driven/` is one.
  readonly libraryZone: ImportedFrom | null;
  // Whether a worker binding may be used here (B17): only `adapters/driven/` may.
  readonly touchesBindings: boolean;
  // Whether this zone's file is the feature's entry file, which holds named re-exports and nothing
  // else (B15): only `index.ts` is.
  readonly exportsOnly: boolean;
  // The zones of the same feature this zone's files may import, every other import being judged
  // against an allowlist (B16), or null for a zone that has none: only `application/` has.
  readonly importAllowlist: readonly string[] | null;
};

const CLOSED = {
  imports: null,
  mayBeImpure: true,
  openToFeatures: false,
  openToOutside: false,
  libraryZone: null,
  touchesBindings: false,
  exportsOnly: false,
  importAllowlist: null,
} as const satisfies ZoneRule;

// The outside world may wire up a feature's adapters (the composition root), never its core.
const HEXAGONAL_ZONES = {
  index: {
    ...CLOSED,
    mayBeImpure: false,
    openToFeatures: true,
    openToOutside: true,
    exportsOnly: true,
  },
  ports: { ...CLOSED, mayBeImpure: false },
  application: {
    ...CLOSED,
    imports: "application-imports-adapter",
    mayBeImpure: false,
    importAllowlist: ["ports", "application"],
  },
  driving: {
    ...CLOSED,
    imports: "driving-reaches-driven",
    mayBeImpure: false,
    openToOutside: true,
  },
  driven: { ...CLOSED, openToOutside: true, libraryZone: "driven", touchesBindings: true },
  unknown: CLOSED,
} as const satisfies Record<string, ZoneRule>;

type HexagonalZone = keyof typeof HEXAGONAL_ZONES;

// `entry` is the zone's root below `src/<feature>/`: the top-level entry, or `adapters/<entry>`.
type Zone = {
  readonly name: HexagonalZone;
  readonly entry: string;
  readonly rule: ZoneRule;
};

const HEXAGONAL_FILES: ReadonlyMap<string, HexagonalZone> = new Map([
  ["index.ts", "index"],
  ["ports.ts", "ports"],
]);

function hexagonalZone(rest: readonly string[]): { name: HexagonalZone; entry: string } {
  const [top = "", sub = ""] = rest;
  if (rest.length === 1) return { name: HEXAGONAL_FILES.get(top) ?? "unknown", entry: top };
  if (top === "application") return { name: "application", entry: top };
  if (top !== "adapters") return { name: "unknown", entry: top };
  const entry = `${top}/${sub}`;
  if (rest.length > 2 && (sub === "driving" || sub === "driven")) return { name: sub, entry };
  return { name: "unknown", entry };
}

function zoneOf(rest: readonly string[]): Zone {
  const { name, entry } = hexagonalZone(rest);
  return { name, entry, rule: HEXAGONAL_ZONES[name] };
}

export type FeatureFile = { readonly feature: string; readonly zone: Zone };

export type ScopeZoning = {
  readonly features: ReadonlySet<string>;
  readonly lib: ReadonlySet<string>;
};

export function scopeZoning(rules: BoundaryRules, scope: string): ScopeZoning {
  return {
    features: new Set(rules.features[scope] ?? []),
    lib: new Set(rules.lib),
  };
}

// The feature a scope-relative file sits in and its zone there, or null outside every feature.
export function featureFileOf(file: string, zoning: ScopeZoning): FeatureFile | null {
  const [src, feature, ...rest] = file.split("/");
  if (src !== "src" || feature === undefined || rest.length === 0) return null;
  if (!zoning.features.has(feature)) return null;
  return { feature, zone: zoneOf(rest) };
}

export type FeaturePlace = { readonly kind: "feature" } & FeatureFile;

// Where a scope-relative file sits: in a feature, in a `lib` folder, or elsewhere in the scope.
export type Place = FeaturePlace | { readonly kind: "lib" } | { readonly kind: "elsewhere" };

export function placeOf(file: string, zoning: ScopeZoning): Place {
  const inFeature = featureFileOf(file, zoning);
  if (inFeature !== null) return { kind: "feature", ...inFeature };
  const [src, folder, ...rest] = file.split("/");
  if (src === "src" && folder !== undefined && rest.length > 0 && zoning.lib.has(folder)) {
    return { kind: "lib" };
  }
  return { kind: "elsewhere" };
}

// A scope-relative file as the ledger writes it, repo-relative.
export function inScope(scope: string, file: string): string {
  return scope === "." ? file : `${scope}/${file}`;
}
