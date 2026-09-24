import chalk from "chalk";
import type { FunctionNode, Graph, ModuleNode } from "../schema.js";

const NAME_COL = 20;

function smellSuffix(fn: FunctionNode): string {
  if (fn.smells.length === 0) return "";
  const kinds = fn.smells
    .map((s) => s.kind)
    .sort()
    .join(",");
  return `  ${chalk.yellow(`[${kinds}]`)}`;
}

function renderFunction(fn: FunctionNode, isLast: boolean): string {
  const glyph = isLast ? "└" : "├";
  const name = fn.name.padEnd(NAME_COL, " ");
  const range = `L${fn.startLine}-${fn.endLine}`.padEnd(10, " ");
  const metrics = `loc=${fn.loc} cx=${fn.complexity} nest=${fn.nestingDepth}`;
  const colored = fn.smells.length > 0 ? chalk.bold(name) : name;
  return `  ${glyph} ${colored}${range}${metrics}${smellSuffix(fn)}`;
}

function renderModuleHeader(module: ModuleNode, fnCount: number): string {
  const head = `${module.file}  (loc ${module.loc}, ${fnCount} fns)`;
  if (module.isTest) return chalk.dim(`${head}  [test]`);
  return chalk.cyan(head);
}

export function renderTree(graph: Graph): string {
  if (graph.modules.length === 0) return "No modules in the graph.";

  const byFile = new Map<string, FunctionNode[]>();
  for (const fn of graph.functions) {
    const arr = byFile.get(fn.file) ?? [];
    arr.push(fn);
    byFile.set(fn.file, arr);
  }
  for (const arr of byFile.values()) {
    arr.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
  }

  const modules = [...graph.modules].sort((a, b) => a.file.localeCompare(b.file));

  const lines: string[] = [];
  for (const module of modules) {
    const fns = byFile.get(module.file) ?? [];
    lines.push(renderModuleHeader(module, fns.length));
    fns.forEach((fn, i) => {
      lines.push(renderFunction(fn, i === fns.length - 1));
    });
  }
  return lines.join("\n");
}
