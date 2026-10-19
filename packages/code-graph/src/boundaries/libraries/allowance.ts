import type { SyntaxFile } from "../../syntax/file.js";
import { type ImportedNames, importedNamesOf } from "../../syntax/imports.js";
import { importTargetOf, type Libraries, ownerOf } from "./libraries.js";

// The names a file takes from each specifier it writes: what the allowance is judged against.
export type NamedFile = {
  readonly file: string;
  readonly importedNames: ReadonlyMap<string, ImportedNames>;
};

const NO_NAMES: ReadonlyMap<string, ImportedNames> = new Map();

// The names a file takes, read from its syntax tree only for a scope whose rules file gives it an
// allowance.
export function importedNamesFor(
  libraries: Libraries,
  scope: string,
  syntax: SyntaxFile,
): ReadonlyMap<string, ImportedNames> {
  return libraries.rules.allowImportNames[scope] === undefined ? NO_NAMES : importedNamesOf(syntax);
}

// Whether `importer` is licensed to take everything `file` takes from the library `dir`, under every
// specifier it writes for it. A declaration that takes a name no one can read is never licensed.
export function isLicensed(
  libraries: Libraries,
  importer: string,
  dir: string,
  specifiers: ReadonlySet<string>,
  file: NamedFile,
): boolean {
  const licensed = libraries.rules.allowImportNames[importer]?.[dir];
  if (licensed === undefined) return false;
  return [...specifiers].every((specifier) => {
    const imported = file.importedNames.get(specifier);
    return (
      imported !== undefined &&
      !imported.unreadable &&
      [...imported.names].every((name) => licensed.includes(name))
    );
  });
}

function namesTaken(
  libraries: Libraries,
  scope: string,
  files: readonly NamedFile[],
): Map<string, Set<string>> {
  const taken = new Map<string, Set<string>>();
  for (const file of files) {
    if (ownerOf(libraries, `${scope}/${file.file}`) !== scope) continue;
    for (const [specifier, imported] of file.importedNames) {
      const target = importTargetOf(libraries, specifier);
      if (target.kind !== "library" || target.dir === scope) continue;
      const names = taken.get(target.dir) ?? new Set<string>();
      for (const name of imported.names) names.add(name);
      taken.set(target.dir, names);
    }
  }
  return taken;
}

// The first name the scope's allowance licenses that no file of the scope takes from that library, or
// null: a stale name would license nothing, and a refactor that stops importing one turns red until
// the declaration is edited. `files` is every file the scope loaded, scope-relative.
export function allowanceIssue(
  libraries: Libraries,
  scope: string,
  files: readonly NamedFile[],
): string | null {
  const allowance = libraries.rules.allowImportNames[scope];
  if (allowance === undefined) return null;
  const taken = namesTaken(libraries, scope, files);
  for (const [dir, licensed] of Object.entries(allowance)) {
    const never = licensed.find((name) => taken.get(dir)?.has(name) !== true);
    if (never !== undefined) {
      return `allowImportNames "${scope}" licenses "${never}" of "${dir}", which "${scope}" never imports from it: remove the name.`;
    }
  }
  return null;
}
