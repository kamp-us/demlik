import path from "node:path";
import * as ts from "../engine/tsgo.js";
import { moduleSymbolOf } from "../resolve.js";
import { declarationText, statementOf } from "./text.js";

// A published name as a consumer's types see it (SPEC §13.3): its own declaration text, plus the
// text of every non-published declaration in the emitted tree it reaches, keyed
// `<emitted file>#<declared name>`.
export type ApiEntryText = {
  readonly text: string;
  readonly references: Readonly<Record<string, string>>;
};

export type SubpathNames = Readonly<Record<string, ApiEntryText>>;

// A name's own declarations, followed through aliases, renames and `export *`.
type Published = { readonly name: string; readonly declarations: readonly ts.Node[] };

// A file's first statement starts where the file does, so the kind keeps the two apart.
const nodeKey = (node: ts.Node): string =>
  `${node.getSourceFile().fileName}:${node.pos}:${node.end}:${node.kind}`;

function byFileThenPosition(a: ts.Node, b: ts.Node): number {
  const fileA = a.getSourceFile().fileName;
  const fileB = b.getSourceFile().fileName;
  if (fileA !== fileB) return fileA < fileB ? -1 : 1;
  return a.pos - b.pos;
}

// Several declarations of one name (overloads, merges) in emitted file order, then position; a
// variable statement declaring several names is one statement.
function statementsOf(declarations: readonly ts.Node[]): readonly ts.Node[] {
  const statements = new Map<string, ts.Node>();
  for (const declaration of declarations) {
    const statement = statementOf(declaration);
    statements.set(nodeKey(statement), statement);
  }
  return [...statements.values()].sort(byFileThenPosition);
}

const joinedText = (statements: readonly ts.Node[]): string =>
  statements.map(declarationText).join("\n");

function publishedNames(program: ts.TypeProgram, entryFile: string): readonly Published[] {
  const moduleSymbol = moduleSymbolOf(program, entryFile);
  if (moduleSymbol === undefined) return [];
  return [...program.exportsOf(moduleSymbol)].map(([name, symbol]) => ({
    name,
    declarations: statementsOf(program.declarations(program.aliasTarget(symbol) ?? symbol)),
  }));
}

const entityName = (name: ts.Node | undefined): ts.Node | undefined =>
  name !== undefined && ts.isQualifiedName(name) ? name.right : name;

const expressionName = (expression: ts.Node): ts.Node =>
  ts.isPropertyAccessExpression(expression) ? expression.name : expression;

// The node a reference names, for every kind of reference an emitted declaration spells out:
// `Foo<T>`, `A.B`, `extends Base`, `typeof value`, `import("./x").Foo`, and a computed member key
// such as `[Brand]`, whose `unique symbol` is part of the type that carries it.
function referenceName(node: ts.Node): ts.Node | undefined {
  if (ts.isTypeReferenceNode(node)) return entityName(node.typeName);
  if (ts.isTypeQueryNode(node)) return entityName(node.exprName);
  if (ts.isImportTypeNode(node)) return entityName(node.qualifier);
  if (ts.isExpressionWithTypeArguments(node) || ts.isComputedPropertyName(node)) {
    return expressionName(node.expression);
  }
  return undefined;
}

function referenceNames(statement: ts.Node): readonly ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): undefined => {
    const name = referenceName(node);
    if (name !== undefined) found.push(name);
    node.forEachChild(visit);
    return undefined;
  };
  visit(statement);
  return found;
}

const TOP_LEVEL_DECLARATION: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isTypeAliasDeclaration,
  ts.isInterfaceDeclaration,
  ts.isClassDeclaration,
  ts.isEnumDeclaration,
  ts.isFunctionDeclaration,
  ts.isModuleDeclaration,
  ts.isVariableDeclaration,
];

function declaredName(declaration: ts.Node): string {
  const name = (declaration as { name?: ts.Node }).name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : "default";
}

// Walks from a published name's declarations to every declaration it reaches that sits in the
// emitted tree and that its subpath does not publish, under a statement or a namespace body.
class ReferenceWalk {
  readonly #references = new Map<string, Map<string, ts.Node>>();
  readonly #walked = new Set<string>();

  constructor(
    private readonly program: ts.TypeProgram,
    private readonly out: string,
    private readonly published: ReadonlySet<string>,
  ) {}

  from(statements: readonly ts.Node[]): Record<string, string> {
    const queue = [...statements];
    for (const statement of statements) this.#walked.add(nodeKey(statement));
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      queue.push(...this.#step(next));
    }
    return this.#texts();
  }

  #step(statement: ts.Node): readonly ts.Node[] {
    const names = referenceNames(statement);
    const reached: ts.Node[] = [];
    for (const symbol of this.program.symbolsAt(names)) {
      if (symbol === undefined) continue;
      const target = this.program.aliasTarget(symbol) ?? symbol;
      for (const declaration of this.program.declarations(target)) {
        const statement = this.#unpublished(declaration);
        if (statement !== null) reached.push(...this.#record(declaration, statement));
      }
    }
    return reached;
  }

  #unpublished(declaration: ts.Node): ts.Node | null {
    if (!TOP_LEVEL_DECLARATION.some((is) => is(declaration))) return null;
    if (!declaration.getSourceFile().fileName.startsWith(`${this.out}${path.sep}`)) return null;
    const statement = statementOf(declaration);
    const holder = statement.parent;
    if (!ts.isSourceFile(holder) && !ts.isModuleBlock(holder)) return null;
    for (let at: ts.Node | undefined = statement; at !== undefined; at = at.parent) {
      if (this.published.has(nodeKey(at))) return null;
      if (ts.isSourceFile(at)) break;
    }
    return statement;
  }

  #record(declaration: ts.Node, statement: ts.Node): readonly ts.Node[] {
    const file = path.relative(this.out, declaration.getSourceFile().fileName).split(path.sep);
    const key = `${file.join("/")}#${declaredName(declaration)}`;
    const statements = this.#references.get(key) ?? new Map<string, ts.Node>();
    statements.set(nodeKey(statement), statement);
    this.#references.set(key, statements);
    if (this.#walked.has(nodeKey(statement))) return [];
    this.#walked.add(nodeKey(statement));
    return [statement];
  }

  #texts(): Record<string, string> {
    const texts: Record<string, string> = {};
    for (const [key, statements] of this.#references) {
      texts[key] = joinedText([...statements.values()].sort(byFileThenPosition));
    }
    return texts;
  }
}

// Every name the module at `entryFile` publishes, with its text and references.
export function readSubpathNames(
  program: ts.TypeProgram,
  out: string,
  entryFile: string,
): SubpathNames {
  const names = publishedNames(program, entryFile);
  const published = new Set(names.flatMap((name) => name.declarations.map(nodeKey)));
  const read: Record<string, ApiEntryText> = {};
  for (const { name, declarations } of names) {
    const references = new ReferenceWalk(program, out, published).from(declarations);
    read[name] = { text: joinedText(declarations), references };
  }
  return read;
}
