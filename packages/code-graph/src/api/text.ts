import * as ts from "../engine/tsgo.js";

// The text rule of SPEC §13.3: a declaration's emitted text from its first token to the end of its
// statement, with every comment removed, trailing whitespace trimmed, blank lines dropped and
// indentation kept as emitted.

const COMMENT: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);

// Template literal types close a substitution with `}`, which the scanner reads as a brace until
// told otherwise; `holes` holds the brace depth each open substitution started at.
type TemplateState = { depth: number; readonly holes: number[] };

function nextToken(scanner: ts.Scanner, state: TemplateState): ts.SyntaxKind {
  const kind = scanner.scan();
  if (kind === ts.SyntaxKind.TemplateHead) state.holes.push(state.depth);
  if (kind === ts.SyntaxKind.OpenBraceToken) state.depth++;
  if (kind !== ts.SyntaxKind.CloseBraceToken) return kind;
  if (state.holes.at(-1) !== state.depth) {
    state.depth--;
    return kind;
  }
  const rescanned = scanner.reScanTemplateToken(false);
  if (rescanned === ts.SyntaxKind.TemplateTail) state.holes.pop();
  return rescanned;
}

export function withoutComments(text: string): string {
  const scanner = ts.createScanner(false, ts.LanguageVariant.Standard, text);
  const state: TemplateState = { depth: 0, holes: [] };
  let out = "";
  for (let kind = nextToken(scanner, state); kind !== ts.SyntaxKind.EndOfFile; ) {
    if (!COMMENT.has(kind)) out += scanner.getTokenText();
    kind = nextToken(scanner, state);
  }
  return out;
}

export function tidyLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n");
}

// The statement a declaration stands in: a variable's whole variable statement, every other
// declaration itself.
export function statementOf(declaration: ts.Node): ts.Node {
  if (!ts.isVariableDeclaration(declaration)) return declaration;
  const list = declaration.parent;
  return ts.isVariableStatement(list.parent) ? list.parent : declaration;
}

export function declarationText(statement: ts.Node): string {
  const source = statement.getSourceFile();
  const start = ts.isSourceFile(statement) ? 0 : statement.getStart(source);
  return tidyLines(withoutComments(source.text.slice(start, statement.end)));
}
