import path from "node:path";
import { ownerOf } from "../extract/cross-runtime.js";
import type { BindingCatalog } from "../extract/wrangler-config.js";

export type ReadSiteOwner =
  | { kind: "worker"; service: string }
  | { kind: "unparsed-config" }
  | { kind: "none" };

// A manifest's `dir` is "" for a config at the repo root; `dirname` of its path is ".".
function directoryOf(configFile: string): string {
  const dir = path.posix.dirname(configFile);
  return dir === "." ? "" : dir;
}

function nearestUnparsedDirectory(unparsedConfigs: readonly string[], file: string): string | null {
  let best: string | null = null;
  for (const configFile of unparsedConfigs) {
    const dir = directoryOf(configFile);
    if (dir !== "" && !file.startsWith(`${dir}/`)) continue;
    if (best === null || dir.length > best.length) best = dir;
  }
  return best;
}

// The nearest wrangler config above a file owns it, parsed or not. Where a parsed and an unparsed
// config share a directory, the parsed one owns: its keys are known and nothing about how a parsed
// worker is judged changes.
export function readSiteOwner(catalog: BindingCatalog, file: string): ReadSiteOwner {
  const worker = ownerOf(catalog.manifests, file);
  const unparsed = nearestUnparsedDirectory(catalog.unparsedConfigs, file);
  if (unparsed !== null && (worker === null || unparsed.length > worker.dir.length)) {
    return { kind: "unparsed-config" };
  }
  return worker === null ? { kind: "none" } : { kind: "worker", service: worker.service };
}
