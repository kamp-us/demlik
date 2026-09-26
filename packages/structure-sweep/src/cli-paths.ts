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
} as const;

/** A path flag: absolute as given, otherwise under the repository root. */
export const underRoot = (root: string, path: string) =>
  isAbsolute(path) ? path : resolve(root, path);

/** A folder argument, as the caller typed it from `cwd`, turned repo-relative with no trailing slash. */
export function scopeOf(root: string, cwd: string, arg: string): string {
  const scope = relative(root, resolve(cwd, arg)).split("\\").join("/");
  if (scope === "" || scope.startsWith("..")) {
    throw new Error(`${arg} is not a folder inside the repository at ${root}`);
  }
  return scope;
}
