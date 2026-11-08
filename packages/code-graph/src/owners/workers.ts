import {
  type Deployables,
  isWorkerMain,
  type JudgedBinding,
  workerOf,
} from "../boundaries/deployables/deployables.js";
import { inNestedLibrary, type Libraries } from "../boundaries/libraries/libraries.js";
import { inScope } from "../boundaries/rules.js";
import type { Placed } from "./features.js";
import { locusOf, type SiteLocus } from "./locus.js";

// One reference to a binding: the repo-relative file, the line, and where the file sits.
export type BindingSiteRow = {
  readonly file: string;
  readonly line: number;
  readonly place: SiteLocus;
};

// A binding of a worker that the scope's files reference. `owners` are the repo-relative files the
// rules file narrows it to (`bindingOwners`), none when any driven adapter may use it.
export type BindingRow = {
  readonly binding: string;
  readonly kind: JudgedBinding["kind"];
  readonly owners: readonly string[];
  readonly sites: readonly BindingSiteRow[];
};

// A worker the scope's files reference bindings of, by the service name its config gives it.
export type WorkerRow = { readonly worker: string; readonly bindings: readonly BindingRow[] };

export type WorkerInputs = {
  readonly scope: string;
  readonly deployables: Deployables;
  readonly libraries: Libraries;
  readonly owners: Readonly<Record<string, readonly string[]>>;
};

type Reference = BindingSiteRow & {
  readonly worker: string;
  readonly binding: string;
  readonly kind: JudgedBinding["kind"];
};

const byName = (a: string, b: string): number => a.localeCompare(b);

// Every binding site the scope's files hold, as the gate finds them (`bindingSitesOf`): a file in a
// library nested in the scope belongs to that library's scope. The worker's `main` wires its
// bindings, so a site there is a place of its own, as B17 judges it.
function referencesOf(inputs: WorkerInputs, placed: readonly Placed[]): Reference[] {
  const { scope, deployables, libraries } = inputs;
  return placed.flatMap(({ module, place }) => {
    const file = inScope(scope, module.file);
    const worker = workerOf(deployables, file);
    if (worker === null || inNestedLibrary(libraries, scope, file)) return [];
    const judged = deployables.judged.get(worker);
    const where: SiteLocus = isWorkerMain(deployables, file) ? { kind: "main" } : locusOf(place);
    return module.bindingSites.flatMap(({ binding, line }) => {
      const kind = judged?.get(binding)?.kind;
      return kind === undefined
        ? []
        : [{ worker: worker.service, binding, kind, file, line, place: where }];
    });
  });
}

function bindingRows(
  references: readonly Reference[],
  owners: WorkerInputs["owners"],
  scope: string,
): BindingRow[] {
  const held = new Map<string, { kind: Reference["kind"]; sites: BindingSiteRow[] }>();
  for (const { binding, kind, file, line, place } of references) {
    const row = held.get(binding) ?? { kind, sites: [] };
    row.sites.push({ file, line, place });
    held.set(binding, row);
  }
  return [...held]
    .sort(([a], [b]) => byName(a, b))
    .map(([binding, { kind, sites }]) => ({
      binding,
      kind,
      owners: (owners[binding] ?? []).map((file) => inScope(scope, file)).sort(byName),
      sites: sites.sort((a, b) => byName(a.file, b.file) || a.line - b.line),
    }));
}

// The workers whose bindings the scope's files reference, each binding with its kind, the files the
// rules narrow it to and every site.
export function workersOf(inputs: WorkerInputs, placed: readonly Placed[]): WorkerRow[] {
  const byWorker = new Map<string, Reference[]>();
  for (const reference of referencesOf(inputs, placed)) {
    const held = byWorker.get(reference.worker) ?? [];
    held.push(reference);
    byWorker.set(reference.worker, held);
  }
  return [...byWorker]
    .sort(([a], [b]) => byName(a, b))
    .map(([worker, references]) => ({
      worker,
      bindings: bindingRows(references, inputs.owners, inputs.scope),
    }));
}
