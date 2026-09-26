import type { DataBindingDecl } from "../extract/wrangler-config.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";

const FUNCTION_LIKE = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

function isFunctionLike(node: SyntaxNode): boolean {
  return FUNCTION_LIKE.has(node.type);
}

// Every local a binding pattern introduces: `db`, `db = x`, `...db`, `{ db }`, `[db]`, and a
// TypeScript parameter property's `private db`.
function patternNames(pattern: SyntaxNode | null): string[] {
  if (pattern === null) return [];
  switch (pattern.type) {
    case "Identifier":
      return [String(field(pattern, "name"))];
    case "AssignmentPattern":
      return patternNames(nodeField(pattern, "left"));
    case "RestElement":
      return patternNames(nodeField(pattern, "argument"));
    case "TSParameterProperty":
      return patternNames(nodeField(pattern, "parameter"));
    case "Property":
      return patternNames(nodeField(pattern, "value"));
    case "ObjectPattern":
      return (field(pattern, "properties") as SyntaxNode[]).flatMap(patternNames);
    case "ArrayPattern":
      return (field(pattern, "elements") as (SyntaxNode | null)[]).flatMap(patternNames);
    default:
      return [];
  }
}

// A function-like node or a class static block: each owns every `var` below it.
function isVarScope(node: SyntaxNode): boolean {
  return isFunctionLike(node) || node.type === "StaticBlock";
}

function declaratorNames(declaration: SyntaxNode): string[] {
  return (field(declaration, "declarations") as SyntaxNode[]).flatMap((d) =>
    patternNames(nodeField(d, "id")),
  );
}

// Every `var` a scope owns: the ones below `root`, short of a nested var scope.
function varNames(syntax: SyntaxFile, root: SyntaxNode): string[] {
  const names: string[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === "VariableDeclaration" && field(node, "kind") === "var") {
      names.push(...declaratorNames(node));
    }
    for (const child of syntax.children(node)) if (!isVarScope(child)) visit(child);
  };
  visit(root);
  return names;
}

// The lexical names a statement list declares, looking through `export`: `let`/`const`/`using`,
// and the class and function declarations it holds, which module code (always strict) scopes to
// the block.
function lexicalNames(statements: readonly SyntaxNode[]): string[] {
  return statements.flatMap((statement) => {
    const node = statement.type.startsWith("Export")
      ? (nodeField(statement, "declaration") ?? statement)
      : statement;
    if (node.type === "VariableDeclaration") {
      return field(node, "kind") === "var" ? [] : declaratorNames(node);
    }
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      return patternNames(nodeField(node, "id"));
    }
    return [];
  });
}

function statementsOf(node: SyntaxNode): SyntaxNode[] {
  return field(node, "body") as SyntaxNode[];
}

// A `for` head's `let`/`const`, scoped to the loop.
function headNames(head: SyntaxNode | null): string[] {
  return head === null ? [] : lexicalNames([head]);
}

// The module or a class static block: its top-level lexicals and every `var` below it.
function varScopeNames(syntax: SyntaxFile, node: SyntaxNode): string[] {
  return [...lexicalNames(statementsOf(node)), ...varNames(syntax, node)];
}

// A function's own names: its parameters, a named expression's name, and its body's `var`s and
// top-level lexical declarations. The body block is the function's scope, not a second one.
function functionNames(syntax: SyntaxFile, fn: SyntaxNode): string[] {
  const names = (field(fn, "params") as SyntaxNode[]).flatMap(patternNames);
  if (fn.type === "FunctionExpression") names.push(...patternNames(nodeField(fn, "id")));
  const body = nodeField(fn, "body");
  if (body?.type !== "BlockStatement") return names;
  return [...names, ...varScopeNames(syntax, body)];
}

// A block that is a function's body opens nothing: the function already owns its names.
function blockNames(syntax: SyntaxFile, block: SyntaxNode): string[] | null {
  const parent = syntax.parentOf(block);
  const isBody =
    parent !== undefined && isFunctionLike(parent) && nodeField(parent, "body") === block;
  return isBody ? null : lexicalNames(statementsOf(block));
}

function switchNames(node: SyntaxNode): string[] {
  const cases = field(node, "cases") as SyntaxNode[];
  return lexicalNames(cases.flatMap((c) => field(c, "consequent") as SyntaxNode[]));
}

type Declarer = (syntax: SyntaxFile, node: SyntaxNode) => string[] | null;

// The names each scope-opening node type declares. The split is ECMAScript's, as eslint-scope
// models it: the module, a function and a class static block own their parameters and every `var`
// below them; a block, a `for` head, a `switch` and a `catch` own only the
// `let`/`const`/class/function declarations directly inside them. A type absent here opens no
// scope.
const DECLARERS: ReadonlyMap<string, Declarer> = new Map<string, Declarer>([
  ["Program", varScopeNames],
  ["StaticBlock", varScopeNames],
  ["ArrowFunctionExpression", functionNames],
  ["FunctionExpression", functionNames],
  ["FunctionDeclaration", functionNames],
  ["BlockStatement", blockNames],
  ["ForStatement", (_, node) => headNames(nodeField(node, "init"))],
  ["ForInStatement", (_, node) => headNames(nodeField(node, "left"))],
  ["ForOfStatement", (_, node) => headNames(nodeField(node, "left"))],
  ["SwitchStatement", (_, node) => switchNames(node)],
  ["CatchClause", (_, node) => patternNames(nodeField(node, "param"))],
]);

// One lexical alias scope per scope-opening node. A name the scope declares starts out shadowing
// any outer alias of that name, and becomes an alias only where its own declaration reads a
// binding; a name it does not declare resolves through the enclosing scopes.
export class AliasScope {
  private readonly own = new Map<string, DataBindingDecl | null>();

  private constructor(private readonly parent: AliasScope | null) {}

  static root(): AliasScope {
    return new AliasScope(null);
  }

  // The scope in force inside `node`: a child declaring its names when `node` opens a scope,
  // else this one.
  enter(syntax: SyntaxFile, node: SyntaxNode): AliasScope {
    const names = DECLARERS.get(node.type)?.(syntax, node) ?? null;
    if (names === null) return this;
    const scope = new AliasScope(this);
    for (const name of names) scope.own.set(name, null);
    return scope;
  }

  // Binds in the scope that declares the name, so a `var` inside a block lands on its function.
  bind(name: string, decl: DataBindingDecl): void {
    this.declaring(name).own.set(name, decl);
  }

  resolve(name: string): DataBindingDecl | null {
    return this.declaring(name).own.get(name) ?? null;
  }

  private declaring(name: string): AliasScope {
    for (let scope: AliasScope | null = this; scope !== null; scope = scope.parent) {
      if (scope.own.has(name)) return scope;
    }
    return this;
  }
}
