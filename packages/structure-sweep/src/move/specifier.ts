import {
  Node,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from "ts-morph";

const SPECIFIER_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const MODULE_CALL = /^vi\.(do)?(un)?mock$|^vi\.import(Actual|Mock)$/;

export function splitSpecifierExtension(specifier: string): {
  readonly base: string;
  readonly extension: string;
} {
  const extension = SPECIFIER_EXTENSION.exec(specifier)?.[0] ?? "";
  return {
    base: specifier.slice(0, specifier.length - extension.length),
    extension,
  };
}

/**
 * Every string literal in `sourceFile` that names a module: import and export declarations, dynamic
 * `import()` calls, type-position `import("…")` and the `vi.*` mock calls. Document order, so two
 * reads of one file line up position by position while only the literals' text changes.
 */
export function moduleLiterals(sourceFile: SourceFile): StringLiteral[] {
  const out: StringLiteral[] = [];
  const push = (node: Node | undefined) => {
    if (node !== undefined && Node.isStringLiteral(node)) out.push(node);
  };
  for (const node of sourceFile.getDescendants()) {
    if (Node.isImportDeclaration(node) || Node.isExportDeclaration(node)) {
      push(node.getModuleSpecifier());
    } else if (Node.isCallExpression(node)) {
      const callee = node.getExpression();
      if (
        callee.getKind() === SyntaxKind.ImportKeyword ||
        MODULE_CALL.test(callee.getText())
      )
        push(node.getArguments()[0]);
    } else if (Node.isImportTypeNode(node)) {
      const arg = node.getArgument();
      if (Node.isLiteralTypeNode(arg)) push(arg.getLiteral());
    }
  }
  return out;
}
