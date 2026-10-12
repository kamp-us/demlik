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
 *
 * The three files are read from the package root the caller names, so one
 * reader serves both sides of the ratchet: the working tree, and the base
 * commit's tree, where a subpath the pull request deleted still has its
 * `exports` key, its build entry and its tier row.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const isRecord = (x: unknown): x is Readonly<Record<string, unknown>> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isEntries = (x: unknown): x is Readonly<Record<string, string>> =>
  isRecord(x) && Object.values(x).every((source) => typeof source === "string");

/**
 * tsup's `entry` and out folder, as the `tsup.config.ts` under `root` states
 * them. The config is code, so it is imported from that root: the base tree's
 * copy is the one that still names a deleted subpath's build entry.
 */
async function tsupEntries(
  root: string,
): Promise<Pick<ApiMapSources, "entries" | "outDir">> {
  const file = pathToFileURL(join(root, "tsup.config.ts")).href;
  const config: unknown = ((await import(file)) as { default?: unknown })
    .default;
  if (!isRecord(config)) {
    throw new Error(
      "api-ratchet: tsup.config.ts must export one options object",
    );
  }
  const { entry, outDir = "dist" } = config;
  if (!isEntries(entry) || typeof outDir !== "string") {
    throw new Error(
      "api-ratchet: tsup.config.ts `entry` must map each built file to its source",
    );
  }
  return { entries: entry, outDir };
}

/** The API map of the package as it stands under `root`. */
export async function readApiMap(root: string = PKG_ROOT): Promise<TeaApiMap> {
  const read = (file: string): string => readFileSync(join(root, file), "utf8");
  const pkg = JSON.parse(read("package.json")) as {
    exports: Readonly<Record<string, ExportTarget>>;
  };
  return buildApiMap({
    exports: pkg.exports,
    ...(await tsupEntries(root)),
    tiers: parseTierTable(read("MAINTAINING.md")),
  });
}
