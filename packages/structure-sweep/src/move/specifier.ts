import { dirname, extname } from "node:path";
import {
  Node,
  type NoSubstitutionTemplateLiteral,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
  type TemplateExpression,
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
 * Every file a specifier can name, most likely first: the sources {@link sourceCandidates} lists,
 * then a declaration file, a JavaScript file, and the path as written when it carries an extension,
 * which is how `./data.json` names `data.json`.
 */
export function moduleFileCandidates(specifier: string): string[] {
  const { base } = splitSpecifierExtension(specifier);
  return [
    ...sourceCandidates(specifier),
    `${base}.d.ts`,
    `${base}.js`,
    `${base}.jsx`,
    ...(extname(specifier) === "" ? [] : [specifier]),
  ];
}

const SPELLED_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

/**
 * Every way a specifier can spell `file`, the path as written first: {@link moduleFileCandidates}
 * read backwards, so a path built at run time is matched by the same rule a written one resolves by.
 */
export function moduleFileSpellings(file: string): string[] {
  const base = file.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
  const forms = [
    file,
    base,
    ...SPELLED_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...(base.endsWith("/index") ? [dirname(base)] : []),
  ];
  return [...new Set(forms)].filter((form) =>
    moduleFileCandidates(form).includes(file),
  );
}

/**
 * Whether a specifier can name a TypeScript or JavaScript module: it has no extension, or a code one.
 * `@scope/kit/styles.css` cannot, whatever its package's `exports` make of it.
 */
export const namesCode = (specifier: string): boolean =>
  extname(specifier) === "" || SPECIFIER_EXTENSION.test(specifier);

/**
 * A relative specifier naming the source `file`, spelled for the importer's module resolution.
 * Without `explicit`, a `.ts`, `.tsx` or `.d.ts` loses its extension; `"js"` (NodeNext) gives it the
 * one the compiler reads back to that file, and `"ts"` (NodeNext with `allowImportingTsExtensions`)
 * keeps every TypeScript extension as written. Otherwise an `.mts` or `.cts` is spelled `.mjs` or
 * `.cjs`, since no resolution finds one without an extension.
 */
export function relativeSpecifierOf(
  file: string,
  explicit: "none" | "js" | "ts",
): string {
  const specifier = file.startsWith(".") ? file : `./${file}`;
  if (explicit === "ts" && /\.[cm]?tsx?$/.test(specifier)) return specifier;
  if (specifier.endsWith(".mts")) return specifier.replace(/\.mts$/, ".mjs");
  if (specifier.endsWith(".cts")) return specifier.replace(/\.cts$/, ".cjs");
  return specifier.replace(/(?:\.d)?\.tsx?$/, explicit === "js" ? ".js" : "");
}

/** A specifier written out in full: a quoted string, or a backtick one with no `${}` in it. */
export type ModuleLiteral = StringLiteral | NoSubstitutionTemplateLiteral;

export const isModuleLiteral = (node: Node): node is ModuleLiteral =>
  Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node);

/**
 * The node in each spot of `sourceFile` that names a module: import and export declarations,
 * `import x = require("…")`, `require("…")` and dynamic `import()` calls, type-position
 * `import("…")`, `declare module "…"` and the `vi.*` mock calls. Document order.
 */
function moduleArguments(sourceFile: SourceFile): Node[] {
  const out: Node[] = [];
  const push = (node: Node | undefined) => {
    if (node !== undefined) out.push(node);
  };
  for (const node of sourceFile.getDescendants()) {
    if (Node.isImportDeclaration(node) || Node.isExportDeclaration(node)) {
      push(node.getModuleSpecifier());
    } else if (Node.isExternalModuleReference(node)) {
      push(node.getExpression());
    } else if (Node.isModuleDeclaration(node)) {
      const name = node.getNameNodes();
      if (!Array.isArray(name)) push(name);
    } else if (Node.isCallExpression(node)) {
      const callee = node.getExpression();
      if (
        callee.getKind() === SyntaxKind.ImportKeyword ||
        callee.getText() === "require" ||
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

/**
 * Every specifier in `sourceFile` written out in full, in document order, so two reads of one file
 * line up position by position while only the literals' text changes.
 */
export const moduleLiterals = (sourceFile: SourceFile): ModuleLiteral[] =>
  moduleArguments(sourceFile).filter(isModuleLiteral);

/** Every specifier in `sourceFile` built at run time by a backtick string with `${}` in it. */
export const moduleTemplates = (sourceFile: SourceFile): TemplateExpression[] =>
  moduleArguments(sourceFile).filter(Node.isTemplateExpression);
