import path from "node:path";
import * as ts from "../../engine/tsgo.js";
import { findRepoRoot } from "../../extract/project.js";
import { moduleSymbolOf } from "../../resolve.js";
import { apiSubpaths } from "../map.js";
import {
  byFileThenPosition,
  declaredName,
  nodeKey,
  publishedDeclarations,
  type ReadScope,
  unresolvedSpecifiers,
} from "../read.js";
import { packageRoot, packageTsConfig } from "../view.js";
import { type ApiDocGap, orderApiDocGaps } from "./gaps.js";
import type { ApiDocFact } from "./judge.js";

export type ApiDocFacts = {
  readonly facts: readonly ApiDocFact[];
  readonly gaps: readonly ApiDocGap[];
};

function insidePath(relative: string): boolean {
  return relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
}

function readScope(root: string): ReadScope {
  const named = (file: string): string => path.relative(root, file).split(path.sep).join("/");
  return {
    named,
    own: (file) => {
      const relative = named(file);
      return insidePath(relative) && !relative.split("/").includes("node_modules");
    },
  };
}

function declarationStatement(declaration: ts.Node): ts.Node {
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

  constructor(
    private readonly program: ts.TypeProgram,
    private readonly scope: ReadScope,
  ) {}

  from(file: string, subpath: string, prefix = "", active = new Set<string>()): void {
    if (active.has(file)) return;
    const symbol = moduleSymbolOf(this.program, file);
    if (symbol === undefined) return;
    const next = new Set(active).add(file);
    for (const { name, declarations } of publishedDeclarations(this.program, symbol)) {
      if (name === "") continue;
      const reached = { subpath, name: `${prefix}${name}` };
      const declaration = [...declarations].sort(byFileThenPosition)[0];
      if (declaration === undefined) {
        this.gaps.push({ kind: "no-declaration", ...reached });
      } else if (ts.isSourceFile(declaration)) {
        this.from(declaration.fileName, subpath, `${reached.name}.`, next);
      } else {
        this.record(declaration, reached);
      }
    }
  }

  private record(declaration: ts.Node, reached: ApiDocFact["reachedBy"][number]): void {
    const source = declaration.getSourceFile();
    if (!this.scope.own(source.fileName)) return;
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
    const statement = declarationStatement(declaration);
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
  entryFiles: readonly string[],
): ApiDocGap[] {
  const gaps: ApiDocGap[] = unresolvedSpecifiers(program, scope, entryFiles).map((gap) => ({
    kind: "unresolved-specifier",
    ...gap,
  }));
  for (const [file, count] of program.syntaxErrors()) {
    const relative = scope.named(file);
    if (insidePath(relative)) gaps.push({ kind: "syntax-error", file: relative, count });
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
    const gaps = orderApiDocGaps([...programGaps(program, scope, entryFiles), ...read.gaps]);
    return { facts: [...read.facts.values()], gaps };
  } finally {
    program.close();
  }
}
