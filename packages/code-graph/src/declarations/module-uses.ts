import type { TypeContext } from "../checker/context.js";
import * as ts from "../engine/tsgo.js";

// The loaded file a module specifier resolves to, by the type checker's own module resolution.
function targetFile(ctx: TypeContext, specifier: ts.Node | undefined): string | null {
  if (specifier === undefined || !ts.isStringLiteral(specifier)) return null;
  const symbol = ctx.symbolOf(specifier);
  const source = symbol === undefined ? undefined : ctx.declarationsOf(symbol)[0]?.getSourceFile();
  return source === undefined ? null : ctx.relativePath(source);
}

// The specifier of a statement that takes the whole module rather than named exports of it.
function wholeModuleSpecifier(statement: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(statement)) {
    const bindings = statement.importClause?.namedBindings;
    return bindings !== undefined && ts.isNamespaceImport(bindings)
      ? statement.moduleSpecifier
      : undefined;
  }
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    return clause === undefined || ts.isNamespaceExport(clause)
      ? statement.moduleSpecifier
      : undefined;
  }
  return undefined;
}

function dynamicImportSpecifiers(ctx: TypeContext, source: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): undefined => {
    if (ts.isCallExpression(node) && ctx.text(node.expression) === "import") {
      const first = node.arguments[0];
      if (first !== undefined) out.push(first);
    }
    node.forEachChild(visit);
    return undefined;
  };
  source.forEachChild(visit);
  return out;
}

// Loaded file → every other loaded file that takes all of its exports at once: `import * as ns`,
// `export * from`, `export * as ns from` and a dynamic `import("…")`. Which export such a file
// goes on to read is not tracked, so each of the target's exports counts as used by it.
export function wholeModuleUsers(ctx: TypeContext): Map<string, Set<string>> {
  const users = new Map<string, Set<string>>();
  for (const { unit, source } of ctx.files) {
    const specifiers = [
      ...source.statements.map(wholeModuleSpecifier),
      ...dynamicImportSpecifiers(ctx, source),
    ];
    for (const specifier of specifiers) {
      const target = targetFile(ctx, specifier);
      if (target === null || target === unit.file) continue;
      const bucket = users.get(target) ?? new Set<string>();
      bucket.add(unit.file);
      users.set(target, bucket);
    }
  }
  return users;
}
