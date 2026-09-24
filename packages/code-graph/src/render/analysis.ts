import path from "node:path";
import type { EnvKeyReport } from "../env-keys/query.js";
import { discoverPackageRoots } from "../extract/project.js";
import { kindCensus } from "../kinds/classify.js";
import type {
  ClusterReport,
  CrossRuntimeReport,
  Graph,
  ReachabilityReport,
  WithheldReason,
} from "../schema.js";
import { analyzeCoupling, type Cycle } from "../smells/coupling.js";
import { stableStringify } from "./json.js";

const REACH_NOT_RUN = "reachability: pass did not run — add --unreachable or --unguarded.";

function crossTally(report: CrossRuntimeReport): {
  resolved: number;
  unresolved: number;
  dead: number;
} {
  return {
    resolved: report.edges.filter((e) => e.calleeId !== null).length,
    unresolved: report.edges.filter((e) => e.calleeId === null).length,
    dead: report.census.filter((c) => c.callSites === 0).length,
  };
}

function unresolvedLines(report: CrossRuntimeReport, count: number): string[] {
  if (count === 0) return [];
  const lines = [`unresolved (${count}):`];
  for (const e of report.edges) {
    if (e.calleeId === null) {
      lines.push(
        `  ${e.reason}  ${e.ownerService} → ${e.targetService}.${e.targetClass}.${e.method}()` +
          `  ${e.callerId}:${e.line}`,
      );
    }
  }
  return lines;
}

function renderCrossRuntimeHuman(report: CrossRuntimeReport): string {
  const { resolved, unresolved, dead } = crossTally(report);
  const lines: string[] = [
    `cross-runtime: ${report.edges.length} binding call sites (${resolved} resolved, ` +
      `${unresolved} unresolved) from ${report.configFiles.length} wrangler configs`,
  ];
  for (const c of report.unparsedConfigs) lines.push(`  UNPARSED CONFIG  ${c}`);
  lines.push(...unresolvedLines(report, unresolved));
  lines.push(`declared bindings (${report.census.length}, ${dead} with no call site):`);
  for (const c of report.census) {
    lines.push(
      `  ${c.ownerService}.env.${c.binding} → ${c.targetService}.${c.targetClass} ` +
        `[${c.bindingKind}] ${c.callSites} call sites${c.callSites === 0 ? "  UNUSED" : ""}`,
    );
  }
  return lines.join("\n");
}

export function renderCrossRuntime(graph: Graph, json: boolean, pretty: boolean): string {
  const report = graph.crossRuntime;
  if (report === null) {
    return "cross-runtime: pass did not run — add --cross-runtime (it implies the edge pass).";
  }
  return json ? stableStringify(report, pretty) : renderCrossRuntimeHuman(report);
}

export function renderKinds(graph: Graph, json: boolean, pretty: boolean): string {
  const census = kindCensus(graph.functions);
  if (json) return stableStringify(census, pretty);
  const total = census.entry + census.auth + census.effect + census.plain;
  if (total === 0) return "kinds: pass did not run — add --kinds (it implies --cross-runtime).";
  return [
    `kinds: ${total} classified nodes`,
    `  entry   ${census.entry}`,
    `  auth    ${census.auth}`,
    `  effect  ${census.effect}`,
    `  plain   ${census.plain}   (unclassified — no declared rule matched)`,
  ].join("\n");
}

function withheldTally(report: ReachabilityReport): [WithheldReason, number][] {
  const counts = new Map<WithheldReason, number>();
  for (const w of report.withheld) counts.set(w.reason, (counts.get(w.reason) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

export function renderUnreachable(graph: Graph, json: boolean, pretty: boolean): string {
  const report = graph.reachability;
  if (report === null) return REACH_NOT_RUN;
  if (json) {
    return stableStringify(
      { entryCount: report.entryCount, unreachable: report.unreachable, withheld: report.withheld },
      pretty,
    );
  }
  const lines: string[] = [
    `unreachable: ${report.unreachable.length} of ${report.exportedCount} exported symbols ` +
      `(${report.entryCount} entries, ${report.reachableCount} nodes reachable)`,
  ];
  for (const u of report.unreachable) {
    const witness = u.testReferences.length > 0 ? `  <- ${u.testReferences.join(", ")}` : "";
    lines.push(`  ${u.category}  ${u.id}  ${u.file}:${u.startLine}${witness}`);
  }
  lines.push(`withheld (${report.withheld.length}) — an unmodelled construct may reach them:`);
  for (const [reason, count] of withheldTally(report)) lines.push(`  ${reason}  ${count}`);
  return lines.join("\n");
}

export function renderUnguarded(graph: Graph, json: boolean, pretty: boolean): string {
  const report = graph.reachability;
  if (report === null) return REACH_NOT_RUN;
  if (json) return stableStringify(report.unguarded, pretty);
  const lines: string[] = [
    `unguarded: ${report.unguarded.length} effect nodes reachable from an entry ` +
      `without crossing an auth node (${report.entryCount} entries)`,
  ];
  for (const u of report.unguarded) {
    lines.push(`  ${u.effectId}  ${u.file}:${u.startLine}`);
    lines.push(`    from ${u.entryId}  via ${u.path.join(" -> ")}`);
  }
  return lines.join("\n");
}

const CLUSTERS_NOT_RUN =
  "clusters: pass did not run — add --clusters (it implies --cross-runtime).";

const TOP_N = 20;
const FILES_PER_GROUP = 8;

function moreLine(total: number, shown: number): string[] {
  return total > shown ? [`  … and ${total - shown} more (use --json for the full list)`] : [];
}

function fileList(files: readonly string[]): string {
  const shown = files.slice(0, FILES_PER_GROUP).join(", ");
  return files.length > FILES_PER_GROUP
    ? `${shown}, +${files.length - FILES_PER_GROUP} more`
    : shown;
}

function headline(report: ClusterReport): string {
  return (
    `clusters: ${report.clusterCount} communities over ${report.clusteredFileCount} files ` +
    `(modularity ${report.modularity}, ${report.algorithm}); ` +
    `${report.isolatedFileCount} isolated, ${report.excludedTestFileCount} test files excluded`
  );
}

function splitLines(report: ClusterReport): string[] {
  const rows = report.splitDirectories;
  const lines = [`directories spanning multiple clusters (${rows.length}):`];
  for (const d of rows.slice(0, TOP_N)) {
    lines.push(`  ${d.dir}  ${d.clusterCount} clusters over ${d.fileCount} files`);
    for (const c of d.clusters) lines.push(`    ${c.clusterId}  ${fileList(c.files)}`);
    if (d.isolatedFiles.length > 0) {
      lines.push(`    isolated  ${fileList(d.isolatedFiles)}`);
    }
  }
  return [...lines, ...moreLine(rows.length, TOP_N)];
}

function scatteredLines(report: ClusterReport): string[] {
  const rows = report.scatteredClusters;
  const lines = [`clusters scattered across directories (${rows.length}):`];
  for (const c of rows.slice(0, TOP_N)) {
    lines.push(`  ${c.id}  ${c.size} files over ${c.dirCount} directories`);
    for (const d of c.dirs) lines.push(`    ${d.dir}  ${fileList(d.files)}`);
  }
  return [...lines, ...moreLine(rows.length, TOP_N)];
}

export function renderClusters(graph: Graph, json: boolean, pretty: boolean): string {
  const report = graph.clusters;
  if (report === null) return CLUSTERS_NOT_RUN;
  if (json) return stableStringify(report, pretty);
  return [headline(report), ...splitLines(report), ...scatteredLines(report)].join("\n");
}

const WIDTH_NOT_RUN =
  "interface width: pass did not run — add --interface-width (implies the edge pass).";

export function renderInterfaceWidth(graph: Graph, json: boolean, pretty: boolean): string {
  const report = graph.interfaceWidth;
  if (report === null) return WIDTH_NOT_RUN;
  if (json) return stableStringify(report, pretty);
  const lines: string[] = [
    `interface width: ${report.packages.length} packages, ${report.totalExports} exports, ` +
      `${report.totalZeroConsumer} with zero external consumers (free deletions)`,
  ];
  for (const pkg of report.packages) {
    const label = pkg.package === "" ? "." : pkg.package;
    lines.push(`  ${label}  ${pkg.exportCount} exports, ${pkg.zeroConsumerCount} zero-consumer`);
    for (const e of pkg.exports) {
      if (e.externalConsumers.length > 0) continue;
      lines.push(`    ZERO-CONSUMER  ${e.id}  ${e.file}:${e.startLine}`);
    }
  }
  return lines.join("\n");
}

function renderCyclesHuman(cycles: Cycle[]): string {
  if (cycles.length === 0) return "cycles: none";
  const lines = [`cycles: ${cycles.length} dependency cycle(s) in the module import graph`];
  for (const c of cycles) {
    lines.push(`  cycle of ${c.members.length}:`);
    for (const f of c.members) lines.push(`    ${f}`);
  }
  return lines.join("\n");
}

export function renderCycles(graph: Graph, json: boolean, pretty: boolean): string {
  if (graph.provenance.pass !== "edges") {
    return "cycles: pass did not run — add --edges (the import graph needs the edge pass).";
  }
  const rootAbsolute = path.resolve(process.cwd(), graph.root);
  const packageRoots = discoverPackageRoots(rootAbsolute);
  const cycles = analyzeCoupling(graph.modules, packageRoots).cycles;
  return json ? stableStringify(cycles, pretty) : renderCyclesHuman(cycles);
}

function envWithheldTally(report: EnvKeyReport): [string, number][] {
  const counts = new Map<string, number>();
  for (const w of report.withheld) counts.set(w.reason, (counts.get(w.reason) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderEnvKeysHuman(report: EnvKeyReport): string {
  const lines: string[] = [
    `env-keys: ${report.declaredCount} declared, ${report.readCount} recognized reads`,
  ];
  lines.push(`declared, never read (${report.declaredUnreferenced.length}):`);
  for (const f of report.declaredUnreferenced) {
    lines.push(`  ${f.key}  ${f.service}  ${f.configFile}`);
  }
  lines.push(`read, never declared (${report.readNotDeclared.length}):`);
  for (const r of report.readNotDeclared) {
    lines.push(`  ${r.key}  ${r.service}  ${r.file}:${r.line}`);
  }
  lines.push(`withheld (${report.withheld.length}) — an unmodelled construct may settle these:`);
  for (const [reason, count] of envWithheldTally(report)) lines.push(`  ${reason}  ${count}`);
  return lines.join("\n");
}

export function renderEnvKeys(report: EnvKeyReport, json: boolean, pretty: boolean): string {
  return json ? stableStringify(report, pretty) : renderEnvKeysHuman(report);
}
