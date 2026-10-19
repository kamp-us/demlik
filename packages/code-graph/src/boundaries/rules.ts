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

// The zones the port layout places a file in. It has no `index` row, because there is no `index.ts`
// for a file outside the hexagon to go through, and no `unknown` row, because every file under its
// three folders is in a zone.
type PortZone = Exclude<HexagonalZone, "index" | "unknown">;

// A file outside the hexagon imports its use cases and its ports as well as its adapters.
const PORT_ZONES = {
  ports: { ...HEXAGONAL_ZONES.ports, openToOutside: true },
  application: { ...HEXAGONAL_ZONES.application, openToOutside: true },
  driving: HEXAGONAL_ZONES.driving,
  driven: HEXAGONAL_ZONES.driven,
} as const satisfies Record<PortZone, ZoneRule>;

// How a scope lays out its hexagon: one per feature folder (`src/<feature>/`), or one for the whole
// scope with its zones straight under `src/` (Cockburn's port shape).
type Layout = "per-feature" | "port";

type LayoutRow<Name extends HexagonalZone> = {
  // Where the layout's files sit, as a message names it.
  readonly root: string;
  // Each zone's folder, or file, below the hexagon. A file is in the first zone whose folder it sits
  // under, so a folder inside another is listed before it.
  readonly zones: readonly (readonly [folder: string, zone: Name])[];
  // The folders that hold adapters, whether or not a zone names the file inside: B6 judges an import
  // into one.
  readonly adapters: readonly string[];
  readonly rules: Record<Name, ZoneRule>;
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
  },
} as const satisfies { "per-feature": LayoutRow<HexagonalZone>; port: LayoutRow<PortZone> };

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

// Why a scope's `features` are not one whole layout, or null: they are both layouts at once, or they
// are the port layout with a folder left out, which would leave that folder's files unjudged.
export function layoutIssue(scope: string, folders: readonly string[]): string | null {
  const port = folders.filter((folder) => PORT_FOLDERS.has(folder));
  if (port.length === 0) return null;
  const features = folders.filter((folder) => !PORT_FOLDERS.has(folder));
  const whole = [...PORT_FOLDERS].join(", ");
  if (features.length > 0) {
    return (
      `"features" in "${scope}" lists the port-layout folder(s) ${port.join(", ")} and the feature ` +
      `folder(s) ${features.join(", ")}: a scope is one layout, so list only ${whole}, or only feature folders.`
    );
  }
  const left = [...PORT_FOLDERS].filter((folder) => !port.includes(folder));
  if (left.length === 0) return null;
  return (
    `"features" in "${scope}" lists the port-layout folder(s) ${port.join(", ")} and leaves out ` +
    `${left.join(", ")}: the port layout is one hexagon of ${whole}, so list all three, or only feature folders.`
  );
}

// Why a scope's `src/` holds a port-layout folder its `features` do not list, or null. `held` is the
// names of the entries directly under the scope's `src/`.
export function unlistedPortFolderIssue(
  scope: string,
  folders: readonly string[],
  held: readonly string[],
): string | null {
  const left = [...PORT_FOLDERS].filter(
    (folder) => held.includes(folder) && !folders.includes(folder),
  );
  if (left.length === 0) return null;
  return (
    `"features" in "${scope}" leaves out the port-layout folder(s) ${left.join(", ")} that ` +
    `${inScope(scope, "src")}/ holds: list ${[...PORT_FOLDERS].join(", ")} together, or rename the folder(s).`
  );
}

// `entry` is the zone's root below the hexagon: a file, or a folder.
type Zone<Name extends HexagonalZone = HexagonalZone> = {
  readonly name: Name;
  readonly entry: string;
  readonly rule: ZoneRule;
  readonly adapter: boolean;
};

function inAdapters(
  row: { readonly adapters: readonly string[] },
  inside: readonly string[],
): boolean {
  return inside.length > 1 && row.adapters.includes(inside[0] ?? "");
}

// The zone a path below the hexagon is in, or null when no folder the layout lists holds it.
function zoneIn<Name extends HexagonalZone>(
  row: LayoutRow<Name>,
  inside: readonly string[],
): Zone<Name> | null {
  const path = inside.join("/");
  const home = row.zones.find(([folder]) => path === folder || path.startsWith(`${folder}/`));
  if (home === undefined) return null;
  const [entry, name] = home;
  return { name, entry, rule: row.rules[name], adapter: inAdapters(row, inside) };
}

// A per-feature entry no zone names: a file or folder directly under the feature (B10), or under its
// `adapters/`. Only this layout has them; a port scope lists all three of its folders, and each holds
// every file below it.
function unknownEntry(inside: readonly string[]): Zone {
  const [top = "", next] = inside;
  const adapter = inAdapters(LAYOUTS["per-feature"], inside);
  const entry = adapter && next !== undefined ? `${top}/${next}` : top;
  return { name: "unknown", entry, rule: HEXAGONAL_ZONES.unknown, adapter };
}

// A file in a hexagon, and the zone it is in. The layout tags it: a port scope's zones never include
// `index` or `unknown`.
export type FeatureFile =
  | { readonly layout: "per-feature"; readonly feature: string; readonly zone: Zone }
  | { readonly layout: "port"; readonly feature: string; readonly zone: Zone<PortZone> };

// The hexagon a file `src/<top>/<rest>` sits in, by layout. A port-layout scope is one hexagon, the
// scope, and its path inside it starts at `top`.
const FILE_OF = {
  "per-feature": (top, rest) => ({
    layout: "per-feature",
    feature: top,
    zone: zoneIn(LAYOUTS["per-feature"], rest) ?? unknownEntry(rest),
  }),
  port: (top, rest, scope) => {
    const zone = zoneIn(LAYOUTS.port, [top, ...rest]);
    return zone === null ? null : { layout: "port", feature: scope, zone };
  },
} as const satisfies Record<
  Layout,
  (top: string, rest: readonly string[], scope: string) => FeatureFile | null
>;

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

// The feature a scope-relative file sits in and its zone there, or null outside every feature.
export function featureFileOf(file: string, zoning: ScopeZoning): FeatureFile | null {
  const [src, top, ...rest] = file.split("/");
  if (src !== "src" || top === undefined || rest.length === 0) return null;
  if (!zoning.features.has(top)) return null;
  return FILE_OF[zoning.layout](top, rest, zoning.scope);
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
