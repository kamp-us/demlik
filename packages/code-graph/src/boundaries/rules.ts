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
  // Whether a file here may reach the outside world through a row of `IMPURE_GLOBALS`. Only the
  // driven zone may; an entry no zone names is judged as an entry (B10), not as impure.
  readonly mayBeImpure: boolean;
  // Whether another feature, and a file in no feature and no `lib` folder, may import a file here.
  readonly openToFeatures: boolean;
  readonly openToOutside: boolean;
  // The `importedFrom` zone a file here satisfies, for the libraries that name where they may be
  // imported from (B14): only the driven zone is one.
  readonly libraryZone: ImportedFrom | null;
  // Whether a worker binding may be used here (B17): only the driven zone may.
  readonly touchesBindings: boolean;
  // Whether this zone's file is the feature's entry file, which holds named re-exports and nothing
  // else (B15): only `index.ts` is.
  readonly exportsOnly: boolean;
  // The zones of the same feature this zone's files may import, every other import being judged
  // against an allowlist (B16), or null for a zone that has none: only the application zone has.
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

// The port layout has no `index.ts` for a file outside the hexagon to go through: the composition
// root imports its use cases and its ports as well as its adapters.
const PORT_ZONES = {
  ...HEXAGONAL_ZONES,
  ports: { ...HEXAGONAL_ZONES.ports, openToOutside: true },
  application: { ...HEXAGONAL_ZONES.application, openToOutside: true },
} as const satisfies Record<HexagonalZone, ZoneRule>;

// How a scope lays out its hexagon: one per feature folder (`src/<feature>/`), or one for the whole
// scope with its zones straight under `src/` (Cockburn's port shape).
type Layout = "per-feature" | "port";

type LayoutRow = {
  // Where the layout's files sit, as a message names it.
  readonly root: string;
  // Each zone's folder, or file, below the hexagon. A file is in the first zone whose folder it sits
  // under, so a folder inside another is listed before it.
  readonly zones: readonly (readonly [folder: string, zone: HexagonalZone])[];
  // The folders that hold adapters, whether or not a zone names the file inside: B6 judges an import
  // into one.
  readonly adapters: readonly string[];
  readonly rules: Record<HexagonalZone, ZoneRule>;
  // The hexagon a file `src/<top>/<rest>` sits in, and its path inside it.
  readonly place: (
    top: string,
    rest: readonly string[],
    scope: string,
  ) => { readonly feature: string; readonly inside: readonly string[] };
};

const LAYOUTS = {
  "per-feature": {
    root: "src/<feature>/",
    zones: [
      ["index.ts", "index"],
      ["ports.ts", "ports"],
      ["application", "application"],
      ["adapters/driving", "driving"],
      ["adapters/driven", "driven"],
    ],
    adapters: ["adapters"],
    rules: HEXAGONAL_ZONES,
    place: (top, rest) => ({ feature: top, inside: rest }),
  },
  port: {
    root: "src/",
    zones: [
      ["application/driving-ports", "ports"],
      ["application/driven-ports", "ports"],
      ["application", "application"],
      ["driving-adapters", "driving"],
      ["driven-adapters", "driven"],
    ],
    adapters: ["driving-adapters", "driven-adapters"],
    rules: PORT_ZONES,
    place: (top, rest, scope) => ({ feature: scope, inside: [top, ...rest] }),
  },
} as const satisfies Record<Layout, LayoutRow>;

// Where the driven zone sits in each layout, for the messages that refuse a file outside it.
export const DRIVEN_HOMES = Object.entries(LAYOUTS)
  .flatMap(([layout, { root, zones }]) =>
    zones
      .filter(([, zone]) => zone === "driven")
      .map(([folder]) => `${root}${folder}/ (${layout} layout)`),
  )
  .join(" or ");

const PORT_FOLDERS: ReadonlySet<string> = new Set(
  LAYOUTS.port.zones.flatMap(([folder]) => folder.split("/", 1)),
);

// A scope that lists a folder named for a port-layout zone is a port-layout scope.
function layoutOf(folders: readonly string[]): Layout {
  return folders.some((folder) => PORT_FOLDERS.has(folder)) ? "port" : "per-feature";
}

// Why a scope's `features` are both layouts at once, or null.
export function mixedLayoutIssue(scope: string, folders: readonly string[]): string | null {
  const port = folders.filter((folder) => PORT_FOLDERS.has(folder));
  const features = folders.filter((folder) => !PORT_FOLDERS.has(folder));
  if (port.length === 0 || features.length === 0) return null;
  return (
    `"features" in "${scope}" lists the port-layout folder(s) ${port.join(", ")} and the feature ` +
    `folder(s) ${features.join(", ")}: a scope is one layout, so list only ` +
    `${[...PORT_FOLDERS].join(", ")}, or only feature folders.`
  );
}

// `entry` is the zone's root below the hexagon: a file, or a folder.
type Zone = {
  readonly name: HexagonalZone;
  readonly entry: string;
  readonly rule: ZoneRule;
  readonly adapter: boolean;
};

function zoneOf(layout: Layout, inside: readonly string[]): Zone {
  const row: LayoutRow = LAYOUTS[layout];
  const [top = "", next] = inside;
  const adapter = inside.length > 1 && row.adapters.includes(top);
  const path = inside.join("/");
  const home = row.zones.find(([folder]) => path === folder || path.startsWith(`${folder}/`));
  if (home !== undefined) {
    const [entry, name] = home;
    return { name, entry, rule: row.rules[name], adapter };
  }
  const entry = adapter && next !== undefined ? `${top}/${next}` : top;
  return { name: "unknown", entry, rule: row.rules.unknown, adapter };
}

export type FeatureFile = { readonly feature: string; readonly zone: Zone };

export type ScopeZoning = {
  readonly layout: Layout;
  readonly scope: string;
  readonly features: ReadonlySet<string>;
  readonly lib: ReadonlySet<string>;
};

export function scopeZoning(rules: BoundaryRules, scope: string): ScopeZoning {
  const folders = rules.features[scope] ?? [];
  return {
    layout: layoutOf(folders),
    scope,
    features: new Set(folders),
    lib: new Set(rules.lib),
  };
}

// The feature a scope-relative file sits in and its zone there, or null outside every feature. A
// port-layout scope is one feature: the hexagon is the scope.
export function featureFileOf(file: string, zoning: ScopeZoning): FeatureFile | null {
  const [src, top, ...rest] = file.split("/");
  if (src !== "src" || top === undefined || rest.length === 0) return null;
  if (!zoning.features.has(top)) return null;
  const { feature, inside } = LAYOUTS[zoning.layout].place(top, rest, zoning.scope);
  return { feature, zone: zoneOf(zoning.layout, inside) };
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
