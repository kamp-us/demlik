import type { Graph } from "../schema.js";

export type FailOn = "high" | "warn";

export type CiResult = {
  passed: boolean;
  report: string;
};

export function isFailOn(value: string): value is FailOn {
  return value === "high" || value === "warn";
}

function failureReasons(total: number, high: number, failOn: FailOn, max: number | null): string[] {
  const reasons: string[] = [];
  if (failOn === "high" && high > 0) {
    reasons.push(`${high} high-severity smell${high === 1 ? "" : "s"}`);
  }
  if (failOn === "warn" && total > 0) {
    reasons.push(`${total} smell${total === 1 ? "" : "s"} (fail-on=warn)`);
  }
  if (max !== null && total > max) {
    const phrase = total === 1 ? "smell exceeds" : "smells exceed";
    reasons.push(`${total} ${phrase} --max ${max}`);
  }
  return reasons;
}

export function evaluateCi(graph: Graph, failOn: FailOn, max: number | null): CiResult {
  const total = graph.smells.length;
  const high = graph.smells.filter((s) => s.severity === "high").length;

  const reasons = failureReasons(total, high, failOn, max);
  if (reasons.length > 0) {
    return { passed: false, report: `code-graph CI: FAIL — ${reasons.join("; ")}.` };
  }

  const maxNote = max !== null ? `, max ${max}` : "";
  return {
    passed: true,
    report: `code-graph CI: PASS — ${total} smells, ${high} high-severity (fail-on=${failOn}${maxNote}).`,
  };
}
