import { nameText } from "../extract/functions.js";
import { nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";

// A bag read from the one file `ports.ts`: the property signatures of every part it is written from.
// A part is a type literal, an operand of an intersection, an interface it extends, or the
// declaration an alias points at. A bag is read whole or not at all, so a failure in any part is the
// reason for the bag, and no member of it is printed.

const SHAPES: Readonly<Record<string, string>> = {
  TSMappedType: "mapped type",
  TSConditionalType: "conditional type",
  TSUnionType: "union type",
  TSParenthesizedType: "parenthesized type",
  TSIndexSignature: "index signature",
  TSCallSignatureDeclaration: "call signature",
  TSConstructSignatureDeclaration: "construct signature",
  TSMethodSignature: "method or accessor",
  TSModuleDeclaration: "namespace declaration",
};

// Where `ports.ts` declares each name, and which names it imports.
export type Scope = {
  readonly syntax: SyntaxFile;
  readonly declared: ReadonlyMap<string, readonly SyntaxNode[]>;
  readonly imported: ReadonlySet<string>;
};

export type Parts = { readonly members: readonly SyntaxNode[] } | { readonly reason: string };

// The names a part was reached through, the bag itself first. A failure inside an operand names that
// operand, the innermost one.
type Trail = readonly string[];

export function scopeOf(syntax: SyntaxFile): Scope {
  const declared = new Map<string, SyntaxNode[]>();
  const imported = new Set<string>();
  for (const statement of syntax.program.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) imported.add(specifier.local.name);
      continue;
    }
    const node = nodeField(statement, "declaration") ?? statement;
    const id = nodeField(node, "id");
    if (id === null) continue;
    const name = nameText(syntax, node, id);
    declared.set(name, [...(declared.get(name) ?? []), node]);
  }
  return { syntax, declared, imported };
}

export function readBag(scope: Scope, node: SyntaxNode, name: string): Parts {
  const parts = declarationParts(scope, node, [name]);
  if ("reason" in parts) return parts;
  const names = namesOf(scope, parts.members);
  const repeated = names.find((candidate, index) => names.indexOf(candidate) !== index);
  return repeated === undefined ? parts : { reason: `member ${repeated} written in two parts` };
}

function unread(reason: string, trail: Trail): Parts {
  const operand = trail.slice(1).at(-1);
  return { reason: operand === undefined ? reason : `operand ${operand}: ${reason}` };
}

// A declaration reached by two paths, as the base of a diamond of `extends` is, gives its members
// once: they are the same nodes.
function join(parts: readonly Parts[]): Parts {
  const failed = parts.find((part) => "reason" in part);
  if (failed !== undefined) return failed;
  return {
    members: [...new Set(parts.flatMap((part) => ("members" in part ? part.members : [])))],
  };
}

function declarationParts(scope: Scope, node: SyntaxNode, trail: Trail): Parts {
  if (node.type !== "TSTypeAliasDeclaration" && node.type !== "TSInterfaceDeclaration")
    return unread(SHAPES[node.type] ?? "not a port or bag declaration", trail);
  if (node.typeParameters !== null) return unread("generic bag", trail);
  if (node.type === "TSTypeAliasDeclaration") return typeParts(scope, node.typeAnnotation, trail);
  return join([
    ...node.extends.map(({ expression, typeArguments }) =>
      referenceParts(scope, expression, typeArguments, trail),
    ),
    listParts(scope, node.body.body, trail),
  ]);
}

function typeParts(scope: Scope, type: SyntaxNode, trail: Trail): Parts {
  switch (type.type) {
    case "TSTypeLiteral":
      return listParts(scope, type.members, trail);
    case "TSIntersectionType":
      return join(type.types.map((operand) => typeParts(scope, operand, trail)));
    case "TSTypeReference":
      return referenceParts(scope, type.typeName, type.typeArguments, trail);
    default:
      return unread(SHAPES[type.type] ?? "not a port or plain bag", trail);
  }
}

// A name a part points at has to be one declaration in this file, which is then read as a part of
// its own. The reader has no module resolution, so a name from another file is a reason, not a guess.
function referenceParts(
  scope: Scope,
  target: SyntaxNode,
  typeArguments: SyntaxNode | null,
  trail: Trail,
): Parts {
  if (target.type !== "Identifier")
    return unread("qualified name", [...trail, scope.syntax.textOf(target)]);
  const name = target.name;
  const through = [...trail, name];
  if (typeArguments !== null) return unread("generic bag", through);
  const [declaration, ...others] = scope.declared.get(name) ?? [];
  if (declaration === undefined) {
    const reason = scope.imported.has(name)
      ? "imported from another file"
      : "not declared in ports.ts";
    return unread(reason, through);
  }
  if (others.length > 0) return unread("multiple declarations", through);
  if (trail.includes(name)) return { reason: "cyclic alias" };
  return declarationParts(scope, declaration, through);
}

function memberReason(member: SyntaxNode): string | null {
  if (member.type !== "TSPropertySignature") return SHAPES[member.type] ?? "non-property member";
  if (member.computed) return "computed property";
  if (member.typeAnnotation === null) return "property without type";
  return null;
}

function namesOf(scope: Scope, members: readonly SyntaxNode[]): string[] {
  return members.flatMap((member) =>
    member.type === "TSPropertySignature" ? [nameText(scope.syntax, member, member.key)] : [],
  );
}

function listParts(scope: Scope, members: readonly SyntaxNode[], trail: Trail): Parts {
  const reason = members.map(memberReason).find((found): found is string => found !== null);
  if (reason !== undefined) return unread(reason, trail);
  const names = namesOf(scope, members);
  return new Set(names).size === names.length ? { members } : unread("duplicate member", trail);
}
