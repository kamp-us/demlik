import { exportedLocalNames, nameText } from "../extract/functions.js";
import { nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";

export type HexagonMember = { name: string; type: string; signature: string | null };
export type HexagonBag = { name: string; members: HexagonMember[] };
export type HexagonPort = { name: string; type: string };

export function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function referenceName(node: SyntaxNode): string | null {
  const name =
    node.type === "TSTypeReference"
      ? nodeField(node, "typeName")
      : node.type === "TSInterfaceHeritage"
        ? nodeField(node, "expression")
        : null;
  return name?.type === "Identifier" ? name.name : null;
}

function localTypes(syntax: SyntaxFile): Map<string, SyntaxNode> {
  const types = new Map<string, SyntaxNode>();
  for (const statement of syntax.program.body) {
    const node = nodeField(statement, "declaration") ?? statement;
    if (node.type === "TSTypeAliasDeclaration") types.set(node.id.name, node.typeAnnotation);
    if (node.type === "TSInterfaceDeclaration") types.set(node.id.name, node);
  }
  return types;
}

function functionType(
  node: SyntaxNode,
  types: ReadonlyMap<string, SyntaxNode>,
  seen = new Set<string>(),
): SyntaxNode | null {
  if (node.type === "TSFunctionType") return node;
  const name = referenceName(node);
  if (name === null || seen.has(name) || nodeField(node, "typeArguments") !== null) return null;
  const target = types.get(name);
  if (target === undefined) return null;
  return (
    functionType(target, types, new Set([...seen, name])) ??
    (/^For[A-Z]/.test(name) ? target : null)
  );
}

function memberOf(
  node: SyntaxNode,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode>,
): HexagonMember | null {
  if (node.type !== "TSPropertySignature" && node.type !== "TSMethodSignature") return null;
  const name = nameText(syntax, node, node.key) + (node.optional ? "?" : "");
  if (node.type === "TSMethodSignature") {
    const type = syntax.text.slice(node.key.end, node.end).replace(/[;,]$/, "");
    return { name, type, signature: null };
  }
  const type = node.typeAnnotation?.typeAnnotation;
  if (type === undefined) return { name, type: "unknown", signature: null };
  const signature = functionType(type, types);
  return {
    name,
    type: syntax.textOf(type),
    signature: signature === null ? null : syntax.textOf(signature),
  };
}

function objectMembers(
  node: SyntaxNode,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode>,
  seen = new Set<string>(),
): HexagonMember[] | null {
  const name = referenceName(node);
  if (name !== null) {
    if (seen.has(name)) throw new Error(`cyclic bag in ports.ts: ${name}`);
    const target = types.get(name);
    return target === undefined
      ? null
      : objectMembers(target, syntax, types, new Set([...seen, name]));
  }
  if (node.type === "TSIntersectionType") {
    return intersectionMembers(node, syntax, types, seen);
  }
  if (node.type === "TSInterfaceDeclaration") {
    const inherited = interfaceMembers(node, syntax, types, seen);
    return [...inherited, ...node.body.body.flatMap((m) => memberOf(m, syntax, types) ?? [])];
  }
  if (node.type !== "TSTypeLiteral") return null;
  return node.members.flatMap((member) => memberOf(member, syntax, types) ?? []);
}

function intersectionMembers(
  node: Extract<SyntaxNode, { type: "TSIntersectionType" }>,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode>,
  seen: Set<string>,
): HexagonMember[] | null {
  const parts = node.types.map((part) => objectMembers(part, syntax, types, seen));
  return parts.every((part) => part === null) ? null : parts.flatMap((part) => part ?? []);
}

function interfaceMembers(
  node: Extract<SyntaxNode, { type: "TSInterfaceDeclaration" }>,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode>,
  seen: Set<string>,
): HexagonMember[] {
  return node.extends.flatMap((base) => {
    if (base.expression.type !== "Identifier") return [];
    const name = base.expression.name;
    if (seen.has(name)) throw new Error(`cyclic bag in ports.ts: ${name}`);
    const target = types.get(name);
    return target === undefined
      ? []
      : (objectMembers(target, syntax, types, new Set([...seen, name])) ?? []);
  });
}

function referencedTypes(
  node: SyntaxNode,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode>,
  seen: Set<string>,
): void {
  const name = referenceName(node);
  if (name !== null && !seen.has(name)) {
    seen.add(name);
    const target = types.get(name);
    if (target !== undefined) referencedTypes(target, syntax, types, seen);
  }
  for (const child of syntax.children(node)) referencedTypes(child, syntax, types, seen);
}

export function readPorts(syntax: SyntaxFile): {
  bags: HexagonBag[];
  unbaggedPorts: HexagonPort[];
} {
  const types = localTypes(syntax);
  const exported = exportedLocalNames(syntax);
  const bags: HexagonBag[] = [];
  const used = new Set<string>();
  for (const [name, node] of types) {
    if (!exported.has(name)) continue;
    const members = objectMembers(node, syntax, types, new Set([name]));
    if (members === null) continue;
    referencedTypes(node, syntax, types, used);
    const unique = new Map(members.map((member) => [JSON.stringify(member), member]));
    bags.push({
      name,
      members: [...unique.values()].sort(
        (a, b) => lexical(a.name, b.name) || lexical(a.type, b.type),
      ),
    });
  }
  const unbaggedPorts = [...types]
    .filter(([name]) => /^For[A-Z]/.test(name) && !used.has(name))
    .map(([name, node]) => ({ name, type: syntax.textOf(node) }))
    .sort((a, b) => lexical(a.name, b.name));
  return { bags: bags.sort((a, b) => lexical(a.name, b.name)), unbaggedPorts };
}
