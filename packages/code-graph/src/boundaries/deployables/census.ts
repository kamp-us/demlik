import { type Deployables, workerOf } from "./deployables.js";

// One reference to a binding, as the finder read it: `file` is repo-relative.
export type SiteRow = { readonly file: string; readonly line: number; readonly binding: string };

// What the report says about the deployables a run measured, beside its violations: per worker the
// sites the finder read (clean or not), the files holding them and the bindings referenced with
// their site counts, and the service bindings, repo-wide, that point at a worker with no config in
// the repo. A worker no file of a measured scope references a binding in is not listed.
export type WorkerCensus = {
  readonly worker: string;
  readonly files: readonly string[];
  readonly bindings: Readonly<Record<string, number>>;
  readonly sites: readonly SiteRow[];
};

export type DeployableCensus = {
  readonly workers: readonly WorkerCensus[];
  readonly unresolvedServiceBindings: number;
};

const byName = (a: string, b: string): number => a.localeCompare(b);

function compareSites(a: SiteRow, b: SiteRow): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.binding.localeCompare(b.binding);
}

function workerRow(worker: string, rows: readonly SiteRow[]): WorkerCensus {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.binding, (counts.get(row.binding) ?? 0) + 1);
  return {
    worker,
    files: [...new Set(rows.map((row) => row.file))].sort(byName),
    bindings: Object.fromEntries([...counts].sort(([a], [b]) => byName(a, b))),
    sites: [...rows].sort(compareSites),
  };
}

// The census of a run, or null when the rules file lists no kind: then the report has nothing to
// say about deployables, and says nothing.
export function deployableCensus(
  deployables: Deployables,
  rows: readonly SiteRow[],
): DeployableCensus | null {
  if (deployables.kinds.size === 0) return null;
  const byWorker = new Map<string, SiteRow[]>();
  for (const row of rows) {
    const worker = workerOf(deployables, row.file)?.service;
    if (worker === undefined) continue;
    const own = byWorker.get(worker) ?? [];
    own.push(row);
    byWorker.set(worker, own);
  }
  return {
    workers: [...byWorker]
      .sort(([a], [b]) => byName(a, b))
      .map(([worker, own]) => workerRow(worker, own)),
    unresolvedServiceBindings: deployables.graph.unresolved,
  };
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

function workerLine(row: WorkerCensus): string {
  const names = Object.entries(row.bindings).map(([binding, sites]) => `${binding} ${sites}`);
  return (
    `  ${row.worker}: ${count(row.sites.length, "site")} in ${count(row.files.length, "file")} ` +
    `over ${count(names.length, "binding")} (${names.join(", ")})`
  );
}

export function deployableCensusLines(census: DeployableCensus): string[] {
  const sites = census.workers.reduce((sum, row) => sum + row.sites.length, 0);
  return [
    `deployables: ${count(census.workers.length, "worker")} using bindings, ${count(sites, "site")}, ` +
      `${count(census.unresolvedServiceBindings, "service binding")} to a worker with no config in the repo`,
    ...census.workers.map(workerLine),
  ];
}
