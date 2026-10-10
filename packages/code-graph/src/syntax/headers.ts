import { nameText } from "../extract/functions.js";
import type { FunctionHeader, OverloadSignature } from "../schema.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "./file.js";

// SPEC §6 A5. A header is a verbatim slice of the file: it starts where the node's `startLine`
// places it (an exported declaration's `export` included, a member's modifiers included) and ends
// at the last token before the body, so an arrow's header ends on its `=>`. Whitespace and comments
// between that token and the body are not part of it. A node with no body (an interface accessor,
// a bodiless member) runs to its end, less the `;` or `,` that closes it.

const MEMBER_HOSTS = new Set(["MethodDefinition", "TSAbstractMethodDefinition", "Property"]);

const EXPORT_WRAPPERS = new Set(["ExportNamedDeclaration", "ExportDefaultDeclaration"]);

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

// The last position before `end` that is not whitespace or a comment, never before `start`.
function retreatOverTrivia(syntax: SyntaxFile, start: number, end: number): number {
  let at = end;
  for (;;) {
    while (at > start && isSpace(syntax.text[at - 1])) at--;
    const commentStart = syntax.commentStartEndingAt(at);
    if (commentStart === null || commentStart < start) return at;
    at = commentStart;
  }
}

function signatureEnd(syntax: SyntaxFile, start: number, end: number): number {
  const at = retreatOverTrivia(syntax, start, end);
  const last = syntax.text[at - 1];
  return last === ";" || last === "," ? retreatOverTrivia(syntax, start, at - 1) : at;
}

// The function whose body a node owns: a member's is its value, every other kind's is itself.
function callableOf(node: SyntaxNode): SyntaxNode {
  return MEMBER_HOSTS.has(node.type) ? (nodeField(node, "value") ?? node) : node;
}

function headerText(syntax: SyntaxFile, node: SyntaxNode): string {
  const start = syntax.tsStart(node);
  const body = nodeField(callableOf(node), "body");
  const end =
    body === null
      ? signatureEnd(syntax, start, node.end)
      : retreatOverTrivia(syntax, start, body.start);
  return syntax.text.slice(start, end);
}

function signature(syntax: SyntaxFile, node: SyntaxNode): OverloadSignature {
  const start = syntax.tsStart(node);
  return {
    startLine: syntax.startLine(node),
    text: syntax.text.slice(start, signatureEnd(syntax, start, node.end)),
  };
}

// The statements or members a node sits among, and the one of them that holds it.
function siblingsOf(
  syntax: SyntaxFile,
  node: SyntaxNode,
): { list: readonly SyntaxNode[]; at: SyntaxNode } | null {
  const parent = syntax.parentOf(node);
  if (parent === undefined) return null;
  const at = EXPORT_WRAPPERS.has(parent.type) ? parent : node;
  const container = syntax.parentOf(at);
  return container === undefined ? null : { list: syntax.children(container), at };
}

function declarationOf(statement: SyntaxNode): SyntaxNode {
  return EXPORT_WRAPPERS.has(statement.type)
    ? (nodeField(statement, "declaration") ?? statement)
    : statement;
}

function declaredName(node: SyntaxNode): string | null {
  const id = nodeField(node, "id");
  return id === null ? null : String(field(id, "name"));
}

function memberKey(syntax: SyntaxFile, member: SyntaxNode): string {
  const key = nodeField(member, "key");
  const name = key === null ? "" : nameText(syntax, member, key);
  return `${String(field(member, "static"))}:${String(field(member, "kind"))}:${name}`;
}

type SameSignature = (candidate: SyntaxNode) => boolean;

function overloadTest(syntax: SyntaxFile, node: SyntaxNode): SameSignature | null {
  if (node.type === "FunctionDeclaration") {
    const name = declaredName(node);
    return (candidate) => {
      const declaration = declarationOf(candidate);
      return declaration.type === "TSDeclareFunction" && declaredName(declaration) === name;
    };
  }
  if (node.type === "MethodDefinition") {
    const key = memberKey(syntax, node);
    return (candidate) =>
      candidate.type === "MethodDefinition" &&
      nodeField(candidate, "value")?.type === "TSEmptyBodyFunctionExpression" &&
      memberKey(syntax, candidate) === key;
  }
  return null;
}

// TypeScript requires an implementation's overloads to sit directly before it, so they are the
// unbroken run of same-named bodiless signatures just above it, read back in source order.
function overloadsOf(syntax: SyntaxFile, node: SyntaxNode): OverloadSignature[] {
  if (nodeField(callableOf(node), "body") === null) return [];
  const same = overloadTest(syntax, node);
  const siblings = same === null ? null : siblingsOf(syntax, node);
  if (same === null || siblings === null) return [];
  const run: SyntaxNode[] = [];
  for (let i = siblings.list.indexOf(siblings.at) - 1; i >= 0; i--) {
    const candidate = siblings.list[i];
    if (candidate === undefined || !same(candidate)) break;
    run.push(declarationOf(candidate));
  }
  return run.reverse().map((overload) => signature(syntax, overload));
}

// The header of a function node — the node `discoverFunctions` enumerated, never an overload.
export function functionHeader(syntax: SyntaxFile, node: SyntaxNode): FunctionHeader {
  return { text: headerText(syntax, node), overloads: overloadsOf(syntax, node) };
}
