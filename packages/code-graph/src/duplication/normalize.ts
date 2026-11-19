import { createHash } from "node:crypto";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";
import type { DuplicationSettings } from "./settings.js";

const TRIVIA = new Set(["start", "end", "loc", "range", "raw", "comments"]);
type Fingerprint = { key: string; nodes: number };

function isNode(value: unknown): value is SyntaxNode {
  return value !== null && typeof value === "object" && "type" in value;
}

type SemanticReader = (node: SyntaxNode, key: string, settings: DuplicationSettings) => unknown;
const readIdentifier: SemanticReader = (node, key, settings) =>
  key === "name" && settings.cloneIgnoreIdentifiers ? "$identifier" : field(node, key);
const SEMANTIC_READERS: ReadonlyMap<string, SemanticReader> = new Map([
  ["Identifier", readIdentifier],
  ["JSXIdentifier", readIdentifier],
  ["PrivateIdentifier", readIdentifier],
  [
    "Literal",
    (node, key, settings) =>
      settings.cloneIgnoreLiterals && key !== "type"
        ? key === "value"
          ? typeof field(node, key)
          : null
        : field(node, key),
  ],
  [
    "TemplateElement",
    (node, key, settings) =>
      key === "value" && node.type === "TemplateElement"
        ? settings.cloneIgnoreLiterals
          ? "string"
          : node.value.cooked
        : field(node, key),
  ],
]);

function semanticValue(node: SyntaxNode, key: string, settings: DuplicationSettings): unknown {
  const read = SEMANTIC_READERS.get(node.type);
  return read === undefined ? field(node, key) : read(node, key, settings);
}

const PRIMITIVE_READERS: ReadonlyMap<string, (value: unknown) => unknown> = new Map([
  ["bigint", String],
  ["number", (value) => (Number.isFinite(value) ? value : { number: String(value) })],
]);

export function normalizer(syntax: SyntaxFile, settings: DuplicationSettings) {
  const cache = new Map<SyntaxNode, Fingerprint>();
  const normalizedValue = (value: unknown): unknown => {
    if (isNode(value)) return of(value).key;
    if (Array.isArray(value)) return value.map(normalizedValue);
    if (value instanceof RegExp) return String(value);
    const read = PRIMITIVE_READERS.get(typeof value);
    return read === undefined ? value : read(value);
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
