import { createHash } from "node:crypto";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";
import type { DuplicationSettings } from "./settings.js";

const TRIVIA = new Set(["start", "end", "loc", "range", "raw", "comments"]);
type Fingerprint = { key: string; nodes: number };

function isNode(value: unknown): value is SyntaxNode {
  return value !== null && typeof value === "object" && "type" in value;
}

function semanticValue(node: SyntaxNode, key: string, settings: DuplicationSettings): unknown {
  const value = field(node, key);
  if (node.type === "Identifier" && key === "name" && settings.cloneIgnoreIdentifiers) {
    return "$identifier";
  }
  if (node.type === "Literal" && settings.cloneIgnoreLiterals && key !== "type") {
    return key === "value" ? typeof value : null;
  }
  return value;
}

export function normalizer(syntax: SyntaxFile, settings: DuplicationSettings) {
  const cache = new Map<SyntaxNode, Fingerprint>();
  const normalizedValue = (value: unknown): unknown => {
    if (isNode(value)) return of(value).key;
    if (Array.isArray(value)) return value.map(normalizedValue);
    if (typeof value === "bigint") return String(value);
    if (value instanceof RegExp) return String(value);
    return value;
  };
  const of = (node: SyntaxNode): Fingerprint => {
    const held = cache.get(node);
    if (held !== undefined) return held;
    if (node.type === "ParenthesizedExpression") {
      const expression = nodeField(node, "expression");
      if (expression !== null) return of(expression);
    }
    const entries = Object.keys(node)
      .filter((key) => !TRIVIA.has(key))
      .sort()
      .map((key) => [key, normalizedValue(semanticValue(node, key, settings))]);
    const result = {
      key: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
      nodes: 1 + syntax.children(node).reduce((sum, child) => sum + of(child).nodes, 0),
    };
    cache.set(node, result);
    return result;
  };
  return of;
}
