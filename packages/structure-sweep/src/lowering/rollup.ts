import type { Fact } from "./fact.js";
import { type Responsibility, verdictOf } from "./responsibility.js";

/**
 * How many functions of one file or folder serve one feature, do not serve it, and are `unknown`
 * for it. `unknown` is its own count: an abstained or undetermined verdict is never read as either
 * answer.
 */
export interface FeatureCounts {
  readonly serves: number;
  readonly doesNotServe: number;
  readonly unknown: number;
}

/** One file or folder, with its counts per feature, features in key order. */
export interface RollupRow {
  readonly path: string;
  readonly features: Readonly<Record<string, FeatureCounts>>;
}

/**
 * The responsibility facts rolled up to files and folders. A folder's counts are the sums over every
 * file beneath it; `.` is the root. Rows are in path order.
 */
export interface Rollup {
  readonly files: readonly RollupRow[];
  readonly folders: readonly RollupRow[];
}

type Counts = { serves: number; doesNotServe: number; unknown: number };

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every folder a file sits under, nearest first, ending at the root `.`. */
function foldersOf(file: string): readonly string[] {
  const parts = file.split("/").slice(0, -1);
  const out: string[] = [];
  for (let n = parts.length; n > 0; n--) out.push(parts.slice(0, n).join("/"));
  out.push(".");
  return out;
}

function add(
  rows: Map<string, Map<string, Counts>>,
  path: string,
  feature: string,
  field: keyof Counts,
): void {
  const features = rows.get(path) ?? new Map<string, Counts>();
  rows.set(path, features);
  const counts = features.get(feature) ?? {
    serves: 0,
    doesNotServe: 0,
    unknown: 0,
  };
  features.set(feature, counts);
  counts[field] += 1;
}

const toRows = (rows: Map<string, Map<string, Counts>>): readonly RollupRow[] =>
  [...rows.keys()].sort(byKey).map((path) => {
    const features = rows.get(path) ?? new Map<string, Counts>();
    return {
      path,
      features: Object.fromEntries(
        [...features.keys()]
          .sort(byKey)
          .map((feature) => [feature, { ...features.get(feature) }]),
      ) as Record<string, FeatureCounts>,
    };
  });

/**
 * Roll per-function responsibility facts up to their files and folders, with no Jev call. The file
 * is the fact's span; the order of `facts` does not change the result. A (function, feature) pair
 * that appears twice is refused, since counting it twice would overstate the feature.
 */
export function rollup(facts: readonly Fact<Responsibility>[]): Rollup {
  const files = new Map<string, Map<string, Counts>>();
  const folders = new Map<string, Map<string, Counts>>();
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.value._tag !== "known")
      throw new TypeError(
        `responsibility fact ${fact.id} carries no record; the stage always writes one`,
      );
    const record = fact.value.value;
    const pair = `${record.function}\u0000${record.feature}`;
    if (seen.has(pair))
      throw new RangeError(
        `${record.function} has two facts for feature "${record.feature}"`,
      );
    seen.add(pair);
    const verdict = verdictOf(record);
    const field: keyof Counts =
      verdict._tag === "unknown"
        ? "unknown"
        : verdict.value === "serves"
          ? "serves"
          : "doesNotServe";
    add(files, fact.span.file, record.feature, field);
    for (const folder of foldersOf(fact.span.file))
      add(folders, folder, record.feature, field);
  }
  return { files: toRows(files), folders: toRows(folders) };
}
