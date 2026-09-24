import { isTestFile } from "../extract/functions.js";
import type { ReferenceResult } from "../extract/references.js";
import { type CompiledRule, matchingRules } from "../kinds/rules.js";
import type { FunctionNode, ModuleNode, UnreachableSymbol, WithheldSymbol } from "../schema.js";
import { fullAdjacency, reachableFrom } from "./reach.js";
import { publicSurfaceFiles } from "./surface.js";

export type UnreachableResult = {
  unreachable: UnreachableSymbol[];
  withheld: WithheldSymbol[];
  reachableCount: number;
  exportedCount: number;
};

function productionRoots(functions: readonly FunctionNode[], refs: ReferenceResult): string[] {
  const roots = new Set<string>(refs.moduleScopeRoots);
  for (const fn of functions) {
    if (fn.nodeKind?.kind === "entry") roots.add(fn.id);
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function otherOccurrences(
  files: readonly string[],
  ownFile: string,
  isTestLike: (file: string) => boolean,
): { tests: string[]; production: string[] } {
  const tests: string[] = [];
  const production: string[] = [];
  for (const f of files) {
    if (f === ownFile) continue;
    (isTestLike(f) ? tests : production).push(f);
  }
  return { tests, production };
}

function judge(
  fn: FunctionNode,
  refs: ReferenceResult,
  surface: ReadonlySet<string>,
  isTestLike: (file: string) => boolean,
): { finding: UnreachableSymbol } | { withheld: WithheldSymbol } {
  if (isTestLike(fn.file)) {
    return { withheld: { id: fn.id, reason: "test-support-surface" } };
  }
  if (surface.has(fn.file)) {
    return { withheld: { id: fn.id, reason: "public-entry-surface" } };
  }
  const { tests, production } = otherOccurrences(
    refs.identifierFiles.get(fn.name) ?? [],
    fn.file,
    isTestLike,
  );
  if (production.length > 0) {
    return { withheld: { id: fn.id, reason: "referenced-in-non-test-file" } };
  }
  return {
    finding: {
      id: fn.id,
      file: fn.file,
      startLine: fn.startLine,
      category: tests.length > 0 ? "only-called-from-tests" : "dead",
      testReferences: tests,
    },
  };
}

export function findUnreachable(
  functions: readonly FunctionNode[],
  modules: readonly ModuleNode[],
  refs: ReferenceResult,
  extraEntryFiles: readonly string[],
  testSupport: readonly CompiledRule[],
  exportPatterns: readonly RegExp[],
): UnreachableResult {
  const adjacency = fullAdjacency(functions, refs.referencesById);
  const reachable = reachableFrom(adjacency, productionRoots(functions, refs));
  const surface = publicSurfaceFiles(modules, extraEntryFiles, exportPatterns);
  const isTestLike = (file: string): boolean =>
    isTestFile(file) || matchingRules(testSupport, file).length > 0;

  const unreachable: UnreachableSymbol[] = [];
  const withheld: WithheldSymbol[] = [];
  let exportedCount = 0;

  for (const fn of functions) {
    if (!fn.isExported || fn.isTest) continue;
    exportedCount++;
    if (reachable.has(fn.id)) continue;
    const verdict = judge(fn, refs, surface, isTestLike);
    if ("finding" in verdict) unreachable.push(verdict.finding);
    else withheld.push(verdict.withheld);
  }

  unreachable.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  withheld.sort((a, b) => a.reason.localeCompare(b.reason) || a.id.localeCompare(b.id));
  return { unreachable, withheld, reachableCount: reachable.size, exportedCount };
}
