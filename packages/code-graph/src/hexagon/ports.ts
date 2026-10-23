import { nameText } from "../extract/functions.js";
import { nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";

export type HexagonMember = { name: string; type: string; signature: string | null };
export type HexagonBag = { name: string; members: HexagonMember[] };
export type HexagonPort = { name: string; type: string };
export type NotRead = { file: string; line: number; name: string; reason: string };

export function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function declaredName(syntax: SyntaxFile, node: SyntaxNode | null, fallback: string): string {
  const id = node === null ? null : nodeField(node, "id");
  return node === null || id === null ? fallback : nameText(syntax, node, id);
}

function exportEntries(syntax: SyntaxFile) {
  return syntax.program.body.flatMap((statement) => {
    const node = nodeField(statement, "declaration");
    if (statement.type === "ExportDefaultDeclaration") {
      return [
        { node: statement, name: declaredName(syntax, node, "default"), reason: "default export" },
      ];
    }
    if (statement.type === "ExportAllDeclaration") {
      const name = statement.exported === null ? "*" : syntax.textOf(statement.exported);
      return [{ node: statement, name, reason: "re-export" }];
    }
    if (statement.type !== "ExportNamedDeclaration") return otherExports(statement, syntax);
    if (node === null) {
      return statement.specifiers.map((specifier) => ({
        node: specifier,
        name: syntax.textOf(specifier.exported),
        reason: statement.source === null ? "export list" : "re-export",
      }));
    }
    return declarationEntries(node, declaredName(syntax, node, syntax.textOf(node)), syntax);
  });
}

function otherExports(
  node: SyntaxNode,
  syntax: SyntaxFile,
): { node: SyntaxNode; name: string; reason: string }[] {
  if (node.type === "TSModuleDeclaration") {
    return [{ node, name: syntax.textOf(node.id), reason: "module declaration" }];
  }
  const name =
    node.type === "TSExportAssignment"
      ? node.expression
      : node.type === "TSNamespaceExportDeclaration"
        ? node.id
        : null;
  return name === null ? [] : [{ node, name: syntax.textOf(name), reason: "unsupported export" }];
}

function declarationEntries(node: SyntaxNode, name: string, syntax: SyntaxFile) {
  if (node.type !== "VariableDeclaration") return [{ node, name, reason: "" }];
  return node.declarations.map((binding) => ({
    node: binding,
    name: nameText(syntax, binding, binding.id),
    reason: "value declaration",
  }));
}

const SHAPES: Readonly<Record<string, string>> = {
  TSMappedType: "mapped type",
  TSConditionalType: "conditional type",
  TSIntersectionType: "intersection type",
  TSUnionType: "union type",
  TSParenthesizedType: "parenthesized type",
  TSTypeReference: "bag alias",
  TSIndexSignature: "index signature",
  TSCallSignatureDeclaration: "call signature",
  TSConstructSignatureDeclaration: "construct signature",
  TSMethodSignature: "method or accessor",
  TSModuleDeclaration: "namespace declaration",
};

function plainMembers(node: SyntaxNode): SyntaxNode[] | null {
  if (node.type === "TSInterfaceDeclaration") return node.body.body;
  return node.type === "TSTypeLiteral" ? node.members : null;
}

function memberReason(member: SyntaxNode): string | null {
  if (member.type !== "TSPropertySignature") return SHAPES[member.type] ?? "non-property member";
  if (member.computed) return "computed property";
  if (member.typeAnnotation === null) return "property without type";
  return null;
}

function genericReason(node: SyntaxNode, syntax: SyntaxFile): string | null {
  if (node.type !== "TSTypeAliasDeclaration" || node.typeParameters === null) return null;
  const parameters = node.typeParameters.params;
  if (parameters.some((parameter) => parameter.default !== null)) return "defaulted generic alias";
  let implicit = false;
  syntax.forEachTsDescendant(syntax.program, (reference) => {
    if (reference.type !== "TSTypeReference" || reference.typeName.type !== "Identifier") return;
    if (
      reference.typeName.name === node.id.name &&
      reference.typeArguments?.params.length !== parameters.length
    )
      implicit = true;
  });
  return implicit ? "generic port requires explicit arguments" : null;
}

function isPort(node: SyntaxNode): boolean {
  if (node.type !== "TSTypeAliasDeclaration") return false;
  return (
    /^For[A-Z]/.test(node.id.name) &&
    ["TSFunctionType", "TSTypeReference"].includes(node.typeAnnotation.type)
  );
}

function bagReason(node: SyntaxNode, body: SyntaxNode, syntax: SyntaxFile): string | null {
  if (nodeField(node, "typeParameters") !== null) return "generic bag";
  if (node.type === "TSInterfaceDeclaration" && node.extends.length > 0) return "interface extends";
  const members = plainMembers(body);
  if (members === null) return SHAPES[body.type] ?? "not a port or plain bag";
  const names = members.map((member) => {
    const key = nodeField(member, "key");
    return key === null ? "" : nameText(syntax, member, key);
  });
  return (
    members.map(memberReason).find((reason) => reason !== null) ??
    (new Set(names).size !== names.length ? "duplicate member" : null)
  );
}

function declarationReason(node: SyntaxNode, syntax: SyntaxFile): string | null {
  if (isPort(node)) return genericReason(node, syntax);
  if (node.type !== "TSTypeAliasDeclaration" && node.type !== "TSInterfaceDeclaration")
    return SHAPES[node.type] ?? "not a port or bag declaration";
  return bagReason(
    node,
    node.type === "TSTypeAliasDeclaration" ? node.typeAnnotation : node,
    syntax,
  );
}

function readMembers(nodes: SyntaxNode[], syntax: SyntaxFile): HexagonMember[] {
  return nodes
    .flatMap((member) =>
      member.type === "TSPropertySignature" && member.typeAnnotation !== null
        ? [
            {
              name: nameText(syntax, member, member.key) + (member.optional ? "?" : ""),
              type: syntax.textOf(member.typeAnnotation.typeAnnotation),
              signature: null,
            },
          ]
        : [],
    )
    .sort((a, b) => lexical(a.name, b.name));
}

function declarationCounts(syntax: SyntaxFile): Map<string, number> {
  const counts = new Map<string, number>();
  for (const statement of syntax.program.body) {
    const node = nodeField(statement, "declaration") ?? statement;
    const id = nodeField(node, "id");
    if (id === null) continue;
    const name = nameText(syntax, node, id);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function readPorts(syntax: SyntaxFile | null, notRead: NotRead[]) {
  const bags: HexagonBag[] = [];
  const ports: HexagonPort[] = [];
  if (syntax === null) return { bags, unbaggedPorts: ports };
  const counts = declarationCounts(syntax);
  for (const { node, name, reason: exportReason } of exportEntries(syntax)) {
    const reason =
      exportReason ||
      ((counts.get(name) ?? 0) > 1 ? "multiple declarations" : declarationReason(node, syntax));
    if (reason !== null) {
      notRead.push({ file: "ports.ts", line: syntax.startLine(node), name, reason });
      continue;
    }
    const body = node.type === "TSTypeAliasDeclaration" ? node.typeAnnotation : node;
    const members = plainMembers(body);
    if (members === null) {
      ports.push({ name, type: syntax.textOf(body) });
    } else {
      bags.push({ name, members: readMembers(members, syntax) });
    }
  }
  return summarizePorts(bags, ports);
}

function summarizePorts(bags: HexagonBag[], ports: HexagonPort[]) {
  const signatures = new Map(ports.map((port) => [port.name, port.type]));
  const used = new Set<string>();
  for (const bag of bags)
    for (const member of bag.members) {
      used.add(member.type);
      member.signature = signatures.get(member.type) ?? null;
    }
  return {
    bags: bags.sort((a, b) => lexical(a.name, b.name)),
    unbaggedPorts: ports
      .filter((port) => !used.has(port.name))
      .sort((a, b) => lexical(a.name, b.name)),
  };
}
