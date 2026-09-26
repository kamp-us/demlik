import {
  field,
  isAccessorKind,
  nodeField,
  type SyntaxFile,
  type SyntaxNode,
} from "../syntax/file.js";
import type { CommentRange } from "../syntax/trivia.js";
import type { DiscoveredFunction } from "./functions.js";
import { isClassField, isPropertyAssignment } from "./functions.js";
import { toRelative } from "./project.js";

export type CommentSpan = { readonly pos: number; readonly end: number; readonly text: string };

export type FunctionMetrics = {
  loc: number;
  commentLines: number;
  nestingDepth: number;
  complexity: number;
};

const COMPLEXITY_STATEMENT_KINDS = new Set([
  "IfStatement",
  "ConditionalExpression", // ternary
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
]);

const COMPLEXITY_OPERATORS = new Set(["&&", "||", "??"]);

const DEPTH_INCREASING_KINDS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "CatchClause",
]);

const CLASS_MEMBERS = new Set(["MethodDefinition", "TSAbstractMethodDefinition"]);

function countsTowardComplexity(node: SyntaxNode): boolean {
  if (COMPLEXITY_STATEMENT_KINDS.has(node.type)) return true;
  if (node.type === "SwitchCase") return nodeField(node, "test") !== null; // each case, NOT default
  return (
    node.type === "LogicalExpression" && COMPLEXITY_OPERATORS.has(String(field(node, "operator")))
  );
}

function isBoundExpressionCallable(syntax: SyntaxFile, node: SyntaxNode): boolean {
  const parent = syntax.parentOf(node);
  if (parent === undefined) return false;
  if (
    parent.type === "VariableDeclarator" ||
    isPropertyAssignment(parent, syntax.parentOf(parent)) ||
    isClassField(parent) ||
    parent.type === "ExportDefaultDeclaration" ||
    parent.type === "TSExportAssignment"
  ) {
    return true;
  }
  return node.type === "FunctionExpression" && nodeField(node, "id") !== null;
}

function isObjectMember(syntax: SyntaxFile, node: SyntaxNode): boolean {
  return (
    node.type === "Property" &&
    syntax.parentOf(node)?.type === "ObjectExpression" &&
    (field(node, "method") === true || isAccessorKind(node))
  );
}

function isNamedCallableBoundary(syntax: SyntaxFile, node: SyntaxNode): boolean {
  if (node.type === "FunctionDeclaration") return nodeField(node, "id") !== null;
  if (CLASS_MEMBERS.has(node.type) || isObjectMember(syntax, node)) return true;
  if (node.type === "TSMethodSignature") return isAccessorKind(node);
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return isBoundExpressionCallable(syntax, node);
  }
  return false;
}

function isDepthIncreasing(syntax: SyntaxFile, node: SyntaxNode): boolean {
  if (node.type === "BlockStatement") return syntax.parentOf(node)?.type === "IfStatement";
  if (DEPTH_INCREASING_KINDS.has(node.type)) return true;
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return !isNamedCallableBoundary(syntax, node);
  }
  return false;
}

function walkBody(
  syntax: SyntaxFile,
  fnNode: SyntaxNode,
): { complexity: number; nestingDepth: number } {
  let complexity = 1;
  let maxDepth = 0;

  function recurse(node: SyntaxNode, depth: number): void {
    for (const child of syntax.tsChildren(node)) {
      if (isNamedCallableBoundary(syntax, child)) continue;
      if (countsTowardComplexity(child)) complexity += 1;
      const childDepth = isDepthIncreasing(syntax, child) ? depth + 1 : depth;
      if (childDepth > maxDepth) maxDepth = childDepth;
      recurse(child, childDepth);
    }
  }

  for (const child of syntax.tsChildren(fnNode)) {
    if (countsTowardComplexity(child)) complexity += 1;
    const childDepth = isDepthIncreasing(syntax, child) ? 1 : 0;
    if (childDepth > maxDepth) maxDepth = childDepth;
    recurse(child, childDepth);
  }

  return { complexity, nestingDepth: maxDepth };
}

// The positions TypeScript's tree has a node boundary at, beyond the ESTree nodes themselves: the
// operator and punctuation tokens `forEachChild` visits as nodes of their own.
function tokenStarts(syntax: SyntaxFile, node: SyntaxNode): number[] {
  const trivia = syntax.trivia;
  switch (node.type) {
    case "LogicalExpression":
    case "BinaryExpression":
    case "AssignmentExpression": {
      const left = nodeField(node, "left");
      return left === null ? [] : [trivia.nextTokenStart(left.end)];
    }
    case "ConditionalExpression": {
      const test = nodeField(node, "test");
      const consequent = nodeField(node, "consequent");
      if (test === null || consequent === null) return [];
      return [trivia.nextTokenStart(test.end), trivia.nextTokenStart(consequent.end)];
    }
    case "ArrowFunctionExpression": {
      const body = nodeField(node, "body");
      return body === null ? [] : [trivia.previousTokenEnd(body.start) - 2];
    }
    default:
      return memberModifierStart(syntax, node);
  }
}

function tokenEnds(syntax: SyntaxFile, node: SyntaxNode): number[] {
  const text = syntax.text;
  return tokenStarts(syntax, node).map((start) => {
    const ch = text[start];
    if (ch === "?" || ch === ":") return start + 1;
    if (node.type === "ArrowFunctionExpression") return start + 2;
    const operator = field(node, "operator");
    return typeof operator === "string" ? start + operator.length : start;
  });
}

function memberModifierStart(syntax: SyntaxFile, node: SyntaxNode): number[] {
  const decorators = field(node, "decorators");
  if (!Array.isArray(decorators) || decorators.length === 0) return [];
  const last = decorators[decorators.length - 1] as SyntaxNode;
  return [syntax.trivia.nextTokenStart(last.end)];
}

const WRAPPED_SKIPS_START = new Set([
  "FunctionDeclaration",
  "TSDeclareFunction",
  "ClassDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "TSModuleDeclaration",
  "TSImportEqualsDeclaration",
]);

function hasTsStart(syntax: SyntaxFile, node: SyntaxNode): boolean {
  if (node.type === "TSTypeAnnotation" || node.type === "ClassBody") return false;
  if (!WRAPPED_SKIPS_START.has(node.type)) return true;
  return syntax.tsStart(node) === node.start;
}

type BoundaryVisitor = {
  readonly start: (position: number) => void;
  readonly end: (position: number) => void;
};

function visitBoundaries(syntax: SyntaxFile, root: SyntaxNode, visitor: BoundaryVisitor): void {
  syntax.forEachTsDescendant(root, (node) => {
    if (hasTsStart(syntax, node)) visitor.start(node.start);
    visitor.end(node.end);
    for (const start of tokenStarts(syntax, node)) visitor.start(start);
    for (const end of tokenEnds(syntax, node)) visitor.end(end);
  });
}

export function commentLineSpan(
  syntax: SyntaxFile,
  span: CommentRange,
): { startLine: number; endLine: number } {
  return { startLine: syntax.lineOf(span.pos), endLine: syntax.lineOf(span.end) };
}

export function commentLineNumbers(
  syntax: SyntaxFile,
  ranges: readonly CommentRange[],
): Set<number> {
  const lines = new Set<number>();
  for (const r of ranges) {
    const { startLine, endLine } = commentLineSpan(syntax, r);
    for (let l = startLine; l <= endLine; l++) lines.add(l);
  }
  return lines;
}

export function countCommentLines(syntax: SyntaxFile, ranges: readonly CommentRange[]): number {
  return commentLineNumbers(syntax, ranges).size;
}

function functionCommentLines(syntax: SyntaxFile, fnNode: SyntaxNode): number {
  const trivia = syntax.trivia;
  const spanStart = syntax.tsStart(fnNode);
  const spanEnd = fnNode.end;
  const ranges: CommentRange[] = [...trivia.leadingAt(spanStart)];
  const within = (found: readonly CommentRange[]): void => {
    for (const r of found) if (r.pos >= spanStart && r.pos < spanEnd) ranges.push(r);
  };
  visitBoundaries(syntax, fnNode, {
    start: (position) => within(trivia.leadingAt(position)),
    end: (position) => within(trivia.trailingAt(position)),
  });
  return countCommentLines(syntax, ranges);
}

export function computeFunctionMetrics(
  fn: Pick<DiscoveredFunction, "node" | "unit">,
): FunctionMetrics {
  const syntax = fn.unit.syntax;
  const startLine = syntax.startLine(fn.node);
  const endLine = syntax.endLine(fn.node);
  const { complexity, nestingDepth } = walkBody(syntax, fn.node);
  return {
    loc: endLine - startLine + 1,
    commentLines: functionCommentLines(syntax, fn.node),
    nestingDepth,
    complexity,
  };
}

const CLOSERS = new Set(["}", ")", "]", ";"]);

// TypeScript's `getChildren()` ends a node on its closing token, and a comment on its own line before
// that token belongs to nothing forEachChild visits; the module count reaches it through the token.
function closingTokenStarts(syntax: SyntaxFile, node: SyntaxNode): number[] {
  const out: number[] = [];
  if (CLOSERS.has(syntax.text[node.end - 1] ?? "")) out.push(node.end - 1);
  if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration") {
    const specifiers = field(node, "specifiers");
    if (Array.isArray(specifiers) && specifiers.length > 0) {
      const last = specifiers[specifiers.length - 1] as SyntaxNode;
      let at = syntax.trivia.nextTokenStart(last.end);
      if (syntax.text[at] === ",") at = syntax.trivia.nextTokenStart(at + 1);
      if (syntax.text[at] === "}") out.push(at);
    }
  }
  return out;
}

function emptyJsxSpan(node: SyntaxNode): CommentRange | null {
  if (node.type !== "JSXExpressionContainer") return null;
  if (nodeField(node, "expression")?.type !== "JSXEmptyExpression") return null;
  const pos = node.start + 1;
  const end = node.end - 1;
  return end > pos ? { pos, end } : null;
}

export function collectModuleCommentRanges(syntax: SyntaxFile): CommentSpan[] {
  const { text, trivia } = syntax;
  const byPos = new Map<number, CommentSpan>();
  const add = (ranges: readonly CommentRange[]): void => {
    for (const { pos, end } of ranges) {
      if (!byPos.has(pos)) byPos.set(pos, { pos, end, text: text.slice(pos, end) });
    }
  };

  visitBoundaries(syntax, syntax.program, {
    start: (position) => add(trivia.leadingAt(position)),
    end: (position) => add(trivia.trailingAt(position)),
  });
  syntax.forEachTsDescendant(syntax.program, (node) => {
    for (const start of closingTokenStarts(syntax, node)) add(trivia.leadingAt(start));
    const span = emptyJsxSpan(node);
    if (span !== null) add([span]);
  });
  add(trivia.leadingAt(text.length));
  add(trivia.trailingAt(text.length));
  return [...byPos.values()].sort((a, b) => a.pos - b.pos);
}

export function moduleCommentLines(syntax: SyntaxFile): number {
  return countCommentLines(syntax, collectModuleCommentRanges(syntax));
}

export function moduleLoc(syntax: SyntaxFile): number {
  return syntax.lineCount();
}

export { toRelative };
