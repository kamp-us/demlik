import path from "node:path";
import * as ts from "../../engine/tsgo.js";
import { findRepoRoot } from "../../extract/project.js";
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

type ReadScope = {
  readonly named: (file: string) => string;
  readonly own: (file: string) => boolean;
};

function readScope(root: string): ReadScope {
  const named = (file: string): string => path.relative(root, file).split(path.sep).join("/");
  return {
    named,
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

function exportedFromNamespace(declaration: ts.Node): boolean {
  for (let holder = declaration.parent; holder !== undefined; holder = holder.parent) {
    if (ts.isModuleDeclaration(holder)) return true;
    if (
      ts.isClassDeclaration(holder) ||
      ts.isClassExpression(holder) ||
      ts.isEnumDeclaration(holder) ||
      ts.isSourceFile(holder)
    ) {
      return false;
    }
  }
  return false;
}

function isWholeModule(declaration: ts.Node): boolean {
  return (
    ts.isSourceFile(declaration) ||
    (ts.isModuleDeclaration(declaration) && ts.isStringLiteral(declaration.name))
  );
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
  readonly modules = new Set<string>();

  constructor(
    private readonly program: ts.TypeProgram,
    private readonly scope: ReadScope,
  ) {}

  from(file: string, subpath: string, prefix = "", active: ReadonlySet<string> = new Set()): void {
    if (active.has(file) || !this.scope.own(file)) return;
    const symbol = moduleSymbolOf(this.program, file);
    if (symbol === undefined) return;
    this.modules.add(file);
    this.exportsOf(
      publishedDeclarations(this.program, symbol),
      subpath,
      prefix,
      new Set(active).add(file),
    );
  }

  private exportsOf(
    exports: readonly PublishedDeclaration[],
    subpath: string,
    prefix: string,
    active: ReadonlySet<string>,
  ): void {
    for (const { name, symbol, declarations, exportedAt } of exports) {
      if (name === "") continue;
      const reached = { subpath, name: `${prefix}${name}` };
      const declaration = [...declarations].sort(byFileThenPosition)[0];
      if (declaration === undefined) {
        if (exportedAt.some((site) => this.scope.own(site.getSourceFile().fileName))) {
          this.gaps.push({ kind: "no-declaration", ...reached });
        }
        continue;
      }
      if (!this.scope.own(declaration.getSourceFile().fileName)) continue;
      if (isWholeModule(declaration)) {
        this.module(symbol, declaration, subpath, `${reached.name}.`, active);
        continue;
      }
      this.record(declaration, reached);
      const namespace = declarations.find(ts.isModuleDeclaration);
      if (namespace === undefined || active.has(nodeKey(namespace))) continue;
      const members = publishedDeclarations(this.program, symbol).filter(({ exportedAt }) =>
        exportedAt.some(exportedFromNamespace),
      );
      this.exportsOf(members, subpath, `${reached.name}.`, new Set(active).add(nodeKey(namespace)));
    }
  }

  private module(
    symbol: ts.TsSymbol,
    declaration: ts.Node,
    subpath: string,
    prefix: string,
    active: ReadonlySet<string>,
  ): void {
    const key = ts.isSourceFile(declaration) ? declaration.fileName : nodeKey(declaration);
    if (active.has(key)) return;
    if (ts.isSourceFile(declaration)) this.modules.add(declaration.fileName);
    this.exportsOf(
      publishedDeclarations(this.program, symbol),
      subpath,
      prefix,
      new Set(active).add(key),
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
    this.facts.set(key, {
      block: "export",
      file: this.scope.named(source.fileName),
      line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
      name: declaredName(declaration),
      reachedBy: [reached],
      text: docText(statement),
    });
  }
}

function programGaps(
  program: ts.TypeProgram,
  scope: ReadScope,
  modules: ReadonlySet<string>,
): ApiDocGap[] {
  const gaps: ApiDocGap[] = unresolvedSpecifiers(
    program,
    {
      named: scope.named,
      reads: (file, reexport) => reexport && scope.own(file),
    },
    [...modules].sort(byText),
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
  const entryFiles = [...new Set(subpaths.map(({ entryAbsolute }) => entryAbsolute))].sort();
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
