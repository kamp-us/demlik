/** An oxc-parser ESTree node, as far as the lowering reads one. */
export type Node = {
  readonly type: string;
  readonly start: number;
  readonly end: number;
} & Readonly<Record<string, unknown>>;

export const isNode = (value: unknown): value is Node =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { type?: unknown }).type === "string";

export const child = (node: Node, key: string): Node | null => {
  const value = node[key];
  return isNode(value) ? value : null;
};

export const children = (node: Node, key: string): readonly Node[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

export const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Keys holding type syntax, which decides nothing at runtime and is never walked. */
export const TYPE_KEYS = new Set([
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
  "returnType",
  "decorators",
]);

/** A node's child nodes, keyed, type syntax left out. */
export function keyedChildren(
  node: Node,
): readonly (readonly [string, Node])[] {
  const out: (readonly [string, Node])[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (TYPE_KEYS.has(key)) continue;
    if (isNode(value)) out.push([key, value]);
    else if (Array.isArray(value))
      for (const v of value) if (isNode(v)) out.push([key, v]);
  }
  return out;
}

export const nodeChildren = (node: Node): readonly Node[] =>
  keyedChildren(node).map(([, c]) => c);
