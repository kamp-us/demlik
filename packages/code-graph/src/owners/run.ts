import { bindingsOnly } from "../boundaries/deployables/deployables.js";
import type { RunReader } from "../boundaries/run/reads.js";
import { readRun } from "../boundaries/run/reads.js";
import { ALL_TABLES } from "../boundaries/tables/tables.js";
import { type Reporter, resolveBoundaryRules } from "../config.js";
import { findRepoRoot } from "../extract/project.js";
import { scopeOf, scopesUnder } from "../ratchet/scope-count.js";
import { type OwnersReport, renderOwners } from "./render.js";
import { ownersOfScope } from "./scope.js";

// What the view reads that the gate reads only when the rules file asks: the wrangler configs, for
// the bindings, and the table facts, whatever kinds `tableOwnership` lists. It judges nothing, so a
// config the run cannot parse costs the view that worker's bindings (it is named under `notRead`),
// and the run only where the rules file names something that config must hold: a `bindingOwners`
// entry under it, or a `readAllowance`. The gate refuses those the same way.
const OWNERS_READER: RunReader = {
  readsConfigs: () => true,
  deployables: (_rules, _facts, catalog) => ({ kind: "read", deployables: bindingsOnly(catalog) }),
  tables: () => ALL_TABLES,
};

export type OwnersOutput = {
  readonly json: boolean;
  readonly pretty: boolean;
  readonly emit: (payload: string) => void;
  readonly report: Reporter;
};

// `code-graph <path> --owners --boundary-rules <file>`: who owns each table, binding and technology
// of the declared scopes under the path, and who reaches into them. A view, never a gate: it exits 0
// whatever the scopes hold, and 2 only where the gate would refuse to read the rules or a scope.
export function runOwners(
  rootAbsolute: string,
  boundaryRulesFile: string | undefined,
  out: OwnersOutput,
  repoRoot: string = findRepoRoot(rootAbsolute),
): number {
  const rules = resolveBoundaryRules(boundaryRulesFile, out.report);
  if (rules === null) return 2;
  const reads = readRun(rules, repoRoot, OWNERS_READER, out.report);
  if (reads === null) return 2;
  try {
    const scopes = scopesUnder(Object.keys(rules.features), scopeOf(repoRoot, rootAbsolute));
    const report: OwnersReport = {
      scopes: scopes.map((scope) => ownersOfScope(scope, rules, reads, repoRoot)),
      notRead: reads.deployables.catalog.unparsedConfigs.map((file) => ({
        file,
        reason: "wrangler config cannot be parsed",
      })),
    };
    out.emit(`${renderOwners(report, out.json, out.pretty)}\n`);
    return 0;
  } catch (error) {
    out.report(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
