import type { Libraries } from "./libraries.js";

// What the report says about the libraries a run measured, beside its violations: the libraries
// by type (a declared type nobody uses is listed with none), the packages under a library root no
// library names, and the imports of such a package that no rule judged.
export type LibraryCensus = {
  readonly types: Readonly<Record<string, readonly string[]>>;
  readonly undeclared: readonly string[];
  readonly unjudgedImports: number;
};

export type MeasuredLibraries = {
  readonly scopes: readonly string[];
  readonly undeclared: readonly string[];
  readonly unjudged: number;
};

const byName = (a: string, b: string): number => a.localeCompare(b);

// The census of a run, or null when the rules file declares no library key: then the report has
// nothing to say about libraries, and says nothing.
export function libraryCensus(
  libraries: Libraries,
  measured: MeasuredLibraries,
): LibraryCensus | null {
  if (!libraries.declared) return null;
  const scopes = new Set(measured.scopes);
  const types = Object.keys(libraries.rules.libraryTypes)
    .sort(byName)
    .map((name) => {
      const dirs = libraries.dirs.filter((dir) => libraries.typeOfDir.get(dir) === name);
      return [name, dirs.filter((dir) => scopes.has(dir)).sort(byName)] as const;
    });
  return {
    types: Object.fromEntries(types),
    undeclared: [...measured.undeclared].sort(byName),
    unjudgedImports: measured.unjudged,
  };
}

export function censusLines(census: LibraryCensus): string[] {
  const entries = Object.entries(census.types);
  const declared = entries.reduce((sum, [, dirs]) => sum + dirs.length, 0);
  const perType = entries.map(([name, dirs]) => `${name} ${dirs.length}`).join(", ");
  const unjudged = census.unjudgedImports;
  return [
    `libraries: ${declared} declared (${perType || "no type"}), ${census.undeclared.length} ` +
      `undeclared, ${unjudged} import${unjudged === 1 ? "" : "s"} left unjudged`,
    ...entries
      .filter(([, dirs]) => dirs.length > 0)
      .map(([name, dirs]) => `  ${name}: ${dirs.join(", ")}`),
    ...(census.undeclared.length > 0 ? [`  undeclared: ${census.undeclared.join(", ")}`] : []),
  ];
}
