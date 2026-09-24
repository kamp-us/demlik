import type { Graph } from "../schema.js";
import { stableStringify } from "./json.js";

export function renderSummary(graph: Graph, pretty: boolean): string {
  return stableStringify(graph.summary, pretty);
}
