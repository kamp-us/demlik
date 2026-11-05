import fs from "node:fs";
import path from "node:path";
import { discoverPackageRoots, type RepoListing } from "../extract/project.js";
import { type WorkspacePackage, workspacePackages } from "../layers/resolve-target.js";
import { declaresLibraries } from "./libraries/schema.js";
import type { BoundaryRules } from "./rules.js";

export type PackageFacts = {
  readonly roots: ReadonlySet<string>;
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
};

export const NO_PACKAGE_FACTS: PackageFacts = { roots: new Set(), packages: new Map() };

// The run owns package facts shared by library and deployable rules. B19 needs roots alone;
// libraries and B21 also need names and entries, read from each manifest once.
export function readPackageFacts(
  rules: BoundaryRules,
  repoRoot: string,
  listing: RepoListing | undefined,
): PackageFacts {
  const readNames =
    declaresLibraries(rules) ||
    rules.acrossDeployables.includes("package-import-crosses-deployable");
  const readRoots =
    readNames || rules.acrossDeployables.includes("relative-import-crosses-workspace");
  if (!readRoots || listing === undefined) return NO_PACKAGE_FACTS;
  const dirs = discoverPackageRoots(repoRoot, listing).filter((dir) => dir !== "");
  if (fs.existsSync(path.join(repoRoot, "package.json"))) dirs.push(".");
  return {
    roots: new Set(dirs),
    packages: readNames ? workspacePackages(repoRoot, dirs) : new Map(),
  };
}
