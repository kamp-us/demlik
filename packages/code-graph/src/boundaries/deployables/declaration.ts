import { type BoundaryRules, featureFileOf, scopeZoning } from "../rules.js";

// The first problem in the deployable keys that the rules file alone can show, or null. A kind
// outside the three is refused by the schema. What needs the repo (an owner that is no loaded file,
// or a binding the owning worker does not declare) is judged where the scope is loaded.
export function deployableDeclarationIssue(rules: BoundaryRules): string | null {
  const declared = Object.entries(rules.bindingOwners);
  if (declared.length === 0) return null;
  if (!rules.acrossDeployables.includes("binding-outside-driven-adapter")) {
    return '"bindingOwners" narrows the bindings B17 judges, and "acrossDeployables" does not list "binding-outside-driven-adapter": with that kind off, an owner enforces nothing.';
  }
  for (const [scope, bindings] of declared) {
    if (rules.features[scope] === undefined) {
      return `"bindingOwners" declares scope "${scope}", which declares no "features": owners ride a scope that declares features.`;
    }
    const zoning = scopeZoning(rules, scope);
    for (const [binding, owners] of Object.entries(bindings)) {
      for (const owner of owners) {
        if (featureFileOf(owner, zoning)?.zone.rule.touchesBindings === true) continue;
        return `owner "${owner}" of binding "${binding}" in "${scope}" is not under a hexagonal feature's adapters/driven/: only a driven adapter may use a binding, so an owner anywhere else could never be clean.`;
      }
    }
  }
  return null;
}
