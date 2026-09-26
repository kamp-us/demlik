import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { trackedPaths } from "../git.js";
import { agreementOf, graphPulls, type ImportEdge } from "../graph-pull.js";
import { importEdges } from "../move/project.js";
import type { Vocabulary } from "../vocabulary.js";
import { isSweptSource } from "./evidence.js";
import type { Nominate, SweepSelection } from "./run.js";

/** A feature's folder name, as `move plan` names a feature's home: `_` becomes `-`. */
const folderOf = (feature: string) => feature.replaceAll("_", "-");

/**
 * The feature a file sits in now: the vocabulary feature whose folder name matches a directory
 * segment of its path, the deepest such segment winning. `null` when no segment names one.
 */
export function currentFeature(
  vocabulary: Vocabulary,
  path: string,
): string | null {
  const byFolder = new Map(
    Object.keys(vocabulary.features).map((f) => [folderOf(f), f]),
  );
  const folders = path.split("/").slice(0, -1).reverse();
  for (const segment of folders) {
    const feature = byFolder.get(segment);
    if (feature !== undefined) return feature;
  }
  return null;
}

/**
 * Which files the graph nominates: a file whose import-graph pull disagrees with the feature folder
 * it sits in — `agreementOf(current, pull)` is `review`. The pull counts only neighbours among
 * `files` that sit in a feature folder, so a tree with none nominates nothing.
 */
export function nominatedBy(
  vocabulary: Vocabulary,
  files: readonly string[],
  edges: readonly ImportEdge[],
): (path: string) => boolean {
  const featureOf = new Map(
    files.flatMap((path) => {
      const feature = currentFeature(vocabulary, path);
      return feature === null ? [] : [[path, feature] as const];
    }),
  );
  const pullOf = graphPulls(edges, featureOf);
  return (path) =>
    agreementOf(featureOf.get(path) ?? null, pullOf(path).feature) === "review";
}

/** The nearest folder at or above `folder` holding a `tsconfig.json` on disk; `.` is the repo root. */
export function tsconfigScope(root: string, folder: string): string {
  for (let dir = folder; ; dir = posix.dirname(dir)) {
    if (existsSync(join(root, dir, "tsconfig.json"))) return dir;
    if (dir === ".") {
      throw new Error(
        `--nominated reads the import graph through a tsconfig.json, and none sits at or above ${folder}`,
      );
    }
  }
}

/**
 * `--nominated`'s hook for `runSweep`. A folder run reads each folder's import graph; a `--files`
 * run reads the graph of the nearest `tsconfig.json` scope above each listed file, so neighbours
 * outside its own folder count. The graph comes from the checkout, not `--ref`.
 */
export function graphNominator(
  root: string,
  vocabulary: Vocabulary,
  selection: SweepSelection,
): Nominate {
  const graphScopeOf =
    selection.files === undefined
      ? (scope: string) => scope
      : (scope: string) => tsconfigScope(root, scope);
  const byGraphScope = new Map<string, (path: string) => boolean>();
  return (scope) => {
    const graphScope = graphScopeOf(scope);
    const known = byGraphScope.get(graphScope);
    if (known !== undefined) return known;
    const tracked = trackedPaths(root, "index", graphScope);
    const nominated = nominatedBy(
      vocabulary,
      tracked.filter(isSweptSource),
      importEdges(root, graphScope, tracked),
    );
    byGraphScope.set(graphScope, nominated);
    return nominated;
  };
}
