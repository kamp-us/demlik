import type { Graph } from "../schema.js";
import { stableStringify } from "./json.js";

export function renderGraph(graph: Graph, pretty: boolean): string {
  return stableStringify(graph, pretty);
}
