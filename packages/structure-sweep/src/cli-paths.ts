import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_CONFIG_FILE } from "./vocabulary.js";

/** Where every command writes by default, under the repository root. */
export const OUT_DIR = ".structure-sweep";

export const DEFAULTS = {
  config: DEFAULT_CONFIG_FILE,
  verdicts: `${OUT_DIR}/verdicts.json`,
  pairs: `${OUT_DIR}/pairs.json`,
  pairsReport: `${OUT_DIR}/pairs.md`,
  manifest: `${OUT_DIR}/move-manifest.json`,
  score: `${OUT_DIR}/score.json`,
  consolidate: `${OUT_DIR}/consolidate.json`,
  consolidateReport: `${OUT_DIR}/consolidate.md`,
  groups: `${OUT_DIR}/groups.json`,
  inventory: `${OUT_DIR}/inventory.json`,
  inventoryReport: `${OUT_DIR}/inventory.md`,
  signals: `${OUT_DIR}/signals.json`,
  proposePrompt: `${OUT_DIR}/propose-prompt.md`,
  proposedConfig: `${OUT_DIR}/proposed.config.json`,
  refineReport: `${OUT_DIR}/refine.json`,
  refinePrompt: `${OUT_DIR}/refine-prompt.md`,
  refineHistory: `${OUT_DIR}/refine-history.json`,
  refineSample: `${OUT_DIR}/refine-sample.txt`,
  refineSweep: `${OUT_DIR}/refine-sweep.json`,
} as const;

/** A path flag: absolute as given, otherwise under the repository root. */
export const underRoot = (root: string, path: string) =>
  isAbsolute(path) ? path : resolve(root, path);

/** The scope a folder argument naming the repository root itself is recorded under. */
export const ROOT_SCOPE = ".";

/** A folder argument, as the caller typed it from `cwd`, repo-relative with no trailing slash; `undefined` outside the repository. */
function repoRelative(root: string, cwd: string, arg: string) {
  const scope = relative(root, resolve(cwd, arg)).split("\\").join("/");
  return scope.startsWith("..") ? undefined : scope;
}

const notInside = (root: string, arg: string) =>
  new Error(`${arg} is not a folder inside the repository at ${root}`);

/**
 * A folder argument, as the caller typed it from `cwd`, turned repo-relative with no trailing slash.
 * The repository root is refused: `move` and `propose` plan over one folder, never the whole tree.
 */
export function scopeOf(root: string, cwd: string, arg: string): string {
  const scope = repoRelative(root, cwd, arg);
  if (scope === undefined || scope === "") throw notInside(root, arg);
  return scope;
}

/**
 * `scopeOf` for a command that reads the whole tree — `pairs` and `sweep`: the repository root is a
 * scope too, recorded as `ROOT_SCOPE`. A path outside the repository is refused just the same.
 */
export function treeScopeOf(root: string, cwd: string, arg: string): string {
  const scope = repoRelative(root, cwd, arg);
  if (scope === undefined) throw notInside(root, arg);
  return scope === "" ? ROOT_SCOPE : scope;
}
