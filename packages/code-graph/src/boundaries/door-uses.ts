import type { ImportEdge } from "../schema.js";
import { patternNames } from "../syntax/bindings.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";
import {
  bareNewDoorOf,
  type DoorName,
  GLOBAL_OBJECT,
  moduleDoorsOpened,
  pathDoorOf,
} from "./doors.js";

// One use of a world door by one file: the door it falls under, and the static path it was read
// through (`process.stdin.isTTY` falls under `process.stdin`, `process.hrtime.bigint` under
// `process.hrtime`). Module doors are not here: they are import edges, and the edges are already read.
export type DoorUse = { readonly door: DoorName; readonly path: readonly string[] };

// This is not `env-keys/extract.ts`. `scanEnvKeys` answers "which keys does the code read from any
// env-shaped receiver", so it matches by text and accepts a bare `env` or any `.env`. The gate
// answers "does this file touch the real `process.env`", which a receiver by text cannot say: it
// reads a name the file never bound, through steps it can see. The two share the syntax tree and
// `field`/`nodeField`, and nothing else can be shared without one of them changing its answer.
//
// What counts: a runtime reference to a catalog door, however it is spelled (`process.env.X`,
// `process["env"].X`, `process.env[k]`, a spread, an argument, `const { X } = process.env`,
// `const { env } = process`), and any static member of `process` is its own door. What does not: a
// type position, a name the file binds itself (that check is per file, so it fails open on a file
// that rebinds a name in one function and uses the real one in another), and data flow
// (`const p = process`, a bare `process`, `process[k]`: no member is named, so no door is).
export function detectDoorUses(syntax: SyntaxFile): DoorUse[] {
  const scan: Scan = { syntax, bound: boundNames(syntax), found: new Map() };
  for (const child of codeChildren(syntax, syntax.program)) visit(scan, child);
  return [...scan.found.values()].sort(
    (a, b) => a.door.localeCompare(b.door) || a.path.join(".").localeCompare(b.path.join(".")),
  );
}

// Every catalog door a file uses by name or opens as a module, declared or not, once each: what a
// place that judges every door reads (B7 in `application/`, B13 in a pure library).
export function doorsOf(file: {
  readonly doorUses: readonly DoorUse[];
  readonly importEdges: readonly Pick<ImportEdge, "specifier" | "target" | "typeOnly">[];
  readonly runtimeSpecifiers: ReadonlySet<string>;
}): DoorName[] {
  const opened = moduleDoorsOpened(file.importEdges, file.runtimeSpecifiers);
  return [...new Set([...file.doorUses.map((use) => use.door), ...opened])];
}

type Scan = {
  readonly syntax: SyntaxFile;
  readonly bound: ReadonlySet<string>;
  readonly found: Map<string, DoorUse>;
};

// TypeScript's type-only nodes hold no runtime reference. These host code, so they are read: an
// assertion's operand, a namespace's body, `export = expr`.
const TS_CODE = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSExportAssignment",
]);

function codeChildren(syntax: SyntaxFile, node: SyntaxNode): SyntaxNode[] {
  return syntax.children(node).filter((c) => !c.type.startsWith("TS") || TS_CODE.has(c.type));
}

// Every name the file binds anywhere. A `declare` binds nothing: it types the real global.
function boundNames(syntax: SyntaxFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: SyntaxNode): void => {
    for (const name of bindingsOf(node)) names.add(name);
    for (const child of codeChildren(syntax, node)) visit(child);
  };
  visit(syntax.program);
  return names;
}

function declaredNames(node: SyntaxNode): string[] {
  if (field(node, "declare") === true) return [];
  return (field(node, "declarations") as SyntaxNode[]).flatMap((d) =>
    patternNames(nodeField(d, "id")),
  );
}

function functionNames(node: SyntaxNode): string[] {
  return [
    ...patternNames(nodeField(node, "id")),
    ...(field(node, "params") as SyntaxNode[]).flatMap(patternNames),
  ];
}

const namedBy = (key: string) => (node: SyntaxNode) => patternNames(nodeField(node, key));

// The nodes that bind names, and the names each one binds.
const BINDERS: ReadonlyMap<string, (node: SyntaxNode) => string[]> = new Map([
  ["VariableDeclaration", declaredNames],
  ["FunctionDeclaration", functionNames],
  ["FunctionExpression", functionNames],
  ["ArrowFunctionExpression", functionNames],
  ["ClassDeclaration", namedBy("id")],
  ["ClassExpression", namedBy("id")],
  ["CatchClause", namedBy("param")],
  ["ImportSpecifier", namedBy("local")],
  ["ImportDefaultSpecifier", namedBy("local")],
  ["ImportNamespaceSpecifier", namedBy("local")],
]);

function bindingsOf(node: SyntaxNode): string[] {
  return BINDERS.get(node.type)?.(node) ?? [];
}

// A static access path off an identifier: `process` `.env` `["X"]`. It stops growing at the first
// step it cannot read (`process.env[k]` is `process.env`), and keeps the expressions it could not
// read so they are still visited.
type Chain = {
  readonly root: string;
  readonly segments: readonly string[];
  readonly open: boolean;
  readonly dynamic: readonly SyntaxNode[];
};

const TRANSPARENT = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

function chainOf(node: SyntaxNode): Chain | null {
  if (node.type === "Identifier") {
    return { root: String(field(node, "name")), segments: [], open: true, dynamic: [] };
  }
  if (TRANSPARENT.has(node.type)) {
    const inner = nodeField(node, "expression");
    return inner === null ? null : chainOf(inner);
  }
  if (node.type !== "MemberExpression") return null;
  const object = nodeField(node, "object");
  const base = object === null ? null : chainOf(object);
  return base === null ? null : step(base, node);
}

function stringLiteral(node: SyntaxNode): string | null {
  const value = node.type === "Literal" ? field(node, "value") : null;
  return typeof value === "string" ? value : null;
}

// The static name a member access reads, or null when it is computed from something else.
function staticStep(member: SyntaxNode, property: SyntaxNode): string | null {
  if (field(member, "computed") === true) return stringLiteral(property);
  return property.type === "Identifier" ? String(field(property, "name")) : null;
}

function step(base: Chain, member: SyntaxNode): Chain {
  const property = nodeField(member, "property");
  if (property === null) return { ...base, open: false };
  const name = base.open ? staticStep(member, property) : null;
  const computed = field(member, "computed") === true && stringLiteral(property) === null;
  return {
    ...base,
    segments: name === null ? base.segments : [...base.segments, name],
    open: name !== null,
    dynamic: computed ? [...base.dynamic, property] : base.dynamic,
  };
}

// Identifier slots that name something rather than read it: `a.b`'s `b`, `{ b: 1 }`'s `b`, a
// label, an export's name. A computed key is an expression and is read.
const COMPUTABLE_NAME = new Map([
  ["MemberExpression", "property"],
  ["Property", "key"],
  ["MethodDefinition", "key"],
  ["PropertyDefinition", "key"],
  ["AccessorProperty", "key"],
]);

const PLAIN_NAMES = new Map([
  ["LabeledStatement", ["label"]],
  ["BreakStatement", ["label"]],
  ["ContinueStatement", ["label"]],
  ["MetaProperty", ["meta", "property"]],
  ["ExportSpecifier", ["local", "exported"]],
  ["ExportAllDeclaration", ["exported"]],
  ["ImportAttribute", ["key"]],
  ["TSModuleDeclaration", ["id"]],
]);

function isName(node: SyntaxNode, parent: SyntaxNode | undefined): boolean {
  if (parent === undefined) return false;
  const computable = COMPUTABLE_NAME.get(parent.type);
  if (computable !== undefined && nodeField(parent, computable) === node) {
    return field(parent, "computed") !== true;
  }
  return PLAIN_NAMES.get(parent.type)?.some((key) => nodeField(parent, key) === node) ?? false;
}

function visit(scan: Scan, node: SyntaxNode): void {
  if (node.type === "ImportDeclaration" || isName(node, scan.syntax.parentOf(node))) return;
  const chain = chainOf(node);
  if (chain !== null) {
    recordChain(scan, chain);
    for (const expression of chain.dynamic) visit(scan, expression);
    return;
  }
  recordBareNew(scan, node);
  recordDestructured(scan, node);
  for (const child of codeChildren(scan.syntax, node)) visit(scan, child);
}

function record(scan: Scan, door: DoorName, path: readonly string[]): void {
  scan.found.set(`${door}\0${path.join("\0")}`, { door, path });
}

function recordPath(scan: Scan, path: readonly string[]): void {
  const [root = ""] = path;
  const door = scan.bound.has(root) ? null : pathDoorOf(path);
  if (door !== null) record(scan, door, path);
}

function recordChain(scan: Scan, { root, segments }: Chain): void {
  let path = [root, ...segments];
  recordPath(scan, path);
  while (path[0] === GLOBAL_OBJECT && path.length > 1 && !scan.bound.has(GLOBAL_OBJECT)) {
    path = path.slice(1);
    recordPath(scan, path);
  }
}

function recordBareNew(scan: Scan, node: SyntaxNode): void {
  if (node.type !== "NewExpression") return;
  const callee = nodeField(node, "callee");
  const args = field(node, "arguments") as readonly SyntaxNode[];
  if (callee?.type !== "Identifier" || args.length > 0) return;
  const ctor = String(field(callee, "name"));
  const door = scan.bound.has(ctor) ? null : bareNewDoorOf(ctor);
  if (door !== null) record(scan, door, [door]);
}

// The nodes that pull names out of a value: `const { a } = v`, `({ a } = v)`, `({ a } = v) => …`.
const DESTRUCTURING = new Map([
  ["VariableDeclarator", { pattern: "id", source: "init" }],
  ["AssignmentExpression", { pattern: "left", source: "right" }],
  ["AssignmentPattern", { pattern: "left", source: "right" }],
]);

// `const { env } = process` reads `process.env`; `const { stdin: { isTTY } } = process` reads
// `process.stdin.isTTY`. The source is recorded as a chain of its own, so only what the pattern
// adds is read here. A computed key or a rest element adds nothing a path can name.
function recordDestructured(scan: Scan, node: SyntaxNode): void {
  const slots = DESTRUCTURING.get(node.type);
  const pattern = slots === undefined ? null : nodeField(node, slots.pattern);
  const source = slots === undefined ? null : nodeField(node, slots.source);
  const base = source === null ? null : chainOf(source);
  if (pattern === null || base === null) return;
  destructure(base, pattern, (chain) => recordChain(scan, chain));
}

function destructure(chain: Chain, pattern: SyntaxNode, emit: (chain: Chain) => void): void {
  if (pattern.type !== "ObjectPattern" || !chain.open) return;
  for (const property of field(pattern, "properties") as SyntaxNode[]) {
    const name = property.type === "Property" ? keyName(property) : null;
    if (name === null) continue;
    const child: Chain = { ...chain, segments: [...chain.segments, name] };
    emit(child);
    const target = nodeField(property, "value");
    const nested = target?.type === "AssignmentPattern" ? nodeField(target, "left") : target;
    if (nested !== null) destructure(child, nested, emit);
  }
}

function keyName(property: SyntaxNode): string | null {
  const key = nodeField(property, "key");
  if (key === null) return null;
  if (field(property, "computed") !== true && key.type === "Identifier") {
    return String(field(key, "name"));
  }
  return stringLiteral(key);
}
