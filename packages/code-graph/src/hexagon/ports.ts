import { nameText } from "../extract/functions.js";
import { byText } from "../order.js";
import { nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";
import { readBag, type Scope, scopeOf } from "./bag.js";

export type HexagonMember = { name: string; type: string; signature: string | null };
export type HexagonBag = { name: string; members: HexagonMember[] };
export type HexagonPort = { name: string; type: string };
export type NotRead = { file: string; line: number; name: string; reason: string };

// The members of a feature's main bag, or the row that says the bag was not read: a list that was
// not read is never an empty one.
export type PortList = readonly HexagonMember[] | { readonly notRead: NotRead };

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

function isPort(node: SyntaxNode): node is Extract<SyntaxNode, { type: "TSTypeAliasDeclaration" }> {
  if (node.type !== "TSTypeAliasDeclaration") return false;
  return (
    /^For[A-Z]/.test(node.id.name) &&
    ["TSFunctionType", "TSTypeReference"].includes(node.typeAnnotation.type)
  );
}

type Declared =
  | { readonly port: string }
  | { readonly members: readonly SyntaxNode[] }
  | { readonly reason: string };

function readDeclaration(node: SyntaxNode, name: string, scope: Scope): Declared {
  if ((scope.declared.get(name)?.length ?? 0) > 1) return { reason: "multiple declarations" };
  if (!isPort(node)) return readBag(scope, node, name);
  if (node.typeParameters !== null) return { reason: "generic port" };
  return { port: scope.syntax.textOf(node.typeAnnotation) };
}

function readMembers(nodes: readonly SyntaxNode[], syntax: SyntaxFile): HexagonMember[] {
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
    .sort((a, b) => byText(a.name, b.name));
}

export function readPorts(syntax: SyntaxFile | null, notRead: NotRead[]) {
  const bags: HexagonBag[] = [];
  const ports: HexagonPort[] = [];
  if (syntax === null) return { bags, unbaggedPorts: ports };
  const scope = scopeOf(syntax);
  for (const { node, name, reason } of exportEntries(syntax)) {
    const read = reason === "" ? readDeclaration(node, name, scope) : { reason };
    if ("reason" in read) {
      notRead.push({ file: "ports.ts", line: syntax.startLine(node), name, reason: read.reason });
    } else if ("port" in read) {
      ports.push({ name, type: read.port });
    } else {
      bags.push({ name, members: readMembers(read.members, syntax) });
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
    bags: bags.sort((a, b) => byText(a.name, b.name)),
    unbaggedPorts: ports
      .filter((port) => !used.has(port.name))
      .sort((a, b) => byText(a.name, b.name)),
  };
}
