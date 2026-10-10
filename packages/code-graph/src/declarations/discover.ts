import { exportedLocalNames, isTestFile } from "../extract/functions.js";
import type { SourceUnit } from "../extract/project.js";
import type { DeclarationKind, DeclarationNode, UseSite } from "../schema.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";

export type DiscoveredDeclaration = {
  id: string;
  name: string;
  kind: DeclarationKind;
  file: string;
  line: number;
  isExported: boolean;
  isTest: boolean;
  // The join key the edge pass matches against tsgo's statements: kind, name and the ordinal of
  // that pair in source order, so a merged interface's two halves stay two nodes.
  joinKey: string;
};

type Found = { name: string; kind: DeclarationKind; line: number; exportWrapped: boolean };

const SINGLE_KIND: ReadonlyMap<string, DeclarationKind> = new Map([
  ["TSTypeAliasDeclaration", "type-alias"],
  ["TSInterfaceDeclaration", "interface"],
  ["TSEnumDeclaration", "enum"],
  ["ClassDeclaration", "class"],
]);

const FUNCTION_VALUES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

function identifierName(node: SyntaxNode | null): string | null {
  return node?.type === "Identifier" ? String(field(node, "name")) : null;
}

// A `const` binding is a constant node unless A1 already made it a function node: an arrow or a
// function expression bound straight to the name.
function constantsOf(syntax: SyntaxFile, statement: SyntaxNode, wrapped: boolean): Found[] {
  if (field(statement, "kind") !== "const") return [];
  const out: Found[] = [];
  (field(statement, "declarations") as SyntaxNode[]).forEach((declarator, index) => {
    const name = identifierName(nodeField(declarator, "id"));
    const init = nodeField(declarator, "init");
    if (name === null || (init !== null && FUNCTION_VALUES.has(init.type))) return;
    const line = index === 0 ? syntax.startLine(statement) : syntax.lineOf(declarator.start);
    out.push({ name, kind: "constant", line, exportWrapped: wrapped });
  });
  return out;
}

function declaredIn(syntax: SyntaxFile, statement: SyntaxNode): Found[] {
  const wrapper =
    statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration";
  const inner = wrapper ? nodeField(statement, "declaration") : statement;
  if (inner === null) return [];
  if (inner.type === "VariableDeclaration") return constantsOf(syntax, inner, wrapper);
  const kind = SINGLE_KIND.get(inner.type);
  if (kind === undefined) return [];
  const name = identifierName(nodeField(inner, "id")) ?? (wrapper ? "default" : null);
  if (name === null) return [];
  return [{ name, kind, line: syntax.startLine(inner), exportWrapped: wrapper }];
}

function withOrdinals(
  file: string,
  found: Found[],
): { found: Found; id: string; joinKey: string }[] {
  const totals = new Map<string, number>();
  for (const f of found)
    totals.set(`${f.kind}:${f.name}`, (totals.get(`${f.kind}:${f.name}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  return found.map((f) => {
    const key = `${f.kind}:${f.name}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const suffix = (totals.get(key) ?? 0) > 1 ? `#${ordinal}` : "";
    return { found: f, id: `${file}:${key}${suffix}`, joinKey: `${key}#${ordinal}` };
  });
}

function discoverInFile(unit: SourceUnit): DiscoveredDeclaration[] {
  const { syntax, file } = unit;
  const found = syntax.program.body.flatMap((statement) => declaredIn(syntax, statement));
  if (found.length === 0) return [];
  const exported = exportedLocalNames(syntax);
  const isTest = isTestFile(file);
  return withOrdinals(file, found).map(({ found: f, id, joinKey }) => ({
    id,
    name: f.name,
    kind: f.kind,
    file,
    line: f.line,
    isExported: f.exportWrapped || exported.has(f.name),
    isTest,
    joinKey,
  }));
}

// Every top-level declaration of a loaded file that SPEC §6 A1 gives a declaration node.
export function discoverDeclarations(sourceFiles: readonly SourceUnit[]): DiscoveredDeclaration[] {
  return sourceFiles
    .flatMap(discoverInFile)
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    );
}

// The graph's declaration nodes. `usesById` is the edge pass's answer, `null` when it did not run;
// a declaration it holds no entry for never joined tsgo's tree, so its uses stay unknown too.
export function buildDeclarationNodes(
  sourceFiles: readonly SourceUnit[],
  usesById: ReadonlyMap<string, UseSite[]> | null,
): DeclarationNode[] {
  return discoverDeclarations(sourceFiles).map(({ joinKey: _joinKey, ...node }) => ({
    ...node,
    uses: usesById?.get(node.id) ?? null,
  }));
}
