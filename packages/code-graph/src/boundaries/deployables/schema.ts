import { z } from "zod";
import type { BoundaryKind } from "../violation.js";

// The three rules across deployables. A rules file turns each on by naming it in
// `acrossDeployables`; a kind it does not name does not run, so a release that adds a kind never
// fails the merge gate of a repo that did not ask for it.
export const DEPLOYABLE_KINDS = [
  "binding-outside-driven-adapter",
  "worker-call-cycle",
  "relative-import-crosses-workspace",
] as const satisfies readonly BoundaryKind[];

export type DeployableKind = (typeof DEPLOYABLE_KINDS)[number];

// `{ "<scope>": { "<binding>": ["<scope-relative owner file>", …] } }`: which driven adapters may
// use a binding, as `doors` says which files may open a door. Read where the file is read
// (`deployableDeclarationIssue`) and where the scope is loaded (`unknownBindingOwners`).
const BindingOwnersSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
);

// The two keys of the rules file that declare the deployable level, spread into
// `BoundaryRulesSchema`.
//  - `acrossDeployables`: the kinds that run, empty by default.
//  - `bindingOwners`: per scope, a binding narrowed to exact files (needs the first kind listed).
export const DEPLOYABLE_KEYS = {
  acrossDeployables: z.array(z.enum(DEPLOYABLE_KINDS)).default([]),
  bindingOwners: BindingOwnersSchema.default({}),
};

export type DeployableRules = z.infer<z.ZodObject<typeof DEPLOYABLE_KEYS>>;

export function declaresDeployables(rules: Pick<DeployableRules, "acrossDeployables">): boolean {
  return rules.acrossDeployables.length > 0;
}
