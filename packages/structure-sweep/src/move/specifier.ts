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
 * The source files a relative specifier can name, by what its extension says: `.mjs` and `.mts`
 * only an `.mts`, `.cjs` and `.cts` only a `.cts`, anything else a `.ts`, a `.tsx` or a directory's
 * index. `specifier` is resolved against the importer's directory by the caller.
 */
export function sourceCandidates(specifier: string): string[] {
  const { base, extension } = splitSpecifierExtension(specifier);
  if (extension === ".mjs" || extension === ".mts") return [`${base}.mts`];
  if (extension === ".cjs" || extension === ".cts") return [`${base}.cts`];
  return [".ts", ".tsx", "/index.ts", "/index.tsx"].map((s) => `${base}${s}`);
}

/**
 * A relative specifier naming the source `file`, spelled for the importer's module resolution.
 * Without `explicit`, a `.ts` or `.tsx` loses its extension; with it (NodeNext) it gains the one
 * the compiler reads back to that file. An `.mts` or `.cts` carries its extension in every mode,
 * since no resolution finds one without.
 */
export function relativeSpecifierOf(
  file: string,
  explicit: "none" | "js" | "ts",
): string {
  const specifier = file.startsWith(".") ? file : `./${file}`;
  if (explicit === "ts" && /\.[cm]?tsx?$/.test(specifier)) return specifier;
  if (specifier.endsWith(".mts")) return specifier.replace(/\.mts$/, ".mjs");
  if (specifier.endsWith(".cts")) return specifier.replace(/\.cts$/, ".cjs");
  return specifier.replace(/\.tsx?$/, explicit === "js" ? ".js" : "");
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
