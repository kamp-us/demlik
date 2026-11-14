import path from "node:path";
import * as ts from "../../engine/tsgo.js";
import { findRepoRoot, toRelative } from "../../extract/project.js";
import { byText } from "../../order.js";
import { moduleSymbolOf } from "../../resolve.js";
import { apiSubpaths, pathInside } from "../map.js";
import {
  byFileThenPosition,
  declaredName,
  nodeKey,
  type PublishedDeclaration,
  publishedDeclarations,
  unresolvedSpecifiers,
} from "../read.js";
import { packageRoot, packageTsConfig } from "../view.js";
import { type ApiDocGap, orderApiDocGaps } from "./gaps.js";
import type { ApiDocFact } from "./judge.js";

export type ApiDocFacts = {
  readonly facts: readonly ApiDocFact[];
  readonly gaps: readonly ApiDocGap[];
};

type OwnFiles = {
  readonly named: (file: string) => string;
  readonly own: (file: string) => boolean;
};

function readScope(root: string): OwnFiles {
  return {
    named: (file) => toRelative(root, file),
    own: (file: string) => {
      const inside = pathInside(root, file);
      return inside !== undefined && !inside.split(path.sep).includes("node_modules");
    },
  };
}

// The statement a doc block attaches to. Unlike statementOf in ../text.ts, which keeps a
// declaration's own text, it climbs out of a destructuring pattern and a dotted namespace.
function documentedStatement(declaration: ts.Node): ts.Node {
  let statement = declaration;
  while (
    statement.parent !== undefined &&
    !ts.isSourceFile(statement.parent) &&
    !ts.isModuleBlock(statement.parent)
  ) {
    statement = statement.parent;
  }
  return statement;
}

function isClassOrEnum(node: ts.Node): boolean {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isEnumDeclaration(node);
}

function exportHolder(declaration: ts.Node): ts.Node | undefined {
  for (let holder = declaration.parent; holder !== undefined; holder = holder.parent) {
    if (ts.isModuleDeclaration(holder) || isClassOrEnum(holder) || ts.isSourceFile(holder)) {
      return holder;
    }
  }
  return undefined;
}

function exportedFromNamespace(declaration: ts.Node): boolean {
  const holder = exportHolder(declaration);
  return holder !== undefined && ts.isModuleDeclaration(holder);
}

function exportedOnlyByClassOrEnum(sites: readonly ts.Node[]): boolean {
  return (
    sites.length > 0 &&
    sites.every((site) => {
      const holder = exportHolder(site);
      return holder !== undefined && isClassOrEnum(holder);
    })
  );
}

function isWholeModule(declaration: ts.Node): boolean {
  return (
    ts.isSourceFile(declaration) ||
    (ts.isModuleDeclaration(declaration) && ts.isStringLiteral(declaration.name))
  );
}

function isDeclarationHere(declaration: ts.Node): boolean {
  return !(
    (ts.isModuleDeclaration(declaration) && ts.isModuleDeclaration(declaration.parent)) ||
    ts.isBinaryExpression(declaration) ||
    ts.isPropertyAccessExpression(declaration) ||
    declaration.kind === ts.SyntaxKind.JSTypeAliasDeclaration
  );
}

function insideDeclaredModule(declaration: ts.Node): boolean {
  for (
    let at: ts.Node | undefined = declaration;
    at !== undefined && !ts.isSourceFile(at);
    at = at.parent
  ) {
    if (isWholeModule(at)) return true;
  }
  return false;
}

function pickedDeclaration(declarations: readonly ts.Node[]): ts.Node | undefined {
  const candidates = [...declarations].sort(byFileThenPosition).filter(isDeclarationHere);
  return candidates.find((declaration) => !insideDeclaredModule(declaration)) ?? candidates[0];
}

function docText(statement: ts.Node): string | null {
  const source = statement.getSourceFile();
  let text: string | null = null;
  for (const comment of ts.getLeadingCommentRanges(source.text, statement.pos) ?? []) {
    if (comment.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const written = source.text.slice(comment.pos, comment.end);
    if (written.startsWith("/**") && written !== "/**/") text = written;
  }
  return text;
}

class DeclarationRead {
  readonly facts = new Map<string, ApiDocFact>();
  readonly gaps: ApiDocGap[] = [];
  readonly modules = new Map<string, ts.Node>();

  constructor(
    private readonly program: ts.TypeProgram,
    private readonly scope: OwnFiles,
  ) {}

  from(file: string, subpath: string): void {
    if (!this.scope.own(file)) return;
    const symbol = moduleSymbolOf(this.program, file);
    if (symbol === undefined) return;
    this.module(
      symbol,
      this.program.declarations(symbol).filter(isWholeModule),
      subpath,
      "",
      new Set(),
    );
  }

  private exportsOf(
    exports: readonly PublishedDeclaration[],
    subpath: string,
    prefix: string,
    active: ReadonlySet<string>,
  ): void {
    for (const { name, symbol, declarations, exportedAt } of exports) {
      if (name === "" || exportedOnlyByClassOrEnum(exportedAt)) continue;
      const reached = { subpath, name: `${prefix}${name}` };
      if (declarations.length === 0) {
        if (exportedAt.some((site) => this.scope.own(site.getSourceFile().fileName))) {
          this.gaps.push({ kind: "no-declaration", ...reached });
        }
        continue;
      }
      if (
        declarations.some((declaration) => !this.scope.own(declaration.getSourceFile().fileName))
      ) {
        continue;
      }
      const modules = declarations.filter(isWholeModule);
      if (modules.length > 0) {
        this.module(symbol, modules, subpath, `${reached.name}.`, active);
        continue;
      }
      const declaration = pickedDeclaration(declarations);
      if (declaration !== undefined) this.record(declaration, reached);
      this.namespace(symbol, declarations, subpath, `${reached.name}.`, active);
    }
  }

  private namespace(
    symbol: ts.TsSymbol,
    declarations: readonly ts.Node[],
    subpath: string,
    prefix: string,
    active: ReadonlySet<string>,
  ): void {
    const namespace = declarations.find(ts.isModuleDeclaration);
    if (namespace === undefined || active.has(nodeKey(namespace))) return;
    const members = publishedDeclarations(this.program, symbol).filter(({ exportedAt }) =>
      exportedAt.some(exportedFromNamespace),
    );
    this.exportsOf(members, subpath, prefix, new Set(active).add(nodeKey(namespace)));
  }

  private module(
    symbol: ts.TsSymbol,
    declarations: readonly ts.Node[],
    subpath: string,
    prefix: string,
    active: ReadonlySet<string>,
  ): void {
    const roots = declarations.filter((declaration) =>
      this.scope.own(declaration.getSourceFile().fileName),
    );
    const keys = roots.map(nodeKey);
    if (keys.some((key) => active.has(key))) return;
    for (const root of roots) this.modules.set(nodeKey(root), root);
    this.exportsOf(
      publishedDeclarations(this.program, symbol),
      subpath,
      prefix,
      new Set([...active, ...keys]),
    );
  }

  private record(declaration: ts.Node, reached: ApiDocFact["reachedBy"][number]): void {
    const source = declaration.getSourceFile();
    const key = nodeKey(declaration);
    const previous = this.facts.get(key);
    if (previous !== undefined) {
      const duplicate = previous.reachedBy.some(
        (reach) => reach.subpath === reached.subpath && reach.name === reached.name,
      );
      if (!duplicate) {
        this.facts.set(key, { ...previous, reachedBy: [...previous.reachedBy, reached] });
      }
      return;
    }
    const statement = documentedStatement(declaration);
    const names = [declaredName(declaration)];
    for (let holder = declaration.parent; holder !== undefined; holder = holder.parent) {
      if (ts.isModuleDeclaration(holder) && ts.isIdentifier(holder.name)) {
        names.unshift(holder.name.text);
      }
    }
    this.facts.set(key, {
      block: "export",
      file: this.scope.named(source.fileName),
      line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
      name: names.join("."),
      reachedBy: [reached],
      text: docText(statement),
    });
  }
}

function programGaps(
  program: ts.TypeProgram,
  scope: OwnFiles,
  modules: ReadonlyMap<string, ts.Node>,
): ApiDocGap[] {
  const gaps: ApiDocGap[] = unresolvedSpecifiers(
    program,
    {
      named: scope.named,
      reads: (file, reexport) => reexport && scope.own(file),
    },
    [...modules.values()].sort(byFileThenPosition),
  ).map((gap) => ({
    kind: "unresolved-specifier",
    ...gap,
  }));
  for (const [file, count] of program.syntaxErrors()) {
    if (scope.own(file)) gaps.push({ kind: "syntax-error", file: scope.named(file), count });
  }
  return gaps;
}

export function readApiDocFacts(
  root: string,
  map: unknown,
  options: { readonly repoRoot?: string } = {},
): ApiDocFacts {
  const rootAbsolute = packageRoot(root);
  const subpaths = apiSubpaths(rootAbsolute, map);
  const tsConfigPath = packageTsConfig(
    rootAbsolute,
    options.repoRoot ?? findRepoRoot(rootAbsolute),
  );
  const entryFiles = [...new Set(subpaths.map(({ entryAbsolute }) => entryAbsolute))].sort(byText);
  const program = ts.openTypeProgram({
    tsConfigPath,
    rootFiles: entryFiles,
    includeConfigFiles: true,
  });
  try {
    const scope = readScope(rootAbsolute);
    const read = new DeclarationRead(program, scope);
    for (const { entryAbsolute, subpath } of subpaths) read.from(entryAbsolute, subpath);
    const gaps = orderApiDocGaps([...programGaps(program, scope, read.modules), ...read.gaps]);
    return { facts: [...read.facts.values()], gaps };
  } finally {
    program.close();
  }
}
