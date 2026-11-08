import type { Reporter } from "../../config.js";
import { listRepo, type RepoListing } from "../../extract/project.js";
import { type BindingCatalog, loadBindingCatalog } from "../../extract/wrangler-config.js";
import type { ScopeInputs } from "../analyze.js";
import { type DeployablesRead, NO_CATALOG, readDeployables } from "../deployables/deployables.js";
import { declaresDeployables } from "../deployables/schema.js";
import { readLibraries } from "../libraries/libraries.js";
import { declaresLibraries } from "../libraries/schema.js";
import { type PackageFacts, readPackageFacts } from "../package-facts.js";
import type { BoundaryRules } from "../rules.js";
import { declaresReadAllowance } from "../shape/schema.js";
import { readShape } from "../shape/shape.js";
import { readTables, type Tables } from "../tables/tables.js";

// What a run reads once, before any scope is judged: the libraries, the deployables, the shape and
// the table kinds, and the repo's files listed once for them. A run that needs none of that listing
// leaves it to each scope, which lists its own.
export type Reads = ScopeInputs & { readonly listing: RepoListing | undefined };

// The three reads a run takes its own way, as one row each: whether the wrangler configs are read,
// and what the deployables and the table kinds are. The gate reads what the rules file declares; a
// view reads what it shows. The libraries and the shape are every run's.
export type RunReader = {
  readonly readsConfigs: (rules: BoundaryRules) => boolean;
  readonly deployables: (
    rules: BoundaryRules,
    facts: PackageFacts,
    catalog: BindingCatalog,
  ) => DeployablesRead;
  readonly tables: (rules: BoundaryRules) => Tables;
};

export const GATE_READER: RunReader = {
  readsConfigs: (rules) => declaresDeployables(rules) || declaresReadAllowance(rules),
  deployables: readDeployables,
  tables: readTables,
};

// Reads the libraries, the deployables and the shape the rules file declares, or says in one line
// why it cannot: a declaration the repo cannot honour, or a wrangler config the listed kinds or a
// read allowance need and the run cannot parse. The repo's files are listed once, and only when the
// reader reads the configs or a library key is declared; the wrangler configs are read once, and
// only for the reader that reads them.
export function readRun(
  rules: BoundaryRules,
  repoRoot: string,
  reader: RunReader,
  report: Reporter,
): Reads | null {
  const configs = reader.readsConfigs(rules);
  const listing = configs || declaresLibraries(rules) ? listRepo(repoRoot) : undefined;
  const catalog = configs ? loadBindingCatalog(repoRoot, listing) : NO_CATALOG;
  const packages = readPackageFacts(rules, repoRoot, listing);
  const read = readLibraries(rules, repoRoot, packages);
  if (read.kind === "refused") {
    report(read.message);
    return null;
  }
  const deployables = reader.deployables(rules, packages, catalog);
  if (deployables.kind === "refused") {
    report(deployables.message);
    return null;
  }
  const shape = readShape(rules, catalog);
  if (shape.kind === "refused") {
    report(shape.message);
    return null;
  }
  return {
    libraries: read.libraries,
    deployables: deployables.deployables,
    shape: shape.shape,
    tables: reader.tables(rules),
    listing,
  };
}
