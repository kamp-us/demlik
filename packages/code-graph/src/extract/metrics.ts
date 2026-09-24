import { type CommentRange, Node, type SourceFile, SyntaxKind } from "ts-morph";
import { toRelative } from "./project.js";

export type CommentSpan = { readonly pos: number; readonly end: number; readonly text: string };

export type FunctionMetrics = {
  loc: number;
  commentLines: number;
  nestingDepth: number;
  complexity: number;
};

const COMPLEXITY_STATEMENT_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.ConditionalExpression, // ternary
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CaseClause, // each case, NOT default
  SyntaxKind.CatchClause,
]);

const COMPLEXITY_BINARY_TOKENS = new Set<SyntaxKind>([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

const CLASS_MEMBER_BOUNDARY_KINDS = new Set<SyntaxKind>([
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

const BINDING_PARENT_KINDS = new Set<SyntaxKind>([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.ExportAssignment,
]);

const DEPTH_INCREASING_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.CatchClause,
]);

function isBoundExpressionCallable(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (BINDING_PARENT_KINDS.has(parent.getKind())) return true;
  return Node.isFunctionExpression(node) && node.getName() !== undefined;
}

function isNamedCallableBoundary(node: Node): boolean {
  if (Node.isFunctionDeclaration(node)) return node.getName() !== undefined;
  if (CLASS_MEMBER_BOUNDARY_KINDS.has(node.getKind())) return true;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return isBoundExpressionCallable(node);
  }
  return false;
}

function isDepthIncreasing(node: Node): boolean {
  if (Node.isBlock(node)) {
    const parent = node.getParent();
    return parent !== undefined && Node.isIfStatement(parent);
  }
  if (DEPTH_INCREASING_KINDS.has(node.getKind())) return true;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return !isNamedCallableBoundary(node);
  }
  return false;
}

function walkBody(fnNode: Node): { complexity: number; nestingDepth: number } {
  let complexity = 1;
  let maxDepth = 0;

  function recurse(node: Node, depth: number): void {
    node.forEachChild((child) => {
      if (isNamedCallableBoundary(child)) return;

      const kind = child.getKind();
      if (COMPLEXITY_STATEMENT_KINDS.has(kind) || COMPLEXITY_BINARY_TOKENS.has(kind)) {
        complexity += 1;
      }

      const childDepth = isDepthIncreasing(child) ? depth + 1 : depth;
      if (childDepth > maxDepth) maxDepth = childDepth;
      recurse(child, childDepth);
    });
  }

  fnNode.forEachChild((child) => {
    const kind = child.getKind();
    if (COMPLEXITY_STATEMENT_KINDS.has(kind) || COMPLEXITY_BINARY_TOKENS.has(kind)) {
      complexity += 1;
    }
    const childDepth = isDepthIncreasing(child) ? 1 : 0;
    if (childDepth > maxDepth) maxDepth = childDepth;
    recurse(child, childDepth);
  });

  return { complexity, nestingDepth: maxDepth };
}

export function commentLineSpan(
  sourceFile: SourceFile,
  span: CommentSpan,
): { startLine: number; endLine: number } {
  return {
    startLine: sourceFile.getLineAndColumnAtPos(span.pos).line,
    endLine: sourceFile.getLineAndColumnAtPos(span.end).line,
  };
}

export function commentLineNumbers(
  sourceFile: SourceFile,
  ranges: readonly CommentSpan[],
): Set<number> {
  const lines = new Set<number>();
  for (const r of ranges) {
    const { startLine, endLine } = commentLineSpan(sourceFile, r);
    for (let l = startLine; l <= endLine; l++) lines.add(l);
  }
  return lines;
}

export function countCommentLines(sourceFile: SourceFile, ranges: readonly CommentSpan[]): number {
  return commentLineNumbers(sourceFile, ranges).size;
}

function functionCommentLines(fnNode: Node): number {
  const sf = fnNode.getSourceFile();
  const sfText = fnNode.getSourceFile().getFullText();
  const toSpan = (r: CommentRange): CommentSpan => ({
    pos: r.getPos(),
    end: r.getEnd(),
    text: sfText.slice(r.getPos(), r.getEnd()),
  });
  const ranges: CommentSpan[] = fnNode.getLeadingCommentRanges().map(toSpan);

  const spanStart = fnNode.getStart();
  const spanEnd = fnNode.getEnd();
  fnNode.forEachDescendant((d) => {
    for (const r of [...d.getLeadingCommentRanges(), ...d.getTrailingCommentRanges()]) {
      const pos = r.getPos();
      if (pos >= spanStart && pos < spanEnd) ranges.push(toSpan(r));
    }
  });

  return countCommentLines(sf, ranges);
}

export function computeFunctionMetrics(fnNode: Node): FunctionMetrics {
  const startLine = fnNode.getStartLineNumber();
  const endLine = fnNode.getEndLineNumber();
  const { complexity, nestingDepth } = walkBody(fnNode);
  return {
    loc: endLine - startLine + 1,
    commentLines: functionCommentLines(fnNode),
    nestingDepth,
    complexity,
  };
}

function tokenLevelSpans(node: Node): { pos: number; end: number }[] {
  const spans: { pos: number; end: number }[] = [];
  const children = node.getChildren();
  const lastChild = children[children.length - 1];
  if (lastChild !== undefined) {
    for (const r of lastChild.getLeadingCommentRanges())
      spans.push({ pos: r.getPos(), end: r.getEnd() });
  }
  if (Node.isJsxExpression(node) && node.getExpression() === undefined) {
    const open = node.getFirstChildByKind(SyntaxKind.OpenBraceToken);
    const close = node.getLastChildByKind(SyntaxKind.CloseBraceToken);
    if (open !== undefined && close !== undefined && close.getStart() > open.getEnd()) {
      spans.push({ pos: open.getEnd(), end: close.getStart() });
    }
  }
  return spans;
}

export function collectModuleCommentRanges(sourceFile: SourceFile): CommentSpan[] {
  const text = sourceFile.getFullText();
  const byPos = new Map<number, CommentSpan>();
  const addSpan = (pos: number, end: number): void => {
    if (!byPos.has(pos)) byPos.set(pos, { pos, end, text: text.slice(pos, end) });
  };

  for (const r of sourceFile.getLeadingCommentRanges()) addSpan(r.getPos(), r.getEnd());
  sourceFile.forEachDescendant((d) => {
    for (const r of d.getLeadingCommentRanges()) addSpan(r.getPos(), r.getEnd());
    for (const r of d.getTrailingCommentRanges()) addSpan(r.getPos(), r.getEnd());
    for (const s of tokenLevelSpans(d)) addSpan(s.pos, s.end);
  });
  return [...byPos.values()].sort((a, b) => a.pos - b.pos);
}

export function moduleCommentLines(sourceFile: SourceFile): number {
  return countCommentLines(sourceFile, collectModuleCommentRanges(sourceFile));
}

export function moduleLoc(sourceFile: SourceFile): number {
  return sourceFile.getEndLineNumber();
}

export { toRelative };
