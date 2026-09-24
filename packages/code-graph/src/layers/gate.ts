import { type Reporter, resolveLayerRules } from "../config.js";
import { loadCheapProject } from "../extract/project.js";
import { analyzeLayers } from "./analyze.js";
import { renderLayers } from "./render.js";

export function runLayerGate(args: {
  readonly rootAbsolute: string;
  readonly repoRoot: string;
  readonly layerRulesFile: string | undefined;
  readonly emit: (payload: string) => void;
  readonly report: Reporter;
  readonly json: boolean;
  readonly pretty: boolean;
}): number {
  const rules = resolveLayerRules(args.layerRulesFile, args.report);
  if (rules === null) return 2;
  const analysis = analyzeLayers(loadCheapProject(args.rootAbsolute), args.repoRoot, rules);
  const { stdout, exitCode } = renderLayers(analysis, rules.allowed, args.json, args.pretty);
  args.emit(`${stdout}\n`);
  return exitCode;
}
