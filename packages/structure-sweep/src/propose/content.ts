import { dirname, extname, join, normalize } from "node:path";
import { gatherEvidence, type SourceFile } from "../sweep/evidence.js";

/** How many terms the whole-scope term list keeps, most widespread first. */
export const MAX_TERMS = 60;
/** How many import clusters are listed, largest first. */
export const MAX_CLUSTERS = 30;
/** How many member files one listed cluster names; `size` still counts them all. */
export const MAX_CLUSTER_FILES = 12;
/** How many terms one listed cluster carries, most widespread in it first. */
export const MAX_CLUSTER_TERMS = 10;
/**
 * A file imported by more swept files than this is shared plumbing: its importers are not joined
 * through it, or one `utils` file would fold the whole scope into a single cluster.
 */
export const HUB_IMPORTERS = 8;
/** Label propagation stops after this many rounds even if a label still flips. */
const MAX_PROPAGATION_ROUNDS = 50;

/** A word from exported names, with how many files export a name holding it. */
export interface TermSignal {
  readonly term: string;
  readonly files: number;
}

/** Swept files more linked by relative imports to each other than to the rest: one unit of code, whatever its folders. */
export interface ImportClusterSignal {
  readonly size: number;
  /** At most `MAX_CLUSTER_FILES` members, in code-unit order of path. */
  readonly files: readonly string[];
  readonly terms: readonly string[];
}

/** What the code itself says, read from file content rather than from where the files sit. */
export interface ContentSignals {
  /** Swept files read under the scopes. */
  readonly files: number;
  readonly terms: readonly TermSignal[];
  /** Clusters of two or more files; `total` counts them all, `listed` the largest `MAX_CLUSTERS`. */
  readonly importClusters: {
    readonly total: number;
    readonly listed: readonly ImportClusterSignal[];
  };
}

/** Code-unit order: the same on every machine and locale, unlike `localeCompare`. */
export const byCodeUnit = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * The words in one identifier, lowercased: camelCase, PascalCase, snake_case and SCREAMING_CASE
 * split alike (`parseHTTPReply` → `parse`, `http`, `reply`). One-letter pieces carry no concept.
 */
export function identifierWords(name: string): string[] {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 1 && !/^\p{N}+$/u.test(word));
}

/** The name a relative specifier resolves against: extension and a trailing `/index` dropped. */
const moduleKey = (path: string) => {
  const normal = normalize(path);
  return normal
    .slice(0, normal.length - extname(normal).length)
    .replace(/\/index$/, "");
};

/** Terms ranked by how many of `perFile` hold them, then by code unit, cut to `max`. */
function rankTerms(
  perFile: readonly ReadonlySet<string>[],
  max: number,
): TermSignal[] {
  const counts = new Map<string, number>();
  for (const terms of perFile)
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || byCodeUnit(a, b))
    .slice(0, max)
    .map(([term, files]) => ({ term, files }));
}

/**
 * Communities of the undirected import graph, hubs' incoming edges left out, found by label
 * propagation (Raghavan, Albert & Kumara 2007): each file takes the label most of its neighbours
 * hold, until none changes. Files are visited in code-unit order and a tie goes to the smallest
 * label, so one graph always gives one answer. Plain connected components would not do: in a
 * well-linked package every file reaches every other, and the whole scope comes back as one group.
 */
function communities(
  paths: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const importers = new Map<string, number>();
  for (const targets of edges.values())
    for (const target of targets)
      importers.set(target, (importers.get(target) ?? 0) + 1);
  const links = new Map<string, Set<string>>(paths.map((p) => [p, new Set()]));
  for (const [from, targets] of edges)
    for (const to of targets) {
      if ((importers.get(to) ?? 0) > HUB_IMPORTERS) continue;
      links.get(from)?.add(to);
      links.get(to)?.add(from);
    }

  const label = new Map(paths.map((p) => [p, p]));
  for (let round = 0; round < MAX_PROPAGATION_ROUNDS; round++) {
    let changed = false;
    for (const path of paths) {
      const counts = new Map<string, number>();
      for (const next of links.get(path) ?? []) {
        const l = label.get(next) ?? next;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      const current = label.get(path) ?? path;
      const top = Math.max(0, ...counts.values());
      if (top === 0 || counts.get(current) === top) continue;
      const [best = current] = [...counts]
        .filter(([, n]) => n === top)
        .map(([l]) => l)
        .sort(byCodeUnit);
      label.set(path, best);
      changed = true;
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const l = label.get(path) ?? path;
    groups.set(l, [...(groups.get(l) ?? []), path]);
  }
  return [...groups.values()]
    .filter((members) => members.length > 1)
    .map((members) => members.sort(byCodeUnit));
}

/**
 * Terms and import clusters from the swept files' content, each file shown through `name`. Every
 * list is capped by a constant above, so the output stops growing with the file count.
 */
export function contentSignals(
  sources: readonly SourceFile[],
  name: (path: string) => string,
): ContentSignals {
  const files = [...sources].sort((a, b) => byCodeUnit(a.path, b.path));
  const evidence = gatherEvidence(files);
  const byKey = new Map<string, string>();
  for (const { path } of files)
    if (!byKey.has(moduleKey(path))) byKey.set(moduleKey(path), path);

  const terms = new Map<string, Set<string>>();
  const edges = new Map<string, string[]>();
  for (const { path } of files) {
    const { exports, imports } = evidence.get(path)?.file ?? {
      exports: [],
      imports: [],
    };
    terms.set(path, new Set(exports.flatMap(identifierWords)));
    const targets = imports.flatMap((spec) => {
      if (!spec.startsWith(".")) return [];
      const target = byKey.get(moduleKey(join(dirname(path), spec)));
      return target === undefined || target === path ? [] : [target];
    });
    edges.set(path, [...new Set(targets)]);
  }

  const clusters = communities(
    files.map((f) => f.path),
    edges,
  ).map((members) => {
    return {
      size: members.length,
      files: members.slice(0, MAX_CLUSTER_FILES).map(name),
      terms: rankTerms(
        members.map((m) => terms.get(m) ?? new Set()),
        MAX_CLUSTER_TERMS,
      ).map((t) => t.term),
    };
  });
  const listed = clusters
    .sort(
      (a, b) =>
        b.size - a.size || byCodeUnit(a.files[0] ?? "", b.files[0] ?? ""),
    )
    .slice(0, MAX_CLUSTERS);
  return {
    files: files.length,
    terms: rankTerms([...terms.values()], MAX_TERMS),
    importClusters: { total: clusters.length, listed },
  };
}
