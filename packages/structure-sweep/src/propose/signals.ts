import { posix } from "node:path";
import { git, trackedPaths } from "../git.js";
import {
  contentHash,
  isSweptSource,
  type SourceFile,
} from "../sweep/evidence.js";
import { type Graph, repoPathOf } from "../sweep/graph.js";
import { byCodeUnit, type ContentSignals, contentSignals } from "./content.js";

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

/**
 * A code-graph cluster that spans several folders: one concept the layout has not named. code-graph
 * numbers clusters per run, so `id` is unique only within its `graph`; the pair names the cluster.
 */
export interface ClusterSignal {
  /** The `--graph` file the cluster came from, repo-relative. */
  readonly graph: string;
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
export interface NamedSignals {
  readonly ref: string;
  readonly scopes: readonly string[];
  readonly blind: false;
  readonly depth: number;
  readonly directories: readonly DirectorySignal[];
  readonly packages: readonly PackageSignal[];
  /** `null` when no `--graph` was passed. */
  readonly graph: GraphSignals | null;
  /** Files named by repo-relative path. */
  readonly content: ContentSignals;
}

/**
 * `--blind`: every folder- and package-shaped signal left out, so a drafted vocabulary has to come
 * from what the code says. Code-graph clusters go too: code-graph gives them only as folders.
 */
export interface BlindSignals {
  readonly ref: string;
  readonly scopes: readonly string[];
  readonly blind: true;
  /** `null` when no `--graph` was passed. */
  readonly graph: Pick<GraphSignals, "crossRuntime"> | null;
  /** Files named by opaque ids (`f<n>` plus the extension), numbered in code-unit order of path. */
  readonly content: ContentSignals;
}

export type ProposeSignals = NamedSignals | BlindSignals;

/** One parsed `--graph` file and where it lives, repo-relative. */
export interface GraphSource {
  readonly file: string;
  readonly graph: Graph;
}

export interface SignalsInput {
  readonly root: string;
  readonly ref: string;
  readonly scopes: readonly string[];
  readonly depth: number;
  readonly graphs: readonly GraphSource[];
  /** Leave out folders, packages and code-graph clusters, and name files by opaque id. */
  readonly blind?: boolean;
}

/** Every file `sweep` would ask about under any scope, once each, in code-unit order of path. */
function sweptSources(
  root: string,
  ref: string,
  paths: readonly string[],
  scopes: readonly string[],
): SourceFile[] {
  return paths
    .filter(
      (path) =>
        isSweptSource(path) && scopes.some((s) => path.startsWith(`${s}/`)),
    )
    .sort(byCodeUnit)
    .map((path) => {
      const text = git(root, ["show", `${ref}:${path}`]);
      return { path, text, hash: contentHash(text) };
    });
}

/** `f<n>` in code-unit order of path, keeping the extension: the same ids on every machine. */
function opaqueNames(sources: readonly SourceFile[]): (path: string) => string {
  const ids = new Map(
    sources.map(({ path }, n) => [path, `f${n + 1}${posix.extname(path)}`]),
  );
  return (path) => {
    const id = ids.get(path);
    if (id === undefined) throw new Error(`no opaque id for ${path}`);
    return id;
  };
}

function directorySignals(
  paths: readonly string[],
  scopes: readonly string[],
  depth: number,
): DirectorySignal[] {
  // A set per folder: overlapping scopes reach one file twice, and it counts once.
  const files = new Map<string, Set<string>>();
  for (const scope of scopes) {
    for (const path of paths) {
      if (!path.startsWith(`${scope}/`) || !isSweptSource(path)) continue;
      const below = posix.dirname(path.slice(scope.length + 1));
      if (below === ".") continue;
      const segments = below.split("/").slice(0, depth);
      for (let n = 1; n <= segments.length; n++) {
        const dir = `${scope}/${segments.slice(0, n).join("/")}`;
        files.set(dir, (files.get(dir) ?? new Set()).add(path));
      }
    }
  }
  return [...files]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([path, under]) => ({ path, files: under.size }));
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
  graphs: readonly GraphSource[],
): GraphSignals | null {
  if (graphs.length === 0) return null;
  const reports = graphs.flatMap(({ file, graph }) =>
    graph.clusters ? [{ file, graph, clusters: graph.clusters }] : [],
  );
  const clusters =
    reports.length === 0
      ? null
      : reports.flatMap(({ file, graph, clusters }) =>
          clusters.scatteredClusters.map((c) => ({
            graph: file,
            id: c.id,
            dirs: c.dirs.map((d) => repoPathOf(root, graph, d.dir)),
          })),
        );
  const methods = new Set(
    graphs.flatMap(({ graph }) =>
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
export function gatherSignals(
  input: SignalsInput & { readonly blind: true },
): BlindSignals;
export function gatherSignals(
  input: SignalsInput & { readonly blind?: false },
): NamedSignals;
export function gatherSignals(input: SignalsInput): ProposeSignals;
export function gatherSignals(input: SignalsInput): ProposeSignals {
  const paths = trackedPaths(input.root, { ref: input.ref });
  const sources = sweptSources(input.root, input.ref, paths, input.scopes);
  const graph = graphSignals(input.root, input.graphs);
  if (input.blind)
    return {
      ref: input.ref,
      scopes: input.scopes,
      blind: true,
      graph: graph === null ? null : { crossRuntime: graph.crossRuntime },
      content: contentSignals(sources, opaqueNames(sources)),
    };
  return {
    ref: input.ref,
    scopes: input.scopes,
    blind: false,
    depth: input.depth,
    directories: directorySignals(paths, input.scopes, input.depth),
    packages: packageSignals(input.root, input.ref, paths),
    graph,
    content: contentSignals(sources, (path) => path),
  };
}
