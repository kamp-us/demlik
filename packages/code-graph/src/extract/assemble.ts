import path from "node:path";
import { TypeContext } from "../checker/context.js";
import { loadDataReport } from "../data/extract.js";
import {
  type DirectoryNode,
  type FunctionNode,
  type Graph,
  GraphSchema,
  type ModuleNode,
  type Provenance,
  type Smell,
  type Summary,
  type Thresholds,
} from "../schema.js";
import { couplingByFile } from "../smells/coupling.js";
import { compareFlatSmells, smellsForFunction, smellsForModule } from "../smells/evaluate.js";
import { healthBand } from "../smells/health.js";
import { rankPlan } from "../smells/plan.js";
import { importDeclarationSpecifiers, resolveImports } from "../syntax/imports.js";
import {
  type AnalysisBundle,
  type AnalysisOptions,
  analysisInputs,
  completeAnalysis,
  prepareAnalysis,
} from "./analysis.js";
import { buildDirectories } from "./directories.js";
import { type EdgeResult, resolveEdges } from "./edges.js";
import { type DiscoveredFunction, discoverFunctions, isTestFile } from "./functions.js";
import { computeFunctionMetrics, moduleCommentLines, moduleLoc } from "./metrics.js";
import { discoverPackageRoots, type EdgeScope, type LoadedProject } from "./project.js";

function smellWeight(smells: Smell[]): number {
  return smells.reduce((s, m) => s + (m.severity === "high" ? 2 : 1), 0);
}

type EdgeBundle = {
  result: EdgeResult;
  scope: EdgeScope;
  tsConfig: string;
};

function buildFunctionNodes(
  fns: DiscoveredFunction[],
  thresholds: Thresholds,
  edges: EdgeBundle | null,
  analysis: AnalysisBundle | null,
): FunctionNode[] {
  return fns.map((d) => {
    const m = computeFunctionMetrics(d);
    const fn: FunctionNode = {
      id: d.id,
      name: d.name,
      kind: d.kind,
      file: d.file,
      startLine: d.startLine,
      endLine: d.endLine,
      loc: m.loc,
      commentLines: m.commentLines,
      nestingDepth: m.nestingDepth,
      complexity: m.complexity,
      isExported: d.isExported,
      isTest: d.isTest,
      edges: edges
        ? {
            calls: edges.result.callsById.get(d.id) ?? [],
            calledBy: edges.result.calledById.get(d.id) ?? [],
            callChainDepth: edges.result.chainDepthById.get(d.id) ?? 0,
          }
        : null,
      nodeKind: null,
      smells: [],
    };
    fn.nodeKind = analysis?.classify?.(fn) ?? null;
    fn.smells = smellsForFunction(fn, thresholds);
    return fn;
  });
}

function buildModuleNodes(
  loaded: LoadedProject,
  edges: EdgeBundle | null,
  functions: FunctionNode[],
): ModuleNode[] {
  const { sourceFiles } = loaded;
  const idsByFile = new Map<string, string[]>();
  for (const f of functions) {
    const arr = idsByFile.get(f.file) ?? [];
    arr.push(f.id);
    idsByFile.set(f.file, arr);
  }

  const modules: ModuleNode[] = sourceFiles.map(({ file, syntax }) => {
    const imports = edges
      ? (edges.result.importsByFile.get(file) ?? [])
      : importDeclarationSpecifiers(syntax);
    const functionIds = (idsByFile.get(file) ?? []).slice().sort((a, b) => a.localeCompare(b));
    const module: ModuleNode = {
      file,
      loc: moduleLoc(syntax),
      commentLines: moduleCommentLines(syntax),
      functionIds,
      imports,
      importedBy: edges ? (edges.result.importedByFile.get(file) ?? []) : [],
      importEdges: edges ? (edges.result.importEdgesByFile.get(file) ?? []) : [],
      isTest: isTestFile(file),
      smells: [],
    };
    return module;
  });
  modules.sort((a, b) => a.file.localeCompare(b.file));
  return modules;
}

function attachModuleSmells(
  modules: ModuleNode[],
  thresholds: Thresholds,
  edges: EdgeBundle | null,
  rootAbsolute: string,
) {
  const coupling = edges ? couplingByFile(modules, discoverPackageRoots(rootAbsolute)) : null;
  for (const m of modules) {
    m.smells = smellsForModule(m, thresholds, coupling?.get(m.file) ?? null);
  }
}

function collectSmells(
  functions: FunctionNode[],
  modules: ModuleNode[],
  directories: DirectoryNode[],
): { allSmells: Smell[]; smellCount: number; highSeverityCount: number } {
  const allSmells: Smell[] = [
    ...functions.flatMap((f) => f.smells),
    ...modules.flatMap((m) => m.smells),
    ...directories.flatMap((dir) => dir.smells),
  ].sort(compareFlatSmells);
  return {
    allSmells,
    smellCount: allSmells.length,
    highSeverityCount: allSmells.filter((s) => s.severity === "high").length,
  };
}

function buildSummary(
  functions: FunctionNode[],
  modules: ModuleNode[],
  smellCount: number,
  highSeverityCount: number,
  parseFailures: readonly string[],
): Summary {
  const ranked = rankPlan(functions, "rot");
  const flagged = ranked.filter((r) => r.components.smells > 0);
  const topTargets = flagged.slice(0, 10);
  const worstFunction = flagged.length > 0 ? flagged[0].id : null;

  let worstFile: string | null = null;
  let worstWeight = 0;
  for (const m of modules) {
    const w = smellWeight(m.smells);
    if (w > worstWeight) {
      worstWeight = w;
      worstFile = m.file;
    }
  }

  return {
    health: healthBand({ smellCount, highSeverityCount, fileCount: modules.length }),
    fileCount: modules.length,
    functionCount: functions.length,
    smellCount,
    highSeverityCount,
    worstFile,
    worstFunction,
    topTargets,
    parseFailures: [...parseFailures],
  };
}

// The data pass reads syntax and the wrangler configs only, so it rides either pass.
export type DataOptions = { repoRoot: string };

function build(
  loaded: LoadedProject,
  thresholds: Thresholds,
  edges: EdgeBundle | null,
  discovered: DiscoveredFunction[] | null,
  analysis: AnalysisBundle | null,
  data: DataOptions | null,
): Graph {
  const { rootAbsolute, sourceFiles, parseFailures } = loaded;
  const root = path.relative(process.cwd(), rootAbsolute) || ".";

  const fns = discovered ?? discoverFunctions(sourceFiles).functions;
  const functions = buildFunctionNodes(fns, thresholds, edges, analysis);
  const modules = buildModuleNodes(loaded, edges, functions);
  attachModuleSmells(modules, thresholds, edges, rootAbsolute);
  const directories: DirectoryNode[] = buildDirectories(modules, thresholds);

  const { allSmells, smellCount, highSeverityCount } = collectSmells(
    functions,
    modules,
    directories,
  );
  const summary = buildSummary(functions, modules, smellCount, highSeverityCount, parseFailures);

  const provenance: Provenance = edges
    ? { pass: "edges", tsConfig: edges.tsConfig, scope: edges.scope }
    : { pass: "cheap" };

  const graph: Graph = {
    root,
    provenance,
    thresholds,
    summary,
    crossRuntime: analysis?.crossRuntime ?? null,
    reachability: analysis?.reachability?.(functions, modules) ?? null,
    clusters: analysis?.clusters?.(functions, modules) ?? null,
    interfaceWidth: analysis?.interfaceWidth?.(functions, modules) ?? null,
    data: data === null ? null : loadDataReport(sourceFiles, fns, data.repoRoot),
    functions,
    modules,
    directories,
    smells: allSmells,
    stats: {
      fileCount: modules.length,
      functionCount: functions.length,
      totalLoc: modules.reduce((s, m) => s + m.loc, 0),
      totalCommentLines: modules.reduce((s, m) => s + m.commentLines, 0),
      smellCount,
      parseFailures: [...parseFailures],
    },
  };

  return GraphSchema.parse(graph);
}

export function assembleGraph(
  loaded: LoadedProject,
  thresholds: Thresholds,
  data: DataOptions | null = null,
): Graph {
  return build(loaded, thresholds, null, null, null, data);
}

function reportUnjoined(unjoined: readonly string[]): void {
  if (unjoined.length === 0) return;
  const shown = unjoined.slice(0, 5).join(", ");
  const more = unjoined.length > 5 ? ", ..." : "";
  process.stderr.write(
    `code-graph: warning: ${unjoined.length} function(s) have no node in tsgo's tree, so their calls are not resolved: ${shown}${more}\n`,
  );
}

export function assembleGraphWithEdges(
  loaded: LoadedProject,
  thresholds: Thresholds,
  scope: EdgeScope,
  tsConfig: string,
  options: AnalysisOptions | null = null,
  data: DataOptions | null = null,
): Graph {
  const { rootAbsolute, sourceFiles } = loaded;
  const { functions } = discoverFunctions(sourceFiles);
  const ids = functions.map((f) => f.id);
  const imports = resolveImports(rootAbsolute, sourceFiles, tsConfig);

  const ctx = TypeContext.open({ rootAbsolute, tsConfigPath: tsConfig, sourceFiles, functions });
  try {
    reportUnjoined(ctx.unjoined);
    const prep = options === null ? null : prepareAnalysis(options, rootAbsolute, ctx);
    const result = resolveEdges(ctx, imports, ids, prep?.resolver ?? null);
    const analysis =
      options === null || prep === null
        ? null
        : completeAnalysis({ options, prep, rootAbsolute, ctx, ...analysisInputs(functions) });
    return build(loaded, thresholds, { result, scope, tsConfig }, functions, analysis, data);
  } finally {
    ctx.close();
  }
}
