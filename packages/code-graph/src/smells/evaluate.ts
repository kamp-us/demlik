import { distinctExternalCallers } from "../extract/edges.js";
import type { DirectoryNode, FunctionNode, ModuleNode, Smell, Thresholds } from "../schema.js";
import type { CouplingFacts } from "./coupling.js";
import type { FunctionFacts, ModuleFacts } from "./rules.js";
import { RULES, smellKinds } from "./rules.js";

const KINDS = smellKinds();

function compareSmells(a: Smell, b: Smell): number {
  return (
    a.kind.localeCompare(b.kind) ||
    (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1) ||
    b.value - a.value
  );
}

function factsFor(fn: FunctionNode): FunctionFacts {
  return {
    id: fn.id,
    file: fn.file,
    startLine: fn.startLine,
    loc: fn.loc,
    commentLines: fn.commentLines,
    nestingDepth: fn.nestingDepth,
    complexity: fn.complexity,
    calledByCount: fn.edges ? distinctExternalCallers(fn.id, fn.edges.calledBy) : null,
    callChainDepth: fn.edges ? fn.edges.callChainDepth : null,
  };
}

export function smellsForFunction(fn: FunctionNode, thresholds: Thresholds): Smell[] {
  const facts = factsFor(fn);
  const out: Smell[] = [];
  for (const kind of KINDS) {
    for (const raw of RULES[kind].evaluate({
      fn: facts,
      module: null,
      directory: null,
      thresholds,
    })) {
      out.push({ kind, ...raw });
    }
  }
  out.sort(compareSmells);
  return out;
}

function moduleFactsFor(module: ModuleNode, coupling: CouplingFacts | null): ModuleFacts {
  return {
    file: module.file,
    loc: module.loc,
    cycleSize: coupling ? coupling.cycleSize : null,
    crossBoundaryOutCount: coupling ? coupling.crossBoundaryOutCount : null,
  };
}

export function smellsForModule(
  module: ModuleNode,
  thresholds: Thresholds,
  coupling: CouplingFacts | null = null,
): Smell[] {
  const facts = moduleFactsFor(module, coupling);
  const out: Smell[] = [];
  for (const kind of KINDS) {
    for (const raw of RULES[kind].evaluate({
      fn: null,
      module: facts,
      directory: null,
      thresholds,
    })) {
      out.push({ kind, ...raw });
    }
  }
  out.sort(compareSmells);
  return out;
}

export function smellsForDirectory(directory: DirectoryNode, thresholds: Thresholds): Smell[] {
  const out: Smell[] = [];
  for (const kind of KINDS) {
    for (const raw of RULES[kind].evaluate({ fn: null, module: null, directory, thresholds })) {
      out.push({ kind, ...raw });
    }
  }
  out.sort(compareSmells);
  return out;
}

export function compareFlatSmells(a: Smell, b: Smell): number {
  const la = smellLocator(a);
  const lb = smellLocator(b);
  return la.localeCompare(lb) || compareSmells(a, b);
}

function smellLocator(s: Smell): string {
  const target = s.target;
  switch (target.type) {
    case "function":
      return `${target.file}:${String(target.startLine).padStart(8, "0")}`;
    case "module":
      return target.file;
    case "directory":
      return target.dir;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
