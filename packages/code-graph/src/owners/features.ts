import fs from "node:fs";
import path from "node:path";
import type { BoundaryModule } from "../boundaries/analyze.js";
import { inScope, type Place } from "../boundaries/rules.js";
import type { TableContext } from "../boundaries/tables/judge.js";
import { type Access, reachOf } from "../boundaries/tables/reach.js";
import type { HexagonMember } from "../hexagon/ports.js";
import { readHexagon } from "../hexagon/read.js";
import { type Locus, locusOf } from "./locus.js";

// A file of the scope with the place it sits in, read once for every section of the view.
export type Placed = { readonly module: BoundaryModule; readonly place: Place };

// A file that reaches one table of the feature: how, from which file, and where that file sits.
export type FeatureReach = {
  readonly table: string;
  readonly access: Access;
  readonly file: string;
  readonly place: Locus;
};

// What a feature owns and who reaches into it: the tables its `adapters/driven/tables.ts` declares,
// every other file that reaches one of them, and the ports it offers (`commands`) and needs
// (`externalSystems`), as `--hexagon` prints them.
export type OwnedFeature = {
  readonly feature: string;
  readonly tables: readonly string[];
  readonly reach: readonly FeatureReach[];
  readonly commands: readonly HexagonMember[];
  readonly externalSystems: readonly HexagonMember[];
};

const byName = (a: string, b: string): number => a.localeCompare(b);

// Whether a reach row must name a table its owner declares. A write is the gate's own fact and is a
// table by being written. The others take any name imported from a tables file, which holds enums
// and schema objects too, so the owner's declaration says which are tables.
const NEEDS_A_DECLARED_TABLE = {
  write: false,
  "foreign-key": true,
  read: true,
} as const satisfies Record<Access, boolean>;

// The tables each feature declares: the names its tables file exports bound to a table.
function declaredTables(placed: readonly Placed[]): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();
  for (const { module, place } of placed) {
    if (place.kind !== "feature" || !place.zone.rule.declaresTables) continue;
    const names = declared.get(place.feature) ?? new Set<string>();
    for (const name of module.tableFacts.declared) names.add(name);
    declared.set(place.feature, names);
  }
  return declared;
}

// Every way a file reaches a table another feature owns, filed under the owner.
function reachByOwner(
  ctx: TableContext,
  placed: readonly Placed[],
  declared: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, FeatureReach[]> {
  const byOwner = new Map<string, FeatureReach[]>();
  for (const { module, place } of placed) {
    for (const { owner, table, access } of reachOf(ctx, module, place)) {
      if (NEEDS_A_DECLARED_TABLE[access] && declared.get(owner)?.has(table) !== true) continue;
      const rows = byOwner.get(owner) ?? [];
      rows.push({ table, access, file: inScope(ctx.scope, module.file), place: locusOf(place) });
      byOwner.set(owner, rows);
    }
  }
  for (const rows of byOwner.values()) {
    rows.sort((a, b) => byName(a.table, b.table) || byName(a.file, b.file));
  }
  return byOwner;
}

// The ports a feature offers and needs, as `--hexagon` reads them. A feature with no `ports.ts` has
// none, where the hexagon view refuses it.
function portsOf(
  repoRoot: string,
  scope: string,
  feature: string,
): Pick<OwnedFeature, "commands" | "externalSystems"> {
  const directory = path.join(repoRoot, scope, "src", feature);
  if (!fs.existsSync(path.join(directory, "ports.ts")))
    return { commands: [], externalSystems: [] };
  const { commands, externalSystems } = readHexagon(directory);
  return { commands, externalSystems };
}

// The features of a scope laid out per feature, by name; a port-layout scope has none to own a table.
export function featuresOf(
  ctx: TableContext,
  placed: readonly Placed[],
  repoRoot: string,
): OwnedFeature[] {
  const { scope, zoning } = ctx;
  if (zoning.layout !== "per-feature") return [];
  const declared = declaredTables(placed);
  const reach = reachByOwner(ctx, placed, declared);
  return [...zoning.features].sort(byName).map((feature) => ({
    feature,
    tables: [...(declared.get(feature) ?? [])].sort(byName),
    reach: reach.get(feature) ?? [],
    ...portsOf(repoRoot, scope, feature),
  }));
}
