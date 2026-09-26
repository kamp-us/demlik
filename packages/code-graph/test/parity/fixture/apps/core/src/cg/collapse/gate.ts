import fs from "node:fs";
import path from "node:path";
import type { Reporter } from "../config.js";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import type { NodeKindRules } from "../kinds/rules.js";
import {
  evaluateScopeRatchet,
  readScopeCeilings,
  recordScopeCeilings,
  type ScopeCount,
  scopeOf,
  scopesUnder,
} from "../ratchet/scope-count.js";
import { stableStringify } from "../render/json.js";
import type { Thresholds } from "../schema.js";
import { isCandidateFunction } from "./candidates.js";
import { CEILINGS_FILENAME, renderPartialTwinRatchet } from "./ceilings.js";
import { findPartialTwins } from "./partial.js";
import type { CollapseSettings } from "./settings.js";

export type CollapseGateArgs = {
  readonly rootAbsolute: string;
  readonly repoRoot: string;
  readonly writeCeilings: boolean;
  readonly thresholds: Thresholds;
  readonly kindRules: NodeKindRules;
  readonly settings: CollapseSettings;
  readonly emit: (payload: string) => void;
  readonly report: Reporter;
  readonly json: boolean;
  readonly pretty: boolean;
};

function countPartialTwins(scopeAbsolute: string, args: CollapseGateArgs): number {
  const loaded = loadEdgeProject(scopeAbsolute, "package", args.repoRoot);
  const graph = assembleGraphWithEdges(loaded, args.thresholds, "package", loaded.tsConfigPath, {
    crossRuntime: true,
    kinds: true,
    reach: false,
    clusters: false,
    interfaceWidth: false,
    kindRules: args.kindRules,
    repoRoot: args.repoRoot,
  });
  const candidates = graph.functions.filter((fn) => isCandidateFunction(fn, args.settings));
  return findPartialTwins(candidates, args.settings).length;
}

function measure(scopes: readonly string[], args: CollapseGateArgs): ScopeCount[] {
  return scopes.map((scope) => ({
    scope,
    count: countPartialTwins(scope === "." ? args.repoRoot : path.join(args.repoRoot, scope), args),
  }));
}

export function runCollapseGate(args: CollapseGateArgs): number {
  const file = path.join(args.repoRoot, CEILINGS_FILENAME);
  const ceilings = readScopeCeilings(file, args.report);
  if (ceilings === null) return 2;

  const scope = scopeOf(args.repoRoot, args.rootAbsolute);

  if (args.writeCeilings) {
    const recorded = recordScopeCeilings(measure([scope], args), ceilings);
    fs.writeFileSync(file, `${stableStringify(recorded, true)}\n`);
    args.emit(`recorded ${scope} at ${recorded.scopes[scope]} partial twin(s) in ${file}\n`);
    return 0;
  }

  const scopes = scopesUnder(Object.keys(ceilings.scopes), scope);
  if (scopes.length === 0) {
    args.report(
      `no scope at or under "${scope}" is recorded in ${CEILINGS_FILENAME}; ` +
        "record one with `--collapse --write-ceilings` before gating on it.",
    );
    return 2;
  }

  const { stdout, exitCode } = renderPartialTwinRatchet(
    evaluateScopeRatchet(measure(scopes, args), ceilings),
    args.json,
    args.pretty,
  );
  args.emit(`${stdout}\n`);
  return exitCode;
}
