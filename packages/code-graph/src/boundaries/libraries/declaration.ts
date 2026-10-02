import { GlobSyntaxError, globToRegExp } from "../../kinds/glob.js";
import { DOOR_ROWS } from "../doors.js";
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

// A world library that compiles as a glob, and matches no catalog door. A door is judged by its own
// name (`fetch`, `console`, `node:fs`), so a package of that name would share its ledger entry and
// hide behind it: the two are named apart, or not declared.
function worldLibraryIssues(rules: LibraryRules): string[] {
  return rules.worldLibraries.flatMap((entry) => {
    try {
      const glob = globToRegExp(entry);
      const door = DOOR_ROWS.find((name) => glob.test(name));
      if (door === undefined) return [];
      return [
        `world library "${entry}" matches the catalog door "${door}", which a pure library already may not use: a package and a door of one name would share one ledger entry, so declare a pattern that matches no door.`,
      ];
    } catch (error) {
      if (!(error instanceof GlobSyntaxError)) throw error;
      return [`world library "${entry}" is not a valid glob: ${error.message}.`];
    }
  });
}

// The first problem in the library keys that the schema alone cannot see, or null: a type no
// `libraryTypes` entry declares, and a world library that is no glob or names a door. What needs
// the repo (a library that is no package, a root that is no directory) is judged where the repo is
// read.
export function libraryDeclarationIssue(rules: LibraryRules): string | null {
  return [...typeIssues(rules), ...worldLibraryIssues(rules)][0] ?? null;
}
