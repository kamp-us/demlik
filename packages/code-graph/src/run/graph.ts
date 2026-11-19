import type { Opts } from "../cli.js";
import type { Reporter } from "../config.js";
import type { AnalysisOptions } from "../extract/analysis.js";
import {
  assembleGraph,
  assembleGraphWithEdges,
  type DataOptions,
  type NodeFields,
} from "../extract/assemble.js";
import {
  type EdgeScope,
  type LoadedEdgeProject,
  type LoadedProject,
  loadCheapProject,
  loadEdgeProject,
} from "../extract/project.js";
import type { NodeKindRules } from "../kinds/rules.js";
import type { Graph, Thresholds } from "../schema.js";

type GraphRun = {
  rootAbsolute: string;
  repoRoot: string;
  opts: Opts;
  thresholds: Thresholds;
  kindRules: NodeKindRules;
  smellEdges: boolean;
  report: Reporter;
};

function selectedAnalysis({ opts, kindRules, repoRoot }: GraphRun): AnalysisOptions | null {
  const reach = opts.unreachable === true || opts.unguarded === true;
  const kinds = opts.kinds === true || reach || opts.collapse === true;
  const clusters = opts.clusters === true;
  const crossRuntime = opts.crossRuntime === true || kinds || clusters;
  const interfaceWidth = opts.interfaceWidth === true;
  return crossRuntime || interfaceWidth
    ? { crossRuntime, kinds, reach, clusters, interfaceWidth, kindRules, repoRoot }
    : null;
}

function needsEdges({ opts, smellEdges }: GraphRun, analysis: AnalysisOptions | null): boolean {
  return [
    opts.edges,
    opts.deep,
    typeof opts.blast === "string",
    typeof opts.find === "string",
    opts.html,
    opts.cycles,
    analysis !== null,
    smellEdges,
  ].some((given) => given === true);
}

export function loadGraph(args: GraphRun): { graph: Graph; loaded: LoadedProject } | null {
  const { opts, rootAbsolute, repoRoot, thresholds, report } = args;
  const analysis = selectedAnalysis(args);
  const scope: EdgeScope = opts.deep === true ? "deep" : "package";
  const data: DataOptions | null = opts.data === true ? { repoRoot } : null;
  const fields: NodeFields = { headers: opts.headers === true };
  if (!needsEdges(args, analysis)) {
    const loaded = loadCheapProject(rootAbsolute);
    return { loaded, graph: assembleGraph(loaded, thresholds, data, fields) };
  }
  let loaded: LoadedEdgeProject;
  try {
    loaded = loadEdgeProject(rootAbsolute, scope, repoRoot);
  } catch {
    report(`no tsconfig found for edge pass at ${rootAbsolute}; edges unavailable`);
    return null;
  }
  const graph = assembleGraphWithEdges(
    loaded,
    thresholds,
    scope,
    loaded.tsConfigPath,
    analysis,
    data,
    fields,
  );
  return { graph, loaded };
}
