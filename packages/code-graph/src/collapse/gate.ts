import fs from "node:fs";
import path from "node:path";
import type { Reporter } from "../config.js";
import { assembleGraphWithEdges } from "../extract/assemble.js";
import { loadEdgeProject } from "../extract/project.js";
import type { NodeKindRules } from "../kinds/rules.js";
import { stableStringify } from "../render/json.js";
import type { Thresholds } from "../schema.js";
import { isCandidateFunction } from "./candidates.js";
import {
  CEILINGS_FILENAME,
  CollapseCeilingsSchema,
  evaluatePartialTwinRatchet,
  governedScopes,
  recordCeilings,
  renderPartialTwinRatchet,
  type ScopeMeasurement,
} from "./ceilings.js";
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

export function scopeOf(repoRoot: string, absolute: string): string {
  const rel = path.relative(repoRoot, absolute).split(path.sep).join("/");
  return rel === "" ? "." : rel;
}

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

function readCeilings(file: string, report: Reporter) {
  const defaults = CollapseCeilingsSchema.parse({});
  if (!fs.existsSync(file)) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    report(`ceilings file "${file}" is not valid JSON.`);
    return null;
  }
  const result = CollapseCeilingsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    report(
      `invalid ceilings in "${file}": ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
    );
    return null;
  }
  return result.data;
}

function measure(scopes: readonly string[], args: CollapseGateArgs): ScopeMeasurement[] {
  return scopes.map((scope) => ({
    scope,
    partialTwins: countPartialTwins(
      scope === "." ? args.repoRoot : path.join(args.repoRoot, scope),
      args,
    ),
  }));
}

export function runCollapseGate(args: CollapseGateArgs): number {
  const file = path.join(args.repoRoot, CEILINGS_FILENAME);
  const ceilings = readCeilings(file, args.report);
  if (ceilings === null) return 2;

  const scope = scopeOf(args.repoRoot, args.rootAbsolute);

  if (args.writeCeilings) {
    const recorded = recordCeilings(measure([scope], args), ceilings);
    fs.writeFileSync(file, `${stableStringify(recorded, true)}\n`);
    args.emit(`recorded ${scope} at ${recorded.scopes[scope]} partial twin(s) in ${file}\n`);
    return 0;
  }

  const scopes = governedScopes(ceilings, scope);
  if (scopes.length === 0) {
    args.report(
      `no scope at or under "${scope}" is recorded in ${CEILINGS_FILENAME}; ` +
        "record one with `--collapse --write-ceilings` before gating on it.",
    );
    return 2;
  }

  const { stdout, exitCode } = renderPartialTwinRatchet(
    evaluatePartialTwinRatchet(measure(scopes, args), ceilings),
    args.json,
    args.pretty,
  );
  args.emit(`${stdout}\n`);
  return exitCode;
}
