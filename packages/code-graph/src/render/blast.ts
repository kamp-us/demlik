import { selfRecursiveCallCount } from "../extract/edges.js";
import type { FunctionNode, Graph } from "../schema.js";
import { stableStringify } from "./json.js";

export type BlastCaller = {
  callerId: string;
  file: string;
  line: number;
  depth: number;
};

export type BlastResult = {
  stdout: string | null;
  warning: string | null;
  exitCode: number;
};

type BlastOutput = {
  target: string;
  scope: "package" | "deep";
  targetCallChainDepth: number;
  crossPackageCallersOmitted: boolean;
  recursiveSelfCalls: number;
  callers: BlastCaller[];
};

function resolveTargets(functions: FunctionNode[], idOrName: string): FunctionNode[] {
  const exact = functions.filter((f) => f.id === idOrName);
  if (exact.length > 0) return exact;
  return functions.filter((f) => f.name === idOrName);
}

type CallerTraversal = {
  bestDepth: Map<string, number>;
  bestLine: Map<string, number>;
  visited: Set<string>;
  queue: { id: string; depth: number }[];
};

function relaxCaller(
  tr: CallerTraversal,
  targetId: string,
  callerId: string,
  line: number,
  depth: number,
): void {
  if (callerId === targetId) return;
  const cDepth = depth + 1;
  const prev = tr.bestDepth.get(callerId);
  if (prev === undefined || cDepth < prev) {
    tr.bestDepth.set(callerId, cDepth);
    tr.bestLine.set(callerId, line);
  }
  if (!tr.visited.has(callerId)) {
    tr.visited.add(callerId);
    tr.queue.push({ id: callerId, depth: cDepth });
  }
}

function collectCallers(byId: Map<string, FunctionNode>, target: FunctionNode): BlastCaller[] {
  const tr: CallerTraversal = {
    bestDepth: new Map(),
    bestLine: new Map(),
    visited: new Set([target.id]),
    queue: [{ id: target.id, depth: 0 }],
  };

  let i = 0;
  while (i < tr.queue.length) {
    const head = tr.queue[i++];
    if (!head) break;
    const node = byId.get(head.id);
    if (!node?.edges) continue;
    for (const caller of node.edges.calledBy) {
      relaxCaller(tr, target.id, caller.callerId, caller.line, head.depth);
    }
  }

  const callers: BlastCaller[] = [];
  for (const [cId, depth] of tr.bestDepth) {
    const node = byId.get(cId);
    callers.push({
      callerId: cId,
      file: node ? node.file : "",
      line: tr.bestLine.get(cId) ?? 0,
      depth,
    });
  }
  callers.sort(
    (a, b) => a.depth - b.depth || a.callerId.localeCompare(b.callerId) || a.line - b.line,
  );
  return callers;
}

function resolveSingleTarget(
  graph: Graph,
  idOrName: string,
): { target: FunctionNode } | { error: BlastResult } {
  const targets = resolveTargets(graph.functions, idOrName);
  if (targets.length === 0) {
    const inFailure = graph.summary.parseFailures.some((f) => idOrName.startsWith(f));
    const hint = inFailure ? " (its file is in parseFailures and was excluded)" : "";
    return {
      error: {
        stdout: null,
        warning: `error: no function matches "${idOrName}"${hint}. Pass an id (file:name) from --graph/--plan.`,
        exitCode: 1,
      },
    };
  }
  if (targets.length > 1) {
    const candidates = targets.map((t) => t.id).sort((a, b) => a.localeCompare(b));
    const list = candidates.map((c) => `  ${c}`).join("\n");
    return {
      error: {
        stdout: null,
        warning: `error: "${idOrName}" is ambiguous — ${candidates.length} matches. Pass one id:\n${list}`,
        exitCode: 1,
      },
    };
  }
  return { target: targets[0] };
}

function renderBlastHuman(output: BlastOutput): string {
  const lines: string[] = [];
  lines.push(`blast: ${output.target}`);
  lines.push(`scope: ${output.scope}  targetCallChainDepth: ${output.targetCallChainDepth}`);
  if (output.recursiveSelfCalls > 0) {
    lines.push(`recursive: ${output.recursiveSelfCalls} self-calls (not counted as fan-in)`);
  }
  if (output.callers.length === 0) {
    lines.push("callers: (none in scope)");
  } else {
    lines.push(`callers (${output.callers.length}):`);
    for (const c of output.callers) {
      lines.push(`  d${c.depth}  ${c.callerId}  ${c.file}:${c.line}`);
    }
  }
  return lines.join("\n");
}

export function renderBlast(
  graph: Graph,
  idOrName: string,
  json: boolean,
  pretty: boolean,
): BlastResult {
  if (graph.provenance.pass !== "edges") {
    return {
      stdout: null,
      warning: "warning: --blast requires the edge pass; this graph has none.",
      exitCode: 2,
    };
  }
  const scope = graph.provenance.scope;

  const resolved = resolveSingleTarget(graph, idOrName);
  if ("error" in resolved) return resolved.error;
  const { target } = resolved;

  const byId = new Map(graph.functions.map((f) => [f.id, f]));
  const callers = collectCallers(byId, target);
  const selfCalls = selfRecursiveCallCount(target.id, target.edges?.calledBy ?? []);
  const output: BlastOutput = {
    target: target.id,
    scope,
    targetCallChainDepth: target.edges?.callChainDepth ?? 0,
    crossPackageCallersOmitted: scope === "package",
    recursiveSelfCalls: selfCalls,
    callers,
  };

  const warning =
    scope === "package"
      ? "warning: package scope — cross-package callers omitted. Re-run with --deep for the full blast radius."
      : null;

  const stdout = json ? stableStringify(output, pretty) : renderBlastHuman(output);
  return { stdout, warning, exitCode: 0 };
}
