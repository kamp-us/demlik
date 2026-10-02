import { GlobSyntaxError, globToRegExp } from "../../kinds/glob.js";
import { type BoundaryRules, featureFileOf, scopeZoning } from "../rules.js";

const B16 = "application-import-outside-allowlist";

// A key that narrows B16 does nothing while B16 is off, and a key that enforces nothing silently is
// the failure a mistyped door was: the rules file says so, once.
function narrowsOffKind(rules: BoundaryRules): string[] {
  if (rules.applicationShape.includes(B16)) return [];
  const narrowing = {
    applicationMayImport: rules.applicationMayImport,
    pureDependencies: rules.pureDependencies,
  };
  return Object.entries(narrowing)
    .filter(([, list]) => list.length > 0)
    .map(
      ([key]) =>
        `"${key}" says what B16 allows, and "applicationShape" does not list "${B16}": with that kind off, the key enforces nothing.`,
    );
}

function typeIssues(
  rules: BoundaryRules,
  key: string,
  types: readonly string[],
  where: string,
): string[] {
  const declared = Object.keys(rules.libraryTypes);
  const named = `"libraryTypes" (declared: ${declared.join(", ") || "none"})`;
  return types
    .filter((type) => !declared.includes(type))
    .map((type) => `"${key}" names type "${type}"${where}, which ${named} lacks.`);
}

function globIssues(key: string, globs: readonly string[]): string[] {
  return globs.flatMap((glob) => {
    try {
      globToRegExp(glob);
      return [];
    } catch (error) {
      if (!(error instanceof GlobSyntaxError)) throw error;
      return [`"${key}" entry "${glob}" is not a valid glob: ${error.message}.`];
    }
  });
}

// A scope these keys ride declares features, laid out in the hexagonal zones they judge.
function scopeIssues(rules: BoundaryRules, key: string, scopes: readonly string[]): string[] {
  return scopes.flatMap((scope) => {
    if (rules.features[scope] === undefined) {
      return [
        `"${key}" declares scope "${scope}", which declares no "features": it rides a scope that declares features.`,
      ];
    }
    return rules.layout[scope] === "hexagonal"
      ? []
      : [
          `"${key}" declares scope "${scope}", whose "layout" is not "hexagonal": it judges a hexagonal feature's zones.`,
        ];
  });
}

// What one scope's allowance says that the rules file alone can show: it lists a file and a type,
// each file is a driven adapter and each type is declared. Whether a file is one the scope loads
// is judged where the scope is loaded.
function allowanceIssues(rules: BoundaryRules): string[] {
  return Object.entries(rules.readAllowance).flatMap(([scope, { driven, decidedBy }]) => {
    const zoning = scopeZoning(rules, scope);
    const empty = (key: string, list: readonly string[]) =>
      list.length > 0
        ? []
        : [
            `"readAllowance" in "${scope}" lists no "${key}" entry: an allowance that grants nothing.`,
          ];
    const notDriven = driven
      .filter((file) => featureFileOf(file, zoning)?.zone.name !== "driven")
      .map(
        (file) =>
          `file "${file}" of "readAllowance" in "${scope}" is not under a hexagonal feature's adapters/driven/: only a driven file can be read through, so a listing anywhere else could never grant.`,
      );
    return [
      ...empty("driven", driven),
      ...empty("decidedBy", decidedBy),
      ...notDriven,
      ...typeIssues(rules, "readAllowance", decidedBy, ` in "${scope}"`),
    ];
  });
}

// The first problem in the six keys that the rules file alone can show, or null. A kind outside the
// two is refused by the schema. What needs the repo (a listed file the scope does not load, a
// wrangler config that cannot be parsed) is judged where the scope is loaded and the run is read.
export function shapeDeclarationIssue(rules: BoundaryRules): string | null {
  return (
    [
      ...narrowsOffKind(rules),
      ...typeIssues(rules, "applicationMayImport", rules.applicationMayImport, ""),
      ...globIssues("pureDependencies", rules.pureDependencies),
      ...globIssues("testFiles", rules.testFiles),
      ...scopeIssues(rules, "strictDriving", rules.strictDriving),
      ...scopeIssues(rules, "readAllowance", Object.keys(rules.readAllowance)),
      ...allowanceIssues(rules),
    ][0] ?? null
  );
}
