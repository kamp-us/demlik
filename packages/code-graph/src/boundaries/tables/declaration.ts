import { type BoundaryRules, scopeZoning } from "../rules.js";

// The problem in `tableOwnership` that the rules file alone can show, or null. A kind outside the
// two is refused by the schema. The kinds judge a scope laid out per feature and no other, so a
// rules file with none enforces nothing, the failure a mistyped key is: it says so, once.
export function tableDeclarationIssue(rules: BoundaryRules): string | null {
  if (rules.tableOwnership.length === 0) return null;
  const perFeature = Object.keys(rules.features).some(
    (scope) => scopeZoning(rules, scope).layout === "per-feature",
  );
  if (perFeature) return null;
  return (
    `"tableOwnership" lists ${rules.tableOwnership.join(", ")}, and no scope in "features" uses the ` +
    "per-feature layout (src/<feature>/adapters/driven/tables.ts): with no feature to own a table, " +
    "the key enforces nothing."
  );
}
