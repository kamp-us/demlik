/**
 * The stability tier each published subpath carries, read from the one place it
 * is written: the tier table in `MAINTAINING.md`. `scripts/check-export-stamps.mjs`
 * holds that table to the export map; this reader hands the same rows to the
 * reference generator, so a page can never state a tier the table does not.
 */

export const TIERS = ["stable", "battery", "experimental"] as const;
export type Tier = (typeof TIERS)[number];

function isTier(x: string): x is Tier {
  return TIERS.some((t) => t === x);
}

/** A row of the tier table: `` | `./subpath` | tier | notes | ``. */
const ROW = /^\|\s*`(\.[^`]*)`\s*\|\s*([a-z]+)\s*\|.*\|\s*$/gm;

/** Parse `MAINTAINING.md` into its subpath → tier rows. */
export function parseTierTable(markdown: string): ReadonlyMap<string, Tier> {
  const tiers = new Map<string, Tier>();
  for (const [, subpath, tier] of markdown.matchAll(ROW)) {
    if (subpath !== undefined && tier !== undefined && isTier(tier)) {
      tiers.set(subpath, tier);
    }
  }
  return tiers;
}

/** The tier a subpath is stamped with; an unstamped subpath is an error. */
export function tierOf(
  tiers: ReadonlyMap<string, Tier>,
  subpath: string,
): Tier {
  const tier = tiers.get(subpath);
  if (tier === undefined) {
    throw new Error(
      `reference: subpath '${subpath}' has no row in MAINTAINING.md's tier table — add one before it gets a page`,
    );
  }
  return tier;
}
