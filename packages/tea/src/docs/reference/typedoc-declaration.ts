/**
 * Print a typedoc JSON declaration as the TypeScript a reader would write.
 *
 * The reference page answers "what does this function take" and "what shape is
 * this type", and the typedoc model already holds both as a tree of type nodes.
 * This module is the one place that tree becomes text. Like the model parse it
 * sits behind, it trusts nothing structurally: every node is checked before it
 * is read, and a node kind it does not know is an error rather than a guess —
 * a signature printed wrong is worse than a build that stops.
 */

type Node = Record<string, unknown>;

export function isRecord(x: unknown): x is Node {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// typedoc ReflectionKind bitflags — only the ones a printed declaration meets.
const KIND_VARIABLE = 32;
const KIND_FUNCTION = 64;
const KIND_CLASS = 128;
const KIND_INTERFACE = 256;
const KIND_CONSTRUCTOR = 512;
const KIND_PROPERTY = 1024;
const KIND_METHOD = 2048;
const KIND_CONSTRUCTOR_SIGNATURE = 16384;
const KIND_ACCESSOR = 262144;
const KIND_TYPE_ALIAS = 2097152;

/** Past this many columns a parameter list or a union breaks one item per line. */
const WIDTH = 80;

function nodes(x: unknown): Node[] {
  return Array.isArray(x) ? x.filter(isRecord) : [];
}

function text(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function flag(node: Node, name: string): boolean {
  return isRecord(node.flags) && node.flags[name] === true;
}

/** Indent every line after the first, so a multi-line part nests where it sits. */
function nest(body: string): string {
  return body.replace(/\n/g, "\n  ");
}

function fitsOneLine(line: string): boolean {
  return !line.includes("\n") && line.length <= WIDTH;
}

/** A property or method name, quoted when it is not a plain identifier. */
function memberName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  // A bigint literal: typedoc splits the sign from the digits.
  if (isRecord(value) && typeof value.value === "string") {
    return `${value.negative === true ? "-" : ""}${value.value}n`;
  }
  throw new Error("typedoc type: a literal carries a value it cannot print");
}

/** A function type: a type literal that is one call signature and nothing else. */
function isFunctionType(type: Node): boolean {
  if (type.type !== "reflection" || !isRecord(type.declaration)) return false;
  const decl = type.declaration;
  return (
    nodes(decl.signatures).length === 1 &&
    nodes(decl.children).length === 0 &&
    nodes(decl.indexSignatures).length === 0
  );
}

/** Types that need parentheses wherever a postfix or a prefix binds to them. */
const LOOSE: ReadonlySet<string> = new Set([
  "union",
  "intersection",
  "conditional",
  "typeOperator",
  "inferred",
]);

/** Print a type where `T[]`, `T[K]` or `keyof T` would otherwise rebind it. */
function tight(type: unknown): string {
  const printed = printType(type);
  if (!isRecord(type)) return printed;
  return LOOSE.has(text(type.type)) || isFunctionType(type)
    ? `(${printed})`
    : printed;
}

/** Print a member of a union or an intersection. */
function operand(type: unknown, inside: "union" | "intersection"): string {
  const printed = printType(type);
  if (!isRecord(type)) return printed;
  const loose =
    isFunctionType(type) ||
    type.type === "conditional" ||
    (inside === "intersection" && type.type === "union");
  return loose ? `(${printed})` : printed;
}

function typeArguments(type: Node): string {
  const args = nodes(type.typeArguments);
  return args.length === 0 ? "" : `<${args.map(printType).join(", ")}>`;
}

function mapped(type: Node): string {
  const readonly =
    type.readonlyModifier === "+"
      ? "readonly "
      : type.readonlyModifier === "-"
        ? "-readonly "
        : "";
  const optional =
    type.optionalModifier === "+"
      ? "?"
      : type.optionalModifier === "-"
        ? "-?"
        : "";
  const as = isRecord(type.nameType) ? ` as ${printType(type.nameType)}` : "";
  const key = `[${text(type.parameter)} in ${printType(type.parameterType)}${as}]`;
  return `{ ${readonly}${key}${optional}: ${printType(type.templateType)} }`;
}

function templateLiteral(type: Node): string {
  const tail = Array.isArray(type.tail) ? type.tail : [];
  const parts = tail.map((pair: unknown) => {
    const [hole, after] = Array.isArray(pair) ? pair : [];
    return `\${${printType(hole)}}${text(after)}`;
  });
  return `\`${text(type.head)}${parts.join("")}\``;
}

/** Print one typedoc type node as TypeScript. */
export function printType(type: unknown): string {
  if (!isRecord(type)) {
    throw new Error("typedoc type: expected a type node, found none");
  }
  switch (type.type) {
    case "intrinsic":
    case "unknown":
      return text(type.name);
    case "reference":
      return `${text(type.name)}${typeArguments(type)}`;
    case "literal":
      return literal(type.value);
    case "array":
      return `${tight(type.elementType)}[]`;
    case "union":
      return nodes(type.types)
        .map((t) => operand(t, "union"))
        .join(" | ");
    case "intersection":
      return nodes(type.types)
        .map((t) => operand(t, "intersection"))
        .join(" & ");
    case "tuple":
      return `[${nodes(type.elements).map(printType).join(", ")}]`;
    case "namedTupleMember":
      return `${text(type.name)}${type.isOptional === true ? "?" : ""}: ${printType(type.element)}`;
    case "optional":
      return `${tight(type.elementType)}?`;
    case "rest":
      return `...${tight(type.elementType)}`;
    case "typeOperator":
      return `${text(type.operator)} ${tight(type.target)}`;
    case "query":
      return `typeof ${printType(type.queryType)}`;
    case "predicate": {
      const subject = `${type.asserts === true ? "asserts " : ""}${text(type.name)}`;
      return isRecord(type.targetType)
        ? `${subject} is ${printType(type.targetType)}`
        : subject;
    }
    case "indexedAccess":
      return `${tight(type.objectType)}[${printType(type.indexType)}]`;
    case "conditional":
      return `${tight(type.checkType)} extends ${tight(type.extendsType)} ? ${printType(type.trueType)} : ${printType(type.falseType)}`;
    case "inferred":
      return isRecord(type.constraint)
        ? `infer ${text(type.name)} extends ${printType(type.constraint)}`
        : `infer ${text(type.name)}`;
    case "mapped":
      return mapped(type);
    case "templateLiteral":
      return templateLiteral(type);
    case "reflection":
      return typeLiteral(type.declaration);
    default:
      throw new Error(
        `typedoc type: no printer for a '${text(type.type)}' node`,
      );
  }
}

/** `lead` is what precedes the list on its line, counted against the width. */
function typeParameters(owner: Node, lead = ""): string {
  const params = nodes(owner.typeParameters);
  if (params.length === 0) return "";
  const printed = params.map((p) => {
    const constraint = isRecord(p.type) ? ` extends ${printType(p.type)}` : "";
    const fallback = isRecord(p.default) ? ` = ${printType(p.default)}` : "";
    return `${flag(p, "isConst") ? "const " : ""}${text(p.name)}${constraint}${fallback}`;
  });
  const oneLine = `<${printed.join(", ")}>`;
  if (fitsOneLine(`${lead}${oneLine}`)) return oneLine;
  return `<${printed.map((p) => `\n  ${nest(p)},`).join("")}\n>`;
}

function parameter(param: Node): string {
  const optional = flag(param, "isOptional") || "defaultValue" in param;
  return `${flag(param, "isRest") ? "..." : ""}${text(param.name)}${optional ? "?" : ""}: ${printType(param.type)}`;
}

/**
 * Print a call signature from its type parameters on. `returns` is the token
 * between the parameter list and the return type: `": "` on a declaration and a
 * member, `" => "` on a function type. `lead` is what the caller prints before
 * it on the same line, counted against the width and not returned.
 */
function signature(sig: Node, returns: ": " | " => ", lead = ""): string {
  const params = nodes(sig.parameters).map(parameter);
  const head = typeParameters(sig, lead);
  const tail = isRecord(sig.type) ? `${returns}${printType(sig.type)}` : "";
  const oneLine = `${head}(${params.join(", ")})${tail}`;
  if (fitsOneLine(`${lead}${oneLine}`) || params.length === 0) return oneLine;
  const broken = params.map((p) => `\n  ${nest(p)},`).join("");
  return `${head}(${broken}\n)${tail}`;
}

/** The lines of a type literal, an interface body or a class body. */
function members(decl: Node): string[] {
  const lines: string[] = [];
  for (const sig of nodes(decl.signatures)) {
    const isNew = sig.kind === KIND_CONSTRUCTOR_SIGNATURE;
    lines.push(`${isNew ? "new " : ""}${signature(sig, ": ")}`);
  }
  for (const sig of nodes(decl.indexSignatures)) {
    const [key] = nodes(sig.parameters);
    const readonly = flag(sig, "isReadonly") ? "readonly " : "";
    lines.push(
      `${readonly}[${key ? parameter(key) : "key: string"}]: ${printType(sig.type)}`,
    );
  }
  for (const child of nodes(decl.children)) {
    // An inherited member is the parent's to print; the `extends` clause names it.
    if ("inheritedFrom" in child) continue;
    const name = memberName(text(child.name));
    const optional = flag(child, "isOptional") ? "?" : "";
    const lead = `${flag(child, "isStatic") ? "static " : ""}${flag(child, "isProtected") ? "protected " : ""}`;
    if (child.kind === KIND_CONSTRUCTOR) {
      for (const sig of nodes(child.signatures)) {
        // The class header already states the return type and the type
        // parameters typedoc repeats on a constructor; the keyword says the rest.
        const bare = { ...sig, type: undefined, typeParameters: undefined };
        lines.push(`constructor${signature(bare, ": ")}`);
      }
    } else if (child.kind === KIND_METHOD) {
      for (const sig of nodes(child.signatures)) {
        lines.push(`${lead}${name}${optional}${signature(sig, ": ")}`);
      }
    } else if (child.kind === KIND_ACCESSOR) {
      if (isRecord(child.getSignature)) {
        lines.push(
          `${lead}get ${name}(): ${printType(child.getSignature.type)}`,
        );
      }
      if (isRecord(child.setSignature)) {
        lines.push(`${lead}set ${name}${signature(child.setSignature, ": ")}`);
      }
    } else if (child.kind === KIND_PROPERTY || child.kind === KIND_VARIABLE) {
      const readonly = flag(child, "isReadonly") ? "readonly " : "";
      lines.push(
        `${lead}${readonly}${name}${optional}: ${printType(child.type)}`,
      );
    } else {
      throw new Error(
        `typedoc type: no printer for member '${text(child.name)}' (kind ${String(child.kind)})`,
      );
    }
  }
  return lines;
}

/** A declaration body: one member per line. */
function block(lines: readonly string[]): string {
  if (lines.length === 0) return "{}";
  return `{${lines.map((l) => `\n  ${nest(l)};`).join("")}\n}`;
}

/** Past this many columns an inline type literal breaks one member per line. */
const INLINE_WIDTH = 48;

function typeLiteral(decl: unknown): string {
  if (!isRecord(decl)) {
    throw new Error("typedoc type: a reflection type has no declaration");
  }
  const [only] = nodes(decl.signatures);
  if (only && isFunctionType({ type: "reflection", declaration: decl })) {
    return signature(only, " => ");
  }
  const lines = members(decl);
  const inline = `{ ${lines.join("; ")} }`;
  return lines.length > 0 &&
    !inline.includes("\n") &&
    inline.length <= INLINE_WIDTH
    ? inline
    : block(lines);
}

function heritage(decl: Node, key: string, keyword: string): string {
  const types = nodes(decl[key]);
  return types.length === 0
    ? ""
    : ` ${keyword} ${types.map(printType).join(", ")}`;
}

/** A type alias's right-hand side, a long union broken one member per line. */
function aliasBody(type: unknown): string {
  const oneLine = printType(type);
  if (fitsOneLine(oneLine) || !isRecord(type) || type.type !== "union")
    return ` ${oneLine}`;
  return nodes(type.types)
    .map((t) => `\n  | ${nest(operand(t, "union"))}`)
    .join("");
}

/**
 * Print an exported declaration under the name the module exports it as: a
 * function's signatures (one line per overload), a variable's type, a type
 * alias's right-hand side, an interface's or a class's own members.
 *
 * Returns `null` for a kind that has no declaration to print — a re-export
 * whose target lies outside the project is the one case. A function with no
 * call signature is an error: that row would tell the reader a function exists
 * and nothing about how to call it.
 */
export function printDeclaration(name: string, decl: Node): string | null {
  switch (decl.kind) {
    case KIND_FUNCTION: {
      const signatures = nodes(decl.signatures);
      if (signatures.length === 0) {
        throw new Error(
          `typedoc model: function '${name}' has no call signature`,
        );
      }
      return signatures
        .map((sig) => {
          const lead = `function ${name}`;
          return `${lead}${signature(sig, ": ", lead)}`;
        })
        .join("\n");
    }
    case KIND_VARIABLE:
      // Always `const`: an importer cannot reassign a binding it imports, and
      // typedoc drops its const flag from a value that shares its name with a type.
      return `const ${name}: ${printType(decl.type)}`;
    case KIND_TYPE_ALIAS: {
      const body = isRecord(decl.type)
        ? aliasBody(decl.type)
        : ` ${block(members(decl))}`;
      return `type ${name}${typeParameters(decl)} =${body}`;
    }
    case KIND_INTERFACE:
      return `interface ${name}${typeParameters(decl)}${heritage(decl, "extendedTypes", "extends")} ${block(members(decl))}`;
    case KIND_CLASS:
      return `${flag(decl, "isAbstract") ? "abstract " : ""}class ${name}${typeParameters(decl)}${heritage(decl, "extendedTypes", "extends")}${heritage(decl, "implementedTypes", "implements")} ${block(members(decl))}`;
    default:
      return null;
  }
}
