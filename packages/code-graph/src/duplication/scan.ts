import { discoverFunctions } from "../extract/functions.js";
import type { LoadedProject, SourceUnit } from "../extract/project.js";
import type { Graph } from "../schema.js";
import type { SyntaxNode } from "../syntax/file.js";

export type Site = {
  file: string;
  functionId: string | null;
  startLine: number;
  startColumn: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
};

export function siteOf(unit: SourceUnit, node: SyntaxNode, functionId: string | null): Site {
  return {
    file: unit.file,
    functionId,
    startLine: unit.syntax.lineOf(node.start),
    startColumn: unit.syntax.startColumn(node),
    endLine: unit.syntax.lineOf(node.end),
    startOffset: node.start,
    endOffset: node.end,
  };
}

export function scan(
  loaded: LoadedProject,
  graph: Graph,
  visitFile: (unit: SourceUnit) => (node: SyntaxNode, site: Site) => void,
): void {
  const functions = new Map(graph.functions.map((fn) => [fn.id, fn]));
  const owners = new Map(
    discoverFunctions(loaded.sourceFiles)
      .functions.filter((fn) => functions.has(fn.id))
      .map((fn) => [fn.node, fn.id]),
  );
  const tests = new Set(
    graph.modules.filter((module) => module.isTest).map((module) => module.file),
  );
  for (const unit of loaded.sourceFiles) {
    if (tests.has(unit.file)) continue;
    const visit = visitFile(unit);
    const walk = (node: SyntaxNode, owner: string | null): void => {
      const current = owners.get(node) ?? owner;
      visit(node, siteOf(unit, node, current));
      for (const child of unit.syntax.children(node)) walk(child, current);
    };
    walk(unit.syntax.program, null);
  }
}

export function compareSites(a: Site, b: Site): number {
  return a.file.localeCompare(b.file) || a.startOffset - b.startOffset || a.endOffset - b.endOffset;
}
