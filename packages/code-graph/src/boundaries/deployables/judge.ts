import type { BoundaryViolation } from "../violation.js";
import { bindingViolations } from "./bindings.js";
import type { DeployableFile, Deployables } from "./deployables.js";
import type { DeployableKind } from "./schema.js";
import { crossWorkspaceImports } from "./workspaces.js";

type FileJudge = (deployables: Deployables, file: DeployableFile) => BoundaryViolation[];

// What judges each kind in one file, one row per kind so a kind added later does not compile until
// it has one. The worker call cycle is read off the deploy configs once for the repo, and no file
// holds it: `null`.
const FILE_JUDGES = {
  "binding-outside-driven-adapter": (_, file) => bindingViolations(file),
  "worker-call-cycle": null,
  "relative-import-crosses-workspace": (deployables, file) =>
    crossWorkspaceImports(deployables.workspaces, file.scope, file.from, file.importEdges),
} as const satisfies Record<DeployableKind, FileJudge | null>;

// B17 and B19 for one file: the kinds the rules file lists, and nothing for one it does not.
export function judgeDeployables(
  deployables: Deployables,
  file: DeployableFile,
): BoundaryViolation[] {
  return [...deployables.kinds].flatMap((kind) => FILE_JUDGES[kind]?.(deployables, file) ?? []);
}
