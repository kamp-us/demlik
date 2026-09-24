import path from "node:path";
import type { FunctionNode, Graph, ModuleNode } from "../schema.js";
import { stableStringify } from "./json.js";

export type FileRender = {
  stdout: string | null;
  warning: string | null;
};

function normalize(rootAbsolute: string, target: string): string {
  const abs = path.resolve(target);
  const rel = path.relative(rootAbsolute, abs);
  return rel.split(path.sep).join("/");
}

export function renderFile(
  graph: Graph,
  rootAbsolute: string,
  target: string,
  pretty: boolean,
): FileRender {
  const wanted = normalize(rootAbsolute, target);
  const matches = (f: string): boolean => f === wanted || f === target;

  if (graph.summary.parseFailures.some(matches)) {
    return {
      stdout: null,
      warning: `warning: ${wanted} failed to parse and was excluded from the graph.`,
    };
  }

  const module: ModuleNode | undefined = graph.modules.find((m) => matches(m.file));
  if (!module) {
    return {
      stdout: null,
      warning: `warning: ${wanted} is not in the analyzed graph (no such module).`,
    };
  }

  const functions: FunctionNode[] = graph.functions.filter((fn) => fn.file === module.file);
  const payload = { provenance: graph.provenance, module, functions };
  return {
    stdout: stableStringify(payload, pretty),
    warning: null,
  };
}
