import { sccMembers, stronglyConnectedComponents } from "../../extract/scc.js";
import type { BindingCatalog } from "../../extract/wrangler-config.js";
import type { BoundaryViolation } from "../violation.js";

// One service binding between two workers of the repo: `from` declares `binding`, which reaches `to`.
type Edge = { readonly from: string; readonly binding: string; readonly to: string };

// The worker call graph the deploy configs declare: a node per worker (the config's `name`, else
// its directory's), an edge per service binding to a worker the repo has a config for, and a count
// of the service bindings to a worker it has none for, which are no edge. A Durable Object or
// Workflow binding with a `script_name` also points at another worker and is not an edge here.
export type WorkerGraph = {
  readonly workers: readonly string[];
  readonly edges: readonly Edge[];
  readonly unresolved: number;
};

const byName = (a: string, b: string): number => a.localeCompare(b);

export const NO_GRAPH: WorkerGraph = { workers: [], edges: [], unresolved: 0 };

// A worker that binds itself is no cycle, so a self-binding is no edge. Top-level environment only:
// the catalog reads no `env.<name>` block, as `--cross-runtime` does not.
export function workerGraph(catalog: BindingCatalog): WorkerGraph {
  const workers = [...new Set(catalog.manifests.map((m) => m.service))].sort(byName);
  const known = new Set(workers);
  const edges: Edge[] = [];
  let unresolved = 0;
  for (const manifest of catalog.manifests) {
    for (const decl of manifest.bindings) {
      if (decl.kind !== "service") continue;
      if (!known.has(decl.targetService)) unresolved += 1;
      else if (decl.targetService !== manifest.service) {
        edges.push({ from: manifest.service, binding: decl.binding, to: decl.targetService });
      }
    }
  }
  return { workers, edges, unresolved };
}

function written(edge: Edge): string {
  return `${edge.from}.${edge.binding} -> ${edge.to}`;
}

function adjacency(graph: WorkerGraph): Map<string, string[]> {
  const adjacent = new Map<string, string[]>(graph.workers.map((worker) => [worker, []]));
  for (const edge of graph.edges) adjacent.get(edge.from)?.push(edge.to);
  return adjacent;
}

// B18: one entry per strongly connected component of two or more workers. `from` is the workers,
// sorted and joined with `, `, and `specifier` the edges inside the component, each written
// `<worker>.<BINDING> -> <worker>`, sorted and joined with `; `. A ring with a chord, or two pairs
// sharing a worker, is one component and so one entry; a component that gains a worker or an edge
// is a new entry and the old one is pruned. The declared graph is the rule's input on purpose: a
// binding declared and never used is itself drift.
export function workerCycles(graph: WorkerGraph): BoundaryViolation[] {
  const sccOf = stronglyConnectedComponents([...graph.workers], adjacency(graph));
  const components = [...sccMembers([...graph.workers], sccOf).values()];
  return components
    .filter((members) => members.length > 1)
    .map((members): BoundaryViolation => {
      const inside = new Set(members);
      const edges = graph.edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to));
      return {
        kind: "worker-call-cycle",
        from: [...members].sort(byName).join(", "),
        to: null,
        specifier: edges.map(written).sort(byName).join("; "),
        typeOnly: false,
      };
    })
    .sort((a, b) => a.from.localeCompare(b.from));
}
