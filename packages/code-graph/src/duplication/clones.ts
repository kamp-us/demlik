import type { LoadedProject } from "../extract/project.js";
import type { Graph } from "../schema.js";
import { normalizer } from "./normalize.js";
import { compareSites, type Site, scan } from "./scan.js";
import type { DuplicationSettings } from "./settings.js";

export type ExpressionClone = {
  key: string;
  nodeCount: number;
  fileCount: number;
  expression: string;
  sites: Site[];
};

const EXPRESSIONS = new Set([
  "ObjectExpression",
  "ArrayExpression",
  "CallExpression",
  "NewExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "BinaryExpression",
  "AssignmentExpression",
  "AwaitExpression",
  "UnaryExpression",
  "UpdateExpression",
  "SequenceExpression",
  "TaggedTemplateExpression",
  "TemplateLiteral",
  "MemberExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "JSXElement",
  "JSXFragment",
]);

function contained(inner: ExpressionClone, outer: ExpressionClone): boolean {
  return inner.sites.every((site) =>
    outer.sites.some(
      (parent) =>
        parent.file === site.file &&
        parent.startOffset <= site.startOffset &&
        parent.endOffset >= site.endOffset,
    ),
  );
}

export function findExpressionClones(
  loaded: LoadedProject,
  graph: Graph,
  settings: DuplicationSettings,
): ExpressionClone[] {
  const groups = new Map<string, ExpressionClone>();
  scan(loaded, graph, (unit) => {
    const fingerprint = normalizer(unit.syntax, settings);
    return (node, site) => {
      if (!EXPRESSIONS.has(node.type)) return;
      const { key, nodes } = fingerprint(node);
      if (nodes < settings.cloneMinNodes) return;
      const group = groups.get(key);
      if (group !== undefined) group.sites.push(site);
      else
        groups.set(key, {
          key,
          nodeCount: nodes,
          fileCount: 0,
          expression: unit.syntax.textOf(node).slice(0, 240),
          sites: [site],
        });
    };
  });
  const candidates = [...groups.values()]
    .filter((group) => {
      group.fileCount = new Set(group.sites.map((site) => site.file)).size;
      group.sites.sort(compareSites);
      return group.fileCount >= settings.cloneMinFiles;
    })
    .sort(
      (a, b) =>
        b.nodeCount - a.nodeCount || b.fileCount - a.fileCount || a.key.localeCompare(b.key),
    );
  const maximal: ExpressionClone[] = [];
  for (const candidate of candidates) {
    if (!maximal.some((outer) => contained(candidate, outer))) maximal.push(candidate);
  }
  return maximal.sort(
    (a, b) => b.fileCount - a.fileCount || b.nodeCount - a.nodeCount || a.key.localeCompare(b.key),
  );
}
