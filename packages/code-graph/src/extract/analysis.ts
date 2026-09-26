import path from "node:path";
import type { TypeContext } from "../checker/context.js";
import { type ClassifyContext, classifyFunction, compileKindRules } from "../kinds/classify.js";
import {
  mergeRuleMaps,
  publicMethodRulesByBaseClass,
  siblingPropertyRules,
  typeScopeRules,
} from "../kinds/declarations.js";
import type { NodeKindRules } from "../kinds/rules.js";
import { buildClusterReport } from "../query/clusters.js";
import { findInterfaceWidth } from "../query/interface-width.js";
import { findUnguarded } from "../query/unguarded.js";
import { findUnreachable } from "../query/unreachable.js";
import type {
  BindingCensusRow,
  ClusterReport,
  CrossRuntimeEdge,
  CrossRuntimeReport,
  FunctionNode,
  InterfaceWidthReport,
  ModuleNode,
  NodeKind,
  ReachabilityReport,
} from "../schema.js";
import {
  type CrossRuntimeResolver,
  createCrossRuntimeResolver,
  methodIdsOfClasses,
} from "./cross-runtime.js";
import { publicExportPatterns } from "./package-exports.js";
import { discoverPackageRoots, toRelative } from "./project.js";
import { type ReferenceResult, resolveReferences } from "./references.js";
import { type BindingCatalog, loadBindingCatalog } from "./wrangler-config.js";

export type AnalysisOptions = {
  crossRuntime: boolean;
  kinds: boolean;
  reach: boolean;
  clusters: boolean;
  interfaceWidth: boolean;
  kindRules: NodeKindRules;
  repoRoot: string;
};

export type AnalysisBundle = {
  crossRuntime: CrossRuntimeReport | null;
  classify: ((fn: FunctionNode) => NodeKind) | null;
  reachability: ((functions: FunctionNode[], modules: ModuleNode[]) => ReachabilityReport) | null;
  clusters: ((functions: FunctionNode[], modules: ModuleNode[]) => ClusterReport) | null;
  interfaceWidth:
    | ((functions: FunctionNode[], modules: ModuleNode[]) => InterfaceWidthReport)
    | null;
};

export type AnalysisPrep = {
  resolver: CrossRuntimeResolver | null;
  catalog: BindingCatalog | null;
};

export function prepareAnalysis(
  options: AnalysisOptions,
  rootAbsolute: string,
  ctx: TypeContext,
): AnalysisPrep {
  if (!options.crossRuntime) return { resolver: null, catalog: null };
  const catalog = loadBindingCatalog(options.repoRoot);
  return {
    catalog,
    resolver: createCrossRuntimeResolver({
      catalog,
      rootAbsolute,
      repoRoot: options.repoRoot,
      ctx,
    }),
  };
}

function bindingCensus(catalog: BindingCatalog, edges: CrossRuntimeEdge[]): BindingCensusRow[] {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const key = `${e.ownerService}|${e.binding}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows: BindingCensusRow[] = [];
  for (const m of catalog.manifests) {
    for (const b of m.bindings) {
      rows.push({
        binding: b.binding,
        bindingKind: b.kind,
        callSites: counts.get(`${m.service}|${b.binding}`) ?? 0,
        ownerService: m.service,
        targetClass: b.targetClass,
        targetService: b.targetService,
      });
    }
  }
  rows.sort(
    (a, b) =>
      a.ownerService.localeCompare(b.ownerService) ||
      a.binding.localeCompare(b.binding) ||
      a.targetClass.localeCompare(b.targetClass),
  );
  return rows;
}

function workerMainFiles(
  catalog: BindingCatalog,
  repoRoot: string,
  rootAbsolute: string,
): string[] {
  const out = new Set<string>();
  for (const m of catalog.manifests) {
    if (m.main === null) continue;
    out.add(toRelative(rootAbsolute, path.join(repoRoot, m.main)));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export type NamedSymbol = { id: string; name: string; file: string; isExported: boolean };

function exportedIdsByFile(functions: readonly NamedSymbol[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const fn of functions) {
    if (!fn.isExported) continue;
    const bucket = map.get(fn.file);
    if (bucket === undefined) map.set(fn.file, [fn.id]);
    else bucket.push(fn.id);
  }
  for (const bucket of map.values()) bucket.sort((a, b) => a.localeCompare(b));
  return map;
}

export type CompleteInput = {
  options: AnalysisOptions;
  prep: AnalysisPrep;
  rootAbsolute: string;
  ctx: TypeContext;
  names: Set<string>;
  exportsByFile: Map<string, string[]>;
};

function crossRuntimeReport(input: CompleteInput): CrossRuntimeReport | null {
  const { prep } = input;
  if (prep.resolver === null || prep.catalog === null) return null;
  const edges = prep.resolver.edges();
  return {
    census: bindingCensus(prep.catalog, edges),
    configFiles: prep.catalog.manifests.map((m) => m.configFile).sort((a, b) => a.localeCompare(b)),
    edges,
    unparsedConfigs: prep.catalog.unparsedConfigs,
  };
}

function resolvedTargets(report: CrossRuntimeReport | null): Set<string> {
  const targets = new Set<string>();
  for (const e of report?.edges ?? []) {
    if (e.bindingKind === "workflow") continue;
    if (e.calleeId !== null) targets.add(e.calleeId);
  }
  return targets;
}

function durableObjectClasses(catalog: BindingCatalog | null): Set<string> {
  const names = new Set<string>();
  for (const m of catalog?.manifests ?? []) {
    for (const b of m.bindings) {
      if (b.kind === "durable-object") names.add(b.targetClass);
    }
  }
  return names;
}

function buildReachability(
  options: AnalysisOptions,
  prep: AnalysisPrep,
  rootAbsolute: string,
  compiled: ReturnType<typeof compileKindRules>,
  refs: ReferenceResult,
): (functions: FunctionNode[], modules: ModuleNode[]) => ReachabilityReport {
  return (functions, modules) => {
    const mains =
      prep.catalog === null ? [] : workerMainFiles(prep.catalog, options.repoRoot, rootAbsolute);
    const exportPatterns = publicExportPatterns(
      options.repoRoot,
      rootAbsolute,
      discoverPackageRoots(options.repoRoot),
    );
    const found = findUnreachable(
      functions,
      modules,
      refs,
      mains,
      compiled.testSupport,
      exportPatterns,
    );
    return {
      entryCount: functions.filter((f) => f.nodeKind?.kind === "entry").length,
      exportedCount: found.exportedCount,
      reachableCount: found.reachableCount,
      unguarded: findUnguarded(functions),
      unreachable: found.unreachable,
      withheld: found.withheld,
    };
  };
}

function buildInterfaceWidth(
  rootAbsolute: string,
  refs: ReferenceResult,
): (functions: FunctionNode[], modules: ModuleNode[]) => InterfaceWidthReport {
  return (functions) => {
    const packageDirs = discoverPackageRoots(rootAbsolute);
    const packages = findInterfaceWidth(functions, refs, packageDirs);
    return {
      packages,
      totalExports: packages.reduce((s, p) => s + p.exportCount, 0),
      totalZeroConsumer: packages.reduce((s, p) => s + p.zeroConsumerCount, 0),
    };
  };
}

export function completeAnalysis(input: CompleteInput): AnalysisBundle {
  const { options, prep, rootAbsolute, ctx, names, exportsByFile } = input;
  const report = crossRuntimeReport(input);

  const compiled = compileKindRules(options.kindRules);
  const context: ClassifyContext = {
    crossRuntimeTargets: resolvedTargets(report),
    durableObjectMethods: methodIdsOfClasses(ctx, durableObjectClasses(prep.catalog)),
    baseClassEntries: publicMethodRulesByBaseClass(ctx, compiled.entryBaseClasses),
    declaredGuards: mergeRuleMaps(
      siblingPropertyRules(ctx, compiled.entryGuardProperties),
      typeScopeRules(ctx, compiled.entryGuardProperties),
    ),
  };
  const classify = options.kinds
    ? (fn: FunctionNode): NodeKind => classifyFunction(fn, compiled, context)
    : null;

  const clusters = options.clusters ? buildClusterReport : null;

  if (!options.reach && !options.interfaceWidth) {
    return { crossRuntime: report, classify, clusters, reachability: null, interfaceWidth: null };
  }

  const refs = resolveReferences(ctx, names, exportsByFile);
  const reachability = options.reach
    ? buildReachability(options, prep, rootAbsolute, compiled, refs)
    : null;
  const interfaceWidth = options.interfaceWidth ? buildInterfaceWidth(rootAbsolute, refs) : null;

  return { crossRuntime: report, classify, clusters, reachability, interfaceWidth };
}

export function analysisInputs(functions: readonly NamedSymbol[]): {
  names: Set<string>;
  exportsByFile: Map<string, string[]>;
} {
  return {
    names: new Set(functions.map((f) => f.name)),
    exportsByFile: exportedIdsByFile(functions),
  };
}
