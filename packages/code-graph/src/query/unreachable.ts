import { isTestFile } from "../extract/functions.js";
import type { ReferenceResult } from "../extract/references.js";
import { type CompiledRule, matchingRules } from "../kinds/rules.js";
import type {
  FunctionNode,
  ModuleNode,
  UnreachableSymbol,
  WithheldReason,
  WithheldSymbol,
} from "../schema.js";
import { type Adjacency, fullAdjacency, reachableFrom } from "./reach.js";
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

type Verdict = { finding: UnreachableSymbol } | { withheld: WithheldSymbol };

/** Withheld for a reason that says the function itself may run in production. */
const LIVE_REASONS: ReadonlySet<WithheldReason> = new Set([
  "public-entry-surface",
  "referenced-in-non-test-file",
]);

/**
 * Every function a call or reference edge reaches from a function withheld as possibly live.
 * A seed's edge to itself does not count, so plain recursion does not make a seed its own caller.
 */
function reachedFromWithheld(adjacency: Adjacency, verdicts: readonly Verdict[]): Set<string> {
  const start: string[] = [];
  for (const verdict of verdicts) {
    if (!("withheld" in verdict) || !LIVE_REASONS.has(verdict.withheld.reason)) continue;
    const seed = verdict.withheld.id;
    for (const next of adjacency.get(seed) ?? []) if (next !== seed) start.push(next);
  }
  return reachableFrom(adjacency, start);
}

/**
 * A callee is never more dead than its caller. A finding, or a name-match withholding, that a
 * possibly-live withheld function reaches is withheld as `called-by-withheld`: the edge is
 * stronger evidence than a name match. Surface reasons describe the function's own file and stay.
 */
function withholdCalledByWithheld(
  verdict: Verdict,
  calledByWithheld: ReadonlySet<string>,
): Verdict {
  const id = "finding" in verdict ? verdict.finding.id : verdict.withheld.id;
  if (!calledByWithheld.has(id)) return verdict;
  if ("withheld" in verdict && verdict.withheld.reason !== "referenced-in-non-test-file") {
    return verdict;
  }
  return { withheld: { id, reason: "called-by-withheld" } };
}

function judge(
  fn: FunctionNode,
  refs: ReferenceResult,
  surface: ReadonlySet<string>,
  isTestLike: (file: string) => boolean,
): Verdict {
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

  const verdicts: Verdict[] = [];
  let exportedCount = 0;
  for (const fn of functions) {
    if (!fn.isExported || fn.isTest) continue;
    exportedCount++;
    if (reachable.has(fn.id)) continue;
    verdicts.push(judge(fn, refs, surface, isTestLike));
  }

  const calledByWithheld = reachedFromWithheld(adjacency, verdicts);
  const unreachable: UnreachableSymbol[] = [];
  const withheld: WithheldSymbol[] = [];
  for (const verdict of verdicts) {
    const final = withholdCalledByWithheld(verdict, calledByWithheld);
    if ("finding" in final) unreachable.push(final.finding);
    else withheld.push(final.withheld);
  }

  unreachable.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  withheld.sort((a, b) => a.reason.localeCompare(b.reason) || a.id.localeCompare(b.id));
  return { unreachable, withheld, reachableCount: reachable.size, exportedCount };
}
