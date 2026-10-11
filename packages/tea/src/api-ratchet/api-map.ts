/**
 * tea's published-API map: every export subpath with the source file it is
 * built from and the tier it is stamped with. It is the input
 * `@demlik/code-graph/api` asks its caller for, and every cell is READ from the
 * file that already states it:
 *
 *   - the subpaths: `package.json` `exports`, bar `./package.json` and `*.css`
 *   - the source entry: `tsup.config.ts` `entry`, whose key is the file tsup
 *     writes under its out folder, so an export's `import` target names its key
 *   - the tier: `MAINTAINING.md`'s tier table, through the one reader the
 *     reference generator uses
 *
 * A subpath one of them does not cover is an error here, never a guess.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tsupConfig from "../../tsup.config";
import { parseTierTable, type Tier } from "../docs/reference/tier-table";

export const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export type ExportTarget = string | { readonly import?: string };

export type ApiMapSources = {
  /** `package.json` `exports`. */
  readonly exports: Readonly<Record<string, ExportTarget>>;
  /** tsup's `entry`: the file it writes, without extension → its source. */
  readonly entries: Readonly<Record<string, string>>;
  /** tsup's out folder, relative to the package root. */
  readonly outDir: string;
  /** Subpath → tier, as the tier table stamps it. */
  readonly tiers: ReadonlyMap<string, Tier>;
};

export type TeaApiMap = Readonly<
  Record<string, { readonly entry: string; readonly tier: Tier }>
>;

/** Metadata passthrough and assets carry no API, so they are not subpaths. */
const isApiSubpath = (subpath: string): boolean =>
  subpath !== "./package.json" && !subpath.endsWith(".css");

/** The tsup entry key an export target was built from: `./dist/a/index.js` → `a/index`. */
function entryKey(target: ExportTarget, outDir: string): string | undefined {
  const built = typeof target === "string" ? target : target.import;
  const prefix = `./${outDir}/`;
  if (built === undefined || !built.startsWith(prefix)) return undefined;
  return built.slice(prefix.length).replace(/\.js$/, "");
}

/**
 * Join the three sources into the map. Throws naming every subpath with no tier
 * row and every subpath whose export target no tsup entry builds.
 */
export function buildApiMap(sources: ApiMapSources): TeaApiMap {
  const map: Record<string, { entry: string; tier: Tier }> = {};
  const unstamped: string[] = [];
  const unbuilt: string[] = [];
  for (const [subpath, target] of Object.entries(sources.exports)) {
    if (!isApiSubpath(subpath)) continue;
    const tier = sources.tiers.get(subpath);
    const key = entryKey(target, sources.outDir);
    const entry =
      key !== undefined && Object.hasOwn(sources.entries, key)
        ? sources.entries[key]
        : undefined;
    if (tier === undefined) unstamped.push(subpath);
    if (entry === undefined) unbuilt.push(subpath);
    if (tier !== undefined && entry !== undefined) {
      map[subpath] = { entry, tier };
    }
  }
  const problems = [
    ...unstamped.map((s) => `  ${s} has no row in MAINTAINING.md's tier table`),
    ...unbuilt.map(
      (s) => `  ${s} has no entry in tsup.config.ts that builds its target`,
    ),
  ];
  if (problems.length > 0) {
    throw new Error(
      `api-ratchet: the export map names subpaths the API map cannot place:\n${problems.join("\n")}`,
    );
  }
  return map;
}

/** tsup's `entry` and out folder, as `tsup.config.ts` states them. */
function tsupEntries(): Pick<ApiMapSources, "entries" | "outDir"> {
  if (typeof tsupConfig === "function" || Array.isArray(tsupConfig)) {
    throw new Error(
      "api-ratchet: tsup.config.ts must export one options object",
    );
  }
  const { entry, outDir = "dist" } = tsupConfig;
  if (entry === undefined || Array.isArray(entry)) {
    throw new Error(
      "api-ratchet: tsup.config.ts `entry` must map each built file to its source",
    );
  }
  return { entries: entry, outDir };
}

/** The API map of the package as it stands on disk. */
export function readApiMap(): TeaApiMap {
  const read = (file: string): string =>
    readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const pkg = JSON.parse(read("package.json")) as {
    exports: Readonly<Record<string, ExportTarget>>;
  };
  return buildApiMap({
    exports: pkg.exports,
    ...tsupEntries(),
    tiers: parseTierTable(read("MAINTAINING.md")),
  });
}
