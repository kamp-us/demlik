import { GlobSyntaxError, globToRegExp } from "../../kinds/glob.js";
import { IMPURE_ROWS } from "../impure.js";
import type { LibraryRules } from "./schema.js";

function typeIssues(rules: LibraryRules): string[] {
  const declared = Object.keys(rules.libraryTypes);
  const known = new Set(declared);
  const named = `"libraryTypes" (declared: ${declared.join(", ") || "none"})`;
  const imports = Object.entries(rules.libraryTypes).flatMap(([name, type]) =>
    type.imports
      .filter((imported) => !known.has(imported))
      .map((imported) => `library type "${name}" imports "${imported}", which ${named} lacks.`),
  );
  const libraries = Object.entries(rules.libraries)
    .filter(([, type]) => !known.has(type))
    .map(([dir, type]) => `library "${dir}" is type "${type}", which ${named} lacks.`);
  return [...imports, ...libraries];
}

// A world library that compiles as a glob, and matches no row of `IMPURE_GLOBALS`. A row is judged
// by its own name (`fetch`, `console`, `node:fs`), so a package of that name would share its ledger
// entry and hide behind it: the two are named apart, or not declared.
function worldLibraryIssues(rules: LibraryRules): string[] {
  return rules.worldLibraries.flatMap((entry) => {
    try {
      const glob = globToRegExp(entry);
      const row = IMPURE_ROWS.find((name) => glob.test(name));
      if (row === undefined) return [];
      return [
        `world library "${entry}" matches the impure global "${row}", which a pure library already may not use: a package and a global of one name would share one ledger entry, so declare a pattern that matches no global.`,
      ];
    } catch (error) {
      if (!(error instanceof GlobSyntaxError)) throw error;
      return [`world library "${entry}" is not a valid glob: ${error.message}.`];
    }
  });
}

// An allowance names two declared libraries, and licenses names only where the importer's type does
// not already list the imported library's type: then it would enforce nothing. What needs the scope's
// files (a name the importer never imports) is judged where the scope is loaded.
function allowanceIssues(rules: LibraryRules): string[] {
  return Object.entries(rules.allowImportNames).flatMap(([importer, imported]) => {
    const importerType = rules.libraries[importer];
    if (importerType === undefined) {
      return [
        `allowImportNames importer "${importer}" is no declared library: add it to "libraries".`,
      ];
    }
    return Object.keys(imported).flatMap((dir) => {
      const importedType = rules.libraries[dir];
      if (importedType === undefined) {
        return [
          `allowImportNames "${importer}" licenses names of "${dir}", which is no declared library: add it to "libraries".`,
        ];
      }
      if (rules.libraryTypes[importerType]?.imports.includes(importedType) !== true) return [];
      return [
        `allowImportNames "${importer}" licenses names of "${dir}", but its type "${importerType}" already lists "${importedType}" in "imports": the allowance would enforce nothing.`,
      ];
    });
  });
}

// The first problem in the library keys that the schema alone cannot see, or null: a type no
// `libraryTypes` entry declares, a world library that is no glob or names an impure global, and an
// allowance that names no declared library or enforces nothing. What needs the repo (a library that
// is no package, a root that is no directory) is judged where the repo is read.
export function libraryDeclarationIssue(rules: LibraryRules): string | null {
  return [...typeIssues(rules), ...worldLibraryIssues(rules), ...allowanceIssues(rules)][0] ?? null;
}
