import { bindingSites } from "../../data/extract.js";
import type { SyntaxFile } from "../../syntax/file.js";
import type { BoundaryViolation } from "../violation.js";
import {
  type BindingSite,
  type DeployableFile,
  type Deployables,
  workerOf,
} from "./deployables.js";

// Every reference a file makes to the bindings the worker that owns it declares, clean or not.
// Syntax only (`env.X`, `this.env.X`, `c.env.X`, one level of aliasing, a destructure off `env`):
// the finder `--data` runs, so it needs no type checker. A file under no worker has none.
export function bindingSitesOf(
  deployables: Deployables,
  file: string,
  syntax: SyntaxFile,
): BindingSite[] {
  if (deployables.kinds.size === 0) return [];
  const worker = workerOf(deployables, file);
  const judged = worker === null ? undefined : deployables.judged.get(worker);
  if (judged === undefined || judged.size === 0) return [];
  return bindingSites(syntax, judged).map((site) => ({
    binding: site.decl.binding,
    line: site.line,
  }));
}

// A binding is clean only in a driven adapter, and where an owner list names the binding, only in
// a file on it: the list narrows the driven adapters and never exempts a file from them.
function isClean(file: DeployableFile, binding: string): boolean {
  if (!file.driven) return false;
  const owners = file.owners[binding];
  return owners === undefined || owners.includes(file.file);
}

// B17: one entry per file per binding, however many sites use it.
export function bindingViolations(file: DeployableFile): BoundaryViolation[] {
  const used = [...new Set(file.bindingSites.map((site) => site.binding))].sort((a, b) =>
    a.localeCompare(b),
  );
  return used
    .filter((binding) => !isClean(file, binding))
    .map(
      (binding): BoundaryViolation => ({
        kind: "binding-outside-driven-adapter",
        from: file.from,
        to: null,
        specifier: binding,
        typeOnly: false,
      }),
    );
}

// The first owner a scope's `bindingOwners` names that this scope cannot honour once the repo is
// read, or null: a stale or mistyped owner would silently enforce nothing. `files` is every
// scope-relative file the scope loaded.
export function bindingOwnerIssue(
  scope: string,
  owners: Readonly<Record<string, readonly string[]>>,
  files: ReadonlySet<string>,
  deployables: Deployables,
): string | null {
  for (const [binding, listed] of Object.entries(owners)) {
    for (const owner of listed) {
      const named = `owner "${owner}" of binding "${binding}" in "${scope}"`;
      if (!files.has(owner)) {
        return `${named} is no file the scope loads: an owner is an exact scope-relative .ts/.tsx path, such as src/orders/adapters/driven/orders-db.ts.`;
      }
      const worker = workerOf(deployables, scope === "." ? owner : `${scope}/${owner}`);
      if (worker === null) {
        return `${named} sits under no worker config, so no worker declares "${binding}".`;
      }
      if (deployables.judged.get(worker)?.has(binding) !== true) {
        return `${named}: the worker "${worker.service}" that owns it declares no service, D1, Durable Object, KV, R2 or queue binding "${binding}".`;
      }
    }
  }
  return null;
}
