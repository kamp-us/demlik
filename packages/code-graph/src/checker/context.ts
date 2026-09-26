import fs from "node:fs";
import path from "node:path";
import * as ts from "../engine/tsgo.js";
import type { DiscoveredFunction } from "../extract/functions.js";
import { type SourceUnit, toRelative } from "../extract/project.js";
import type { FunctionKind } from "../schema.js";

const TS_KIND: Record<FunctionKind, ts.SyntaxKind> = {
  function: ts.SyntaxKind.FunctionDeclaration,
  method: ts.SyntaxKind.MethodDeclaration,
  constructor: ts.SyntaxKind.Constructor,
  getter: ts.SyntaxKind.GetAccessor,
  setter: ts.SyntaxKind.SetAccessor,
  arrow: ts.SyntaxKind.ArrowFunction,
  "function-expression": ts.SyntaxKind.FunctionExpression,
};

const FUNCTION_KINDS: ReadonlySet<ts.SyntaxKind> = new Set(Object.values(TS_KIND));

export type TypedFile = { readonly unit: SourceUnit; readonly source: ts.SourceFile };

export type TypeContextInput = {
  readonly rootAbsolute: string;
  readonly tsConfigPath: string;
  readonly sourceFiles: readonly SourceUnit[];
  readonly functions: readonly DiscoveredFunction[];
};

function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function joinKey(start: number, kind: ts.SyntaxKind): string {
  return `${start}:${kind}`;
}

// The type tier: tsgo's program over the tsconfig the edge pass reads plus every loaded file, and
// the join from the functions oxc discovered to the nodes of tsgo's tree. Every rule that reads a
// symbol runs on tsgo's nodes, keyed by that join.
export class TypeContext {
  readonly nodeToId = new Map<ts.Node, string>();
  readonly files: readonly TypedFile[];
  readonly unjoined: readonly string[];
  private readonly symbols = new Map<ts.Node, ts.TsSymbol | null>();
  private readonly aliases = new Map<ts.TsSymbol, ts.TsSymbol | undefined>();
  private readonly byFileName = new Map<string, SourceUnit>();
  private readonly rootReal: string;

  private constructor(
    private readonly program: ts.TypeProgram,
    readonly rootAbsolute: string,
    input: TypeContextInput,
  ) {
    this.rootReal = realPath(rootAbsolute);
    const files: TypedFile[] = [];
    for (const unit of input.sourceFiles) {
      const source = program.sourceFile(unit.absolutePath);
      if (source === undefined) continue;
      files.push({ unit, source });
      this.byFileName.set(source.fileName, unit);
    }
    this.files = files;
    this.unjoined = this.join(input.functions);
  }

  static open(input: TypeContextInput): TypeContext {
    const program = ts.openTypeProgram({
      tsConfigPath: input.tsConfigPath,
      rootFiles: input.sourceFiles.map((unit) => unit.absolutePath),
      includeConfigFiles: true,
    });
    try {
      return new TypeContext(program, input.rootAbsolute, input);
    } catch (error) {
      program.close();
      throw error;
    }
  }

  close(): void {
    this.program.close();
  }

  private join(functions: readonly DiscoveredFunction[]): string[] {
    const wanted = new Map<string, Map<string, string>>();
    for (const fn of functions) {
      const byKey = wanted.get(fn.file) ?? new Map<string, string>();
      byKey.set(joinKey(fn.unit.syntax.tsStart(fn.node), TS_KIND[fn.kind]), fn.id);
      wanted.set(fn.file, byKey);
    }
    const joined = new Set<string>();
    for (const { unit, source } of this.files) {
      const byKey = wanted.get(unit.file);
      if (byKey === undefined) continue;
      const visit = (node: ts.Node): void => {
        if (FUNCTION_KINDS.has(node.kind)) {
          const id = byKey.get(joinKey(node.getStart(source), node.kind));
          if (id !== undefined) {
            this.nodeToId.set(node, id);
            joined.add(id);
          }
        }
        node.forEachChild(visit);
      };
      source.forEachChild(visit);
    }
    return functions.filter((fn) => !joined.has(fn.id)).map((fn) => fn.id);
  }

  unitOf(source: ts.SourceFile): SourceUnit | undefined {
    return this.byFileName.get(source.fileName);
  }

  // ts-morph's `Node.getSymbol()`: the checker's symbol at the node, else its name's.
  symbolOf(node: ts.Node): ts.TsSymbol | undefined {
    const cached = this.symbols.get(node);
    if (cached !== undefined) return cached ?? undefined;
    let symbol = this.program.symbolAt(node);
    if (symbol === undefined) {
      const name = (node as { name?: ts.Node }).name;
      if (name !== undefined && typeof name === "object") symbol = this.program.symbolAt(name);
    }
    this.symbols.set(node, symbol ?? null);
    return symbol;
  }

  prefetchSymbols(nodes: readonly ts.Node[]): void {
    const missing = nodes.filter((node) => !this.symbols.has(node));
    if (missing.length === 0) return;
    const found = this.program.symbolsAt(missing);
    missing.forEach((node, index) => {
      const symbol = found[index];
      if (symbol !== undefined) this.symbols.set(node, symbol);
    });
  }

  // ts-morph's `Symbol.getAliasedSymbol()`: the alias target, or undefined for a non-alias.
  aliasedSymbol(symbol: ts.TsSymbol): ts.TsSymbol | undefined {
    if (this.aliases.has(symbol)) return this.aliases.get(symbol);
    const target = this.program.aliasTarget(symbol);
    this.aliases.set(symbol, target);
    return target;
  }

  declarationsOf(symbol: ts.TsSymbol): readonly ts.Node[] {
    return this.program.declarations(symbol);
  }

  exportsOf(moduleSymbol: ts.TsSymbol): ReadonlyMap<string, ts.TsSymbol> {
    return this.program.exportsOf(moduleSymbol);
  }

  libraryKind(source: ts.SourceFile): ts.LibraryKind | null {
    return this.program.libraryKind(source);
  }

  startLine(node: ts.Node): number {
    const source = node.getSourceFile();
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  }

  text(node: ts.Node): string {
    return node.getText(node.getSourceFile());
  }

  // A file's path relative to the root, the way the ts-morph engine wrote it for a loaded file and
  // for one the program pulled in from outside the scope.
  relativePath(source: ts.SourceFile): string {
    const unit = this.byFileName.get(source.fileName);
    if (unit !== undefined) return unit.file;
    const fileName = source.fileName;
    const root = fileName.startsWith(`${this.rootReal}${path.sep}`)
      ? this.rootReal
      : this.rootAbsolute;
    return toRelative(root, fileName);
  }
}
