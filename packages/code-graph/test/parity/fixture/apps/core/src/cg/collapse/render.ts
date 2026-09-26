import { discoverPackageRoots } from "../extract/project.js";
import { stableStringify } from "../render/json.js";
import type { Graph } from "../schema.js";
import {
  type CollapseCandidate,
  type CollapseCluster,
  type CollapseReport,
  findCollapseCandidates,
} from "./candidates.js";
import type { PartialTwin } from "./partial.js";
import type { CollapseSettings } from "./settings.js";
import type { Signal } from "./signals.js";

const HUMAN_LIMIT = 20;
const SKIPPED_SHOWN = 5;
const BLOCK_SHOWN = 4;

function label(signal: Signal): string {
  switch (signal.signal) {
    case "shape":
      return "shape";
    case "callees":
      return "callees";
    case "callers":
      return "callers";
    case "name":
      return "name";
  }
}

function costLine(candidate: CollapseCandidate): string {
  const c = candidate.costInputs;
  return (
    `     cost=${candidate.cost}  callers=${c.callerUnion} packages=${c.packagesSpanned}` +
    `${c.crossesPackage ? " cross-package" : ""}${c.effectOnPath ? " effect-on-path" : ""}`
  );
}

function formatCluster(cluster: CollapseCluster, index: number): string {
  const candidate: CollapseCandidate = cluster.representative;
  const position = String(index + 1).padStart(3, " ");
  const lines = [
    `${position}. rank=${candidate.rank}  confidence=${candidate.confidence}` +
      (cluster.pairCount > 1
        ? `  cluster of ${cluster.members.length} (${cluster.pairCount} pairs)`
        : ""),
    `     A ${candidate.aId}  ${candidate.aFile}:${candidate.aStartLine}`,
    `     B ${candidate.bId}  ${candidate.bFile}:${candidate.bStartLine}`,
    costLine(candidate),
  ];
  for (const signal of candidate.signals) {
    lines.push(`     + ${label(signal)} ${signal.strength}  ${signal.detail}`);
  }
  const rest = cluster.members.filter((m) => m !== candidate.aId && m !== candidate.bId);
  if (rest.length > 0) lines.push(`     also: ${rest.join(", ")}`);
  return lines.join("\n");
}

export function shortCalleeName(calleeId: string): string {
  const bare = calleeId.startsWith("external:") ? calleeId.slice("external:".length) : calleeId;
  return bare.slice(bare.lastIndexOf(":") + 1);
}

function blockLine(twin: PartialTwin): string {
  const names = twin.sharedBlock.map(shortCalleeName);
  const head = names.slice(0, BLOCK_SHOWN).join(" -> ");
  const rest = names.length > BLOCK_SHOWN ? ` -> +${names.length - BLOCK_SHOWN} more` : "";
  return `     shared block (${twin.sharedBlock.length} calls)  ${head}${rest}`;
}

function formatPartialTwin(twin: PartialTwin, index: number): string {
  const position = String(index + 1).padStart(3, " ");
  return [
    `${position}. block=${twin.sharedBlock.length}  constants=${twin.sharedConstants.length}`,
    `     A ${twin.aId}  ${twin.aFile}:${twin.aBlockLine}`,
    `     B ${twin.bId}  ${twin.bFile}:${twin.bBlockLine}`,
    blockLine(twin),
    `     shared constants  ${twin.sharedConstants.join(", ")}`,
    `     DIVERGES: A calls ${shortCalleeName(twin.aDiverges)} (${twin.aFile}:${twin.aDivergesLine})` +
      `  B calls ${shortCalleeName(twin.bDiverges)} (${twin.bFile}:${twin.bDivergesLine})`,
  ].join("\n");
}

export function partialTwinLines(report: CollapseReport): string[] {
  if (report.partialTwins.length === 0) {
    return ["partial twins: 0 — no shared decision block diverges on the same named constants"];
  }
  const lines = [
    `partial twins: ${report.partialTwins.length} — one decision block over the same named ` +
      "constants, two different outcomes",
    "GATEABLE (--collapse --ci) — each is intended and said so in the PR body, or it is a defect",
  ];
  for (const [i, twin] of report.partialTwins.slice(0, HUMAN_LIMIT).entries()) {
    lines.push(formatPartialTwin(twin, i));
  }
  return lines;
}

function skippedLines(report: CollapseReport): string[] {
  if (report.skippedBlocks.length === 0) return [];
  const lines = [
    `skipped ${report.skippedBlocks.length} blocking keys over maxBlockSize=` +
      `${report.settings.maxBlockSize} — pairs sharing ONLY one of these were never scored:`,
  ];
  for (const block of report.skippedBlocks.slice(0, SKIPPED_SHOWN)) {
    lines.push(`  ${block.kind}  ${block.key}  ${block.size} members`);
  }
  return lines;
}

function renderHuman(report: CollapseReport): string {
  const shown = Math.min(HUMAN_LIMIT, report.clusters.length);
  const lines = [
    `collapse candidates: ${report.clusters.length} findings / ${report.candidates.length} pairs ` +
      `(top ${shown} shown) from ${report.pairsScored} scored over ` +
      `${report.consideredFunctions} functions, minSignals=${report.settings.minSignals}`,
    "a REPORT, not a gate — the graph narrows, a human judges",
    ...skippedLines(report),
  ];
  for (const [i, cluster] of report.clusters.slice(0, HUMAN_LIMIT).entries()) {
    lines.push(formatCluster(cluster, i));
  }
  lines.push("", ...partialTwinLines(report));
  return lines.join("\n");
}

export function renderCollapse(
  graph: Graph,
  rootAbsolute: string,
  settings: CollapseSettings,
  json: boolean,
  pretty: boolean,
): string {
  if (graph.provenance.pass !== "edges") {
    return "collapse: needs the call graph; add --edges (--collapse implies it).";
  }
  const report = findCollapseCandidates(
    graph.functions,
    discoverPackageRoots(rootAbsolute),
    settings,
  );
  return json ? stableStringify(report, pretty) : renderHuman(report);
}
