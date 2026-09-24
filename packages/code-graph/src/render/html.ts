import type { Graph } from "../schema.js";
import { buildHtmlModel } from "./html-model.js";
import { renderPage } from "./html-template.js";

export type {
  GraphEdge,
  GraphNode,
  HtmlModel,
  Severity,
  TreemapNode,
} from "./html-model.js";
export {
  buildHtmlModel,
  SEVERITY_COLOR,
} from "./html-model.js";

export function renderHtml(graph: Graph): string {
  return renderPage(graph, buildHtmlModel(graph));
}
