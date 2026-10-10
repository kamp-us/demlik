import fs from "node:fs";
import path from "node:path";
import { ownerOf } from "../../extract/cross-runtime.js";
import { discoverPackageRoots, listRepo, type RepoListing } from "../../extract/project.js";
import type { BindingCatalog, ServiceManifest } from "../../extract/wrangler-config.js";
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

// Which kinds judge by what the worker configs declare, one row per kind. A config the run cannot
// parse is a worker these kinds never see, so with one listed the run refuses rather than answer
// without it. B19 reads paths and package roots, and no config.
const READS_WORKER_CONFIGS = {
  "binding-outside-driven-adapter": true,
  "worker-call-cycle": true,
  "relative-import-crosses-workspace": false,
} as const satisfies Record<DeployableKind, boolean>;

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
// the file sits in a hexagonal feature's `adapters/driven/`, `isMain` whether it is the `main` of the
// worker its bindings are judged against, and `owners` the scope's `bindingOwners`.
export type DeployableFile = {
  readonly scope: string;
  readonly file: string;
  readonly from: string;
  readonly importEdges: readonly ImportEdge[];
  readonly bindingSites: readonly BindingSite[];
  readonly driven: boolean;
  readonly isMain: boolean;
  readonly owners: Readonly<Record<string, readonly string[]>>;
};

// What a run that needs no wrangler config reads as: no worker.
export const NO_CATALOG: BindingCatalog = { manifests: [], unparsedConfigs: [] };

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

export type DeployablesRead =
  | { readonly kind: "read"; readonly deployables: Deployables }
  | { readonly kind: "refused"; readonly message: string };

// The one line that names the wrangler configs the listed kinds cannot do without, or null when
// every config parsed or no listed kind reads one.
function unreadableConfigsIssue(
  kinds: ReadonlySet<DeployableKind>,
  { unparsedConfigs }: BindingCatalog,
): string | null {
  const reading = [...kinds].filter((kind) => READS_WORKER_CONFIGS[kind]);
  if (reading.length === 0 || unparsedConfigs.length === 0) return null;
  return (
    `a wrangler config cannot be parsed: ${unparsedConfigs.join(", ")}. With ` +
    `${reading.map((kind) => `"${kind}"`).join(" and ")} listed, a worker whose config is not read ` +
    "is never judged: fix the file (JSON with comments, or TOML) and run again."
  );
}

// Reads the repo for the listed kinds, or says in one line why it cannot. A declaration that lists
// none costs nothing: the repo is not read. `listing` is the repo's files, listed once for the run,
// and `catalog` the wrangler configs, read once for the run beside whoever else needs them.
export function readDeployables(
  rules: DeployableRules,
  repoRoot: string,
  listing: RepoListing | undefined,
  catalog: BindingCatalog,
): DeployablesRead {
  if (!declaresDeployables(rules)) return { kind: "read", deployables: NO_DEPLOYABLES };
  const files = listing ?? listRepo(repoRoot);
  const kinds = new Set(rules.acrossDeployables);
  const message = unreadableConfigsIssue(kinds, catalog);
  if (message !== null) return { kind: "refused", message };
  return {
    kind: "read",
    deployables: {
      kinds,
      catalog,
      graph: workerGraph(catalog),
      workspaces: kinds.has("relative-import-crosses-workspace")
        ? workspaceRoots(repoRoot, files)
        : new Set(),
      judged: new Map(catalog.manifests.map((m) => [m, judgedBindings(m)])),
    },
  };
}

// The worker a repo-relative file belongs to: the nearest config above it.
export function workerOf(deployables: Deployables, file: string): ServiceManifest | null {
  return ownerOf(deployables.catalog.manifests, file);
}

// Whether a repo-relative file is the `main` the nearest worker config names, the file where that
// worker's own bindings are wired. A config with no `main`, or one naming a file no scope loads,
// has no such file here.
export function isWorkerMain(deployables: Deployables, file: string): boolean {
  return workerOf(deployables, file)?.main === file;
}
