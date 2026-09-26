import { type Comment, childKeysOf, type Node, type Program } from "../engine/oxc.js";
import { Trivia } from "./trivia.js";

export type { Comment, Program };
export type SyntaxNode = Node;

// A node's fields by name, for the handful of reads the typed union makes awkward (a Property's
// `method`, a function's `id`). Every read goes through `field`, so the cast lives in one place.
export function field(node: Node, key: string): unknown {
  return (node as unknown as Record<string, unknown>)[key];
}

export function nodeField(node: Node, key: string): Node | null {
  const value = field(node, key);
  return isNode(value) ? value : null;
}

function isNode(value: unknown): value is Node {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

const METHOD_HOSTS = new Set(["MethodDefinition", "TSAbstractMethodDefinition"]);

// TypeScript has one node for `m() {}` where ESTree has two: the member and the function that is its
// value. Every pass that mirrors TypeScript's tree reads through the member and never sees the value
// as a node of its own.
export function isMethodValue(node: Node, parent: Node | undefined): boolean {
  if (node.type !== "FunctionExpression" && node.type !== "TSEmptyBodyFunctionExpression") {
    return false;
  }
  if (parent === undefined) return false;
  if (METHOD_HOSTS.has(parent.type)) return true;
  return parent.type === "Property" && (field(parent, "method") === true || isAccessorKind(parent));
}

export function isAccessorKind(node: Node): boolean {
  const kind = field(node, "kind");
  return kind === "get" || kind === "set";
}

const EXPORT_WRAPPERS = new Set(["ExportNamedDeclaration", "ExportDefaultDeclaration"]);

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (ch === 10 || ch === 0x2028 || ch === 0x2029) {
      starts.push(i + 1);
    }
  }
  return starts;
}

export class SyntaxFile {
  readonly lineStarts: readonly number[];
  private readonly parents = new Map<Node, Node>();
  private readonly childCache = new Map<Node, readonly Node[]>();
  private triviaCache: Trivia | null = null;

  constructor(
    readonly text: string,
    readonly program: Program,
    readonly comments: readonly Comment[],
  ) {
    this.lineStarts = computeLineStarts(text);
    this.indexParents(program);
  }

  private indexParents(root: Node): void {
    const stack: Node[] = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      for (const child of this.children(node)) {
        this.parents.set(child, node);
        stack.push(child);
      }
    }
  }

  get trivia(): Trivia {
    this.triviaCache ??= new Trivia(this.text, this.comments);
    return this.triviaCache;
  }

  parentOf(node: Node): Node | undefined {
    return this.parents.get(node);
  }

  // ESTree children in source order: the visitor keys list a TemplateLiteral's quasis before its
  // expressions, and every order-sensitive pass here (ordinals, preorder walks) wants the text's.
  children(node: Node): readonly Node[] {
    const cached = this.childCache.get(node);
    if (cached !== undefined) return cached;
    const out: Node[] = [];
    for (const key of childKeysOf(node)) {
      const value = field(node, key);
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) out.push(item);
      } else if (isNode(value)) {
        out.push(value);
      }
    }
    out.sort((a, b) => a.start - b.start);
    this.childCache.set(node, out);
    return out;
  }

  // The children TypeScript's forEachChild would visit: a method's function value is not a node
  // there, so its parameters and body are the member's own children.
  tsChildren(node: Node): readonly Node[] {
    const direct = this.children(node);
    if (!direct.some((child) => isMethodValue(child, node))) return direct;
    return direct.flatMap((child) => (isMethodValue(child, node) ? this.children(child) : [child]));
  }

  forEachTsDescendant(node: Node, visit: (descendant: Node) => void): void {
    for (const child of this.tsChildren(node)) {
      visit(child);
      this.forEachTsDescendant(child, visit);
    }
  }

  // Where TypeScript's node starts: an exported declaration's `export` modifier belongs to it, so
  // it starts where ESTree's wrapper does.
  tsStart(node: Node): number {
    const parent = this.parentOf(node);
    if (parent !== undefined && EXPORT_WRAPPERS.has(parent.type)) {
      if (nodeField(parent, "declaration") === node && isDeclarationStatement(node)) {
        return parent.start;
      }
    }
    return node.start;
  }

  lineOf(position: number): number {
    const starts = this.lineStarts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= position) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }

  startLine(node: Node): number {
    return this.lineOf(this.tsStart(node));
  }

  // 1-based, in UTF-16 code units: the column an editor's `file:line:col` jump lands on.
  startColumn(node: Node): number {
    const start = this.tsStart(node);
    return start - (this.lineStarts[this.lineOf(start) - 1] ?? 0) + 1;
  }

  endLine(node: Node): number {
    return this.lineOf(node.end);
  }

  lineCount(): number {
    return this.lineOf(this.text.length);
  }

  textOf(node: Node): string {
    return this.text.slice(node.start, node.end);
  }
}

function isDeclarationStatement(node: Node): boolean {
  switch (node.type) {
    case "FunctionDeclaration":
    case "TSDeclareFunction":
    case "ClassDeclaration":
    case "VariableDeclaration":
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
    case "TSModuleDeclaration":
    case "TSImportEqualsDeclaration":
      return true;
    default:
      return false;
  }
}
