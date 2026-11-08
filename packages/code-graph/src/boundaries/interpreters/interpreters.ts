import { globToRegExp } from "../../kinds/glob.js";
import type { ImportEdge } from "../../schema.js";
import { inPackageGlobs } from "../libraries/libraries.js";
import type { InterpreterRules } from "./schema.js";

// What one technology's interpreter covers, read once per scope: the package globs and the
// scope-relative paths its `modules` list holds. Every question the judgments ask about a module is
// answered here.
export type Technology = {
  readonly name: string;
  readonly packages: readonly RegExp[];
  readonly paths: readonly string[];
};

// A `modules` entry that starts with `src/` is a scope-relative path, and any other is a package.
export function isPathEntry(module: string): boolean {
  return module.startsWith("src/");
}

// The technologies a scope declares, none for a scope the key does not name. The package globs of
// `modules` were checked where the rules file was read.
export function technologiesOf(
  rules: Pick<InterpreterRules, "interpreters">,
  scope: string,
): readonly Technology[] {
  return Object.entries(rules.interpreters[scope] ?? {}).map(([name, { modules }]) => ({
    name,
    packages: modules.filter((module) => !isPathEntry(module)).map(globToRegExp),
    paths: modules.filter(isPathEntry),
  }));
}

// A scope-relative file with its extension dropped: `src/util/graphql.ts` is `src/util/graphql`.
function withoutExtension(file: string): string {
  return file.replace(/(?:\.d)?\.[^./]+$/, "");
}

// Whether a path entry names a scope-relative file: the file with its extension dropped, or a file
// under the entry as a folder.
export function pathNames(entry: string, file: string): boolean {
  return withoutExtension(file) === entry || file.startsWith(`${entry}/`);
}

// Whether an import lands in a module the technology covers: a package entry is matched on the
// specifier as written (the package and its subpaths), and a path entry on the file the import
// resolves to, however it was spelled.
export function covers(
  technology: Technology,
  edge: Pick<ImportEdge, "specifier" | "target">,
): boolean {
  if (inPackageGlobs(technology.packages, edge.specifier)) return true;
  const { target } = edge;
  return target !== null && technology.paths.some((entry) => pathNames(entry, target));
}
