import fs from "node:fs";
import path from "node:path";
import { ownerOf } from "../../extract/cross-runtime.js";
import { discoverPackageRoots, listRepo, type RepoListing } from "../../extract/project.js";
import {
  type BindingCatalog,
  loadBindingCatalog,
  type ServiceManifest,
} from "../../extract/wrangler-config.js";
import type { BindingKind, DataBindingKind, ImportEdge } from "../../schema.js";
import { NO_GRAPH, type WorkerGraph, workerGraph } from "./cycles.js";
import { type DeployableKind, type DeployableRules, declaresDeployables } from "./schema.js";

type CatalogKind = BindingKind | DataBindingKind;

// Which binding kinds B17 judges, one row per kind the catalog holds, so a kind added later does
// not compile until someone decides. A Workflow binding is not judged: it starts a run, and is not
// a call on another worker or a store.
const JUDGED = {
  service: true,
  "durable-object": true,
  d1: true,
  kv: true,
  r2: true,
  queue: true,
  workflow: false,
} as const satisfies Record<CatalogKind, boolean>;

export type JudgedBinding = { readonly kind: CatalogKind; readonly binding: string };

// The deployables a rules file turns on, read once for the run: the worker configs of the whole
// repo, which of their bindings B17 judges, and the package roots B19 compares.
export type Deployables = {
  readonly kinds: ReadonlySet<DeployableKind>;
  readonly catalog: BindingCatalog;
  readonly graph: WorkerGraph;
  // Directories holding a `package.json`, `.` being the repo root when it holds one.
  readonly workspaces: ReadonlySet<string>;
  // What each worker config declares that B17 judges, by binding name. A Durable Object is in the
  // catalog twice (as a call target and as a store) and here once.
  readonly judged: ReadonlyMap<ServiceManifest, ReadonlyMap<string, JudgedBinding>>;
};

// One reference a file makes to a binding its owning worker declares. `binding` is the name in the
// worker's config, and the line is where the reference starts.
export type BindingSite = { readonly binding: string; readonly line: number };

// The facts of one file the deployable rules read, as `analyzeBoundaries` hands them over.
// `file` is scope-relative and `from` repo-relative, as the ledger writes it; `driven` is whether
// the file sits in a hexagonal feature's `adapters/driven/`, and `owners` the scope's
// `bindingOwners`.
export type DeployableFile = {
  readonly scope: string;
  readonly file: string;
  readonly from: string;
  readonly importEdges: readonly ImportEdge[];
  readonly bindingSites: readonly BindingSite[];
  readonly driven: boolean;
  readonly owners: Readonly<Record<string, readonly string[]>>;
};

const NO_CATALOG: BindingCatalog = { manifests: [], unparsedConfigs: [] };

// What a rules file that lists no kind reads as: nothing is read, no wrangler config and no
// package root, so every question below answers "none" without the repo being touched.
export const NO_DEPLOYABLES: Deployables = {
  kinds: new Set(),
  catalog: NO_CATALOG,
  graph: NO_GRAPH,
  workspaces: new Set(),
  judged: new Map(),
};

function judgedBindings(manifest: ServiceManifest): ReadonlyMap<string, JudgedBinding> {
  const declared: JudgedBinding[] = [
    ...manifest.bindings.map(({ kind, binding }) => ({ kind, binding })),
    ...manifest.dataBindings,
  ];
  return new Map(
    declared.filter((decl) => JUDGED[decl.kind]).map((decl) => [decl.binding, decl] as const),
  );
}

function workspaceRoots(repoRoot: string, listing: RepoListing): Set<string> {
  const dirs = discoverPackageRoots(repoRoot, listing).filter((dir) => dir !== "");
  const hasRootManifest = fs.existsSync(path.join(repoRoot, "package.json"));
  return new Set(hasRootManifest ? [".", ...dirs] : dirs);
}

// Reads the repo for the listed kinds. A declaration that lists none costs nothing: the repo is
// not read. `listing` is the repo's files, listed once for the run.
export function readDeployables(
  rules: DeployableRules,
  repoRoot: string,
  listing: RepoListing | undefined,
): Deployables {
  if (!declaresDeployables(rules)) return NO_DEPLOYABLES;
  const files = listing ?? listRepo(repoRoot);
  const kinds = new Set(rules.acrossDeployables);
  const catalog = loadBindingCatalog(repoRoot, files);
  return {
    kinds,
    catalog,
    graph: workerGraph(catalog),
    workspaces: kinds.has("relative-import-crosses-workspace")
      ? workspaceRoots(repoRoot, files)
      : new Set(),
    judged: new Map(catalog.manifests.map((m) => [m, judgedBindings(m)])),
  };
}

// The worker a repo-relative file belongs to: the nearest config above it.
export function workerOf(deployables: Deployables, file: string): ServiceManifest | null {
  return ownerOf(deployables.catalog.manifests, file);
}
