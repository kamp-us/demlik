import { nameText } from "../extract/functions.js";
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

function localTypes(syntax: SyntaxFile): Map<string, SyntaxNode[]> {
  const types = new Map<string, SyntaxNode[]>();
  for (const statement of syntax.program.body) {
    const node = nodeField(statement, "declaration") ?? statement;
    if (node.type !== "TSTypeAliasDeclaration" && node.type !== "TSInterfaceDeclaration") continue;
    const declarations = types.get(node.id.name) ?? [];
    declarations.push(node);
    types.set(node.id.name, declarations);
  }
  return types;
}

function functionType(
  node: SyntaxNode,
  types: ReadonlyMap<string, SyntaxNode[]>,
  seen = new Set<string>(),
): SyntaxNode | null {
  if (node.type === "TSTypeAliasDeclaration" || node.type === "TSParenthesizedType") {
    return functionType(node.typeAnnotation, types, seen);
  }
  if (node.type === "TSFunctionType") return node;
  const name = referenceName(node);
  if (name === null || seen.has(name) || nodeField(node, "typeArguments") !== null) return null;
  const target = types.get(name)?.[0];
  if (target === undefined) return null;
  return (
    functionType(target, types, new Set([...seen, name])) ??
    (/^For[A-Z]/.test(name) ? nodeField(target, "typeAnnotation") : null)
  );
}

function memberOf(
  node: SyntaxNode,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode[]>,
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
  types: ReadonlyMap<string, SyntaxNode[]>,
  file: string,
  seen = new Set<string>(),
): HexagonMember[] | null {
  if (node.type === "TSParenthesizedType") {
    return objectMembers(node.typeAnnotation, syntax, types, file, seen);
  }
  if (node.type === "TSTypeAliasDeclaration") {
    const members = objectMembers(node.typeAnnotation, syntax, types, file, seen);
    if (members !== null && node.typeParameters !== null) {
      unreadable(node, syntax, file, "generic bag");
    }
    return members;
  }
  const name = referenceName(node);
  if (name !== null) return referenceMembers(name, node, syntax, types, file, seen);
  if (node.type === "TSIntersectionType") {
    return intersectionMembers(node, syntax, types, file, seen);
  }
  if (node.type === "TSInterfaceDeclaration") {
    return interfaceMembers(node, syntax, types, file, seen);
  }
  if (node.type !== "TSTypeLiteral") return null;
  return bagMembers(node.members, syntax, types, file);
}

function referenceMembers(
  name: string,
  node: SyntaxNode,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode[]>,
  file: string,
  seen: Set<string>,
): HexagonMember[] | null {
  if (seen.has(name)) throw new Error(`cyclic bag in ports.ts: ${name}`);
  const target = types.get(name);
  if (target === undefined) return null;
  const parts = target.map((declaration) =>
    objectMembers(declaration, syntax, types, file, new Set([...seen, name])),
  );
  const members = parts.every((part) => part === null) ? null : parts.flatMap((part) => part ?? []);
  if (members !== null && nodeField(node, "typeArguments") !== null) {
    unreadable(node, syntax, file, "generic bag instantiation");
  }
  return members;
}

function interfaceMembers(
  node: Extract<SyntaxNode, { type: "TSInterfaceDeclaration" }>,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode[]>,
  file: string,
  seen: Set<string>,
): HexagonMember[] {
  if (node.typeParameters !== null) unreadable(node, syntax, file, "generic bag");
  const inherited = node.extends.flatMap(
    (base) => objectMembers(base, syntax, types, file, seen) ?? [],
  );
  return [...inherited, ...bagMembers(node.body.body, syntax, types, file)];
}

function intersectionMembers(
  node: Extract<SyntaxNode, { type: "TSIntersectionType" }>,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode[]>,
  file: string,
  seen: Set<string>,
): HexagonMember[] | null {
  const parts = node.types.map((part) => objectMembers(part, syntax, types, file, seen));
  return parts.every((part) => part === null) ? null : parts.flatMap((part) => part ?? []);
}

function unreadable(node: SyntaxNode, syntax: SyntaxFile, file: string, shape: string): never {
  let declaration: SyntaxNode | undefined = node;
  while (declaration !== undefined) {
    if (
      declaration.type === "TSTypeAliasDeclaration" ||
      declaration.type === "TSInterfaceDeclaration"
    ) {
      throw new Error(
        `${file}:${syntax.startLine(node)}: cannot read ${declaration.id.name}: ${shape}`,
      );
    }
    declaration = syntax.parentOf(declaration);
  }
  throw new Error(`${file}:${syntax.startLine(node)}: cannot read ${shape}`);
}

function bagMembers(
  nodes: SyntaxNode[],
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode[]>,
  file: string,
): HexagonMember[] {
  return nodes.flatMap((node) => {
    if (node.type === "TSIndexSignature") unreadable(node, syntax, file, "index-signature bag");
    return memberOf(node, syntax, types) ?? [];
  });
}

function exportedTypes(syntax: SyntaxFile): { local: string; name: string }[] {
  return syntax.program.body.flatMap((statement) => {
    if (statement.type !== "ExportNamedDeclaration" || statement.source !== null) return [];
    const declaration = statement.declaration;
    if (
      declaration?.type === "TSTypeAliasDeclaration" ||
      declaration?.type === "TSInterfaceDeclaration"
    ) {
      return [{ local: declaration.id.name, name: declaration.id.name }];
    }
    return statement.specifiers.map((specifier) => ({
      local: specifier.local.type === "Identifier" ? specifier.local.name : specifier.local.value,
      name:
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : specifier.exported.value,
    }));
  });
}

function referencedTypes(
  node: SyntaxNode,
  syntax: SyntaxFile,
  types: ReadonlyMap<string, SyntaxNode[]>,
  seen: Set<string>,
): void {
  const name = referenceName(node);
  if (name !== null && !seen.has(name)) {
    seen.add(name);
    const target = types.get(name);
    for (const declaration of target ?? []) referencedTypes(declaration, syntax, types, seen);
  }
  for (const child of syntax.children(node)) referencedTypes(child, syntax, types, seen);
}

export function readPorts(
  syntax: SyntaxFile,
  file: string,
): {
  bags: HexagonBag[];
  unbaggedPorts: HexagonPort[];
} {
  const types = localTypes(syntax);
  const exported = new Map(exportedTypes(syntax).map(({ local, name }) => [name, local]));
  const bags: HexagonBag[] = [];
  const used = new Set<string>();
  for (const [name, local] of exported) {
    const declarations = types.get(local);
    if (declarations === undefined) continue;
    const parts = declarations.map((node) =>
      objectMembers(node, syntax, types, file, new Set([local])),
    );
    if (parts.every((part) => part === null)) continue;
    const members = parts.flatMap((part) => part ?? []);
    for (const node of declarations) referencedTypes(node, syntax, types, used);
    const unique = new Map(members.map((member) => [JSON.stringify(member), member]));
    bags.push({
      name,
      members: [...unique.values()].sort(
        (a, b) => lexical(a.name, b.name) || lexical(a.type, b.type),
      ),
    });
  }
  const unbaggedPorts = [...types]
    .flatMap(([name, declarations]) =>
      declarations.flatMap((node) =>
        node.type === "TSTypeAliasDeclaration" && /^For[A-Z]/.test(name) && !used.has(name)
          ? [{ name, type: syntax.textOf(node.typeAnnotation) }]
          : [],
      ),
    )
    .sort((a, b) => lexical(a.name, b.name));
  return { bags: bags.sort((a, b) => lexical(a.name, b.name)), unbaggedPorts };
}
