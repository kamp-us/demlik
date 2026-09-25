import { posix } from "node:path";
import { git, trackedPaths } from "../git.js";
import { isSweptSource } from "../sweep/evidence.js";
import { type Graph, repoPathOf } from "../sweep/graph.js";

/** How many folder levels below each scope `propose` lists by default. */
export const DEFAULT_DEPTH = 3;

/** A folder under a scope, with the number of files `sweep` would ask about beneath it. */
export interface DirectorySignal {
  readonly path: string;
  readonly files: number;
}

export interface PackageSignal {
  /** The folder holding the `package.json`; `""` for the repository root. */
  readonly path: string;
  readonly name: string;
}

/** A code-graph cluster that spans several folders: one concept the layout has not named. */
export interface ClusterSignal {
  readonly id: string;
  readonly dirs: readonly string[];
}

export interface GraphSignals {
  /** `null` when no graph passed was built with `code-graph --clusters`. */
  readonly clusters: readonly ClusterSignal[] | null;
  /** `service.method` for every cross-runtime call (RPC, GraphQL), deduplicated. */
  readonly crossRuntime: readonly string[];
}

/** Everything `propose` read, in a fixed order, so one checkout always gives the same bytes. */
export interface ProposeSignals {
  readonly ref: string;
  readonly scopes: readonly string[];
  readonly depth: number;
  readonly directories: readonly DirectorySignal[];
  readonly packages: readonly PackageSignal[];
  /** `null` when no `--graph` was passed. */
  readonly graph: GraphSignals | null;
}

export interface SignalsInput {
  readonly root: string;
  readonly ref: string;
  readonly scopes: readonly string[];
  readonly depth: number;
  readonly graphs: readonly Graph[];
}

/** Code-unit order: the same on every machine and locale, unlike `localeCompare`. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function directorySignals(
  paths: readonly string[],
  scopes: readonly string[],
  depth: number,
): DirectorySignal[] {
  const counts = new Map<string, number>();
  for (const scope of scopes) {
    for (const path of paths) {
      if (!path.startsWith(`${scope}/`) || !isSweptSource(path)) continue;
      const below = posix.dirname(path.slice(scope.length + 1));
      if (below === ".") continue;
      const segments = below.split("/").slice(0, depth);
      for (let n = 1; n <= segments.length; n++) {
        const dir = `${scope}/${segments.slice(0, n).join("/")}`;
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
      }
    }
  }
  return [...counts]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([path, files]) => ({ path, files }));
}

function packageName(root: string, ref: string, path: string): string | null {
  try {
    const parsed: unknown = JSON.parse(git(root, ["show", `${ref}:${path}`]));
    const name = (parsed as { name?: unknown } | null)?.name;
    return typeof name === "string" && name !== "" ? name : null;
  } catch {
    return null;
  }
}

function packageSignals(
  root: string,
  ref: string,
  paths: readonly string[],
): PackageSignal[] {
  return paths
    .filter((path) => posix.basename(path) === "package.json")
    .flatMap((path) => {
      const name = packageName(root, ref, path);
      const dir = posix.dirname(path);
      return name === null ? [] : [{ path: dir === "." ? "" : dir, name }];
    })
    .sort((a, b) => byCodeUnit(a.path, b.path));
}

function graphSignals(
  root: string,
  graphs: readonly Graph[],
): GraphSignals | null {
  if (graphs.length === 0) return null;
  const reports = graphs.flatMap((graph) =>
    graph.clusters ? [{ graph, clusters: graph.clusters }] : [],
  );
  const clusters =
    reports.length === 0
      ? null
      : reports.flatMap(({ graph, clusters }) =>
          clusters.scatteredClusters.map((c) => ({
            id: c.id,
            dirs: c.dirs.map((d) => repoPathOf(root, graph, d.dir)),
          })),
        );
  const methods = new Set(
    graphs.flatMap((graph) =>
      (graph.crossRuntime?.edges ?? []).map(
        (e) => `${e.targetService}.${e.method}`,
      ),
    ),
  );
  return { clusters, crossRuntime: [...methods].sort(byCodeUnit) };
}

/**
 * The cheap, deterministic signals a feature vocabulary is drafted from. Reads the git tree at `ref`,
 * never the working copy, so an uncommitted scratch file does not show up as a feature.
 */
export function gatherSignals(input: SignalsInput): ProposeSignals {
  const paths = trackedPaths(input.root, { ref: input.ref });
  return {
    ref: input.ref,
    scopes: input.scopes,
    depth: input.depth,
    directories: directorySignals(paths, input.scopes, input.depth),
    packages: packageSignals(input.root, input.ref, paths),
    graph: graphSignals(input.root, input.graphs),
  };
}
