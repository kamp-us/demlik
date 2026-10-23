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

function failOnOf(requested: string): FailOn {
  if (isFailOn(requested)) return requested;
  process.stderr.write(`warning: unknown --fail-on "${requested}"; falling back to "high".\n`);
  return "high";
}

// The smell gate a plain `--ci` runs: reads `--fail-on` and `--max` as given, prints the verdict on
// stdout and returns the exit code (2 for a `--max` that is not a non-negative integer).
export function runSmellGate(
  graph: Graph,
  failOn: string | undefined,
  max: string | undefined,
): number {
  const policy = failOnOf(failOn ?? "high");
  let ceiling: number | null = null;
  if (max !== undefined) {
    const trimmed = max.trim();
    if (!/^\d+$/.test(trimmed)) {
      process.stderr.write(`error: --max expects a non-negative integer, got "${max}".\n`);
      return 2;
    }
    ceiling = Number.parseInt(trimmed, 10);
  }
  const { passed, report } = evaluateCi(graph, policy, ceiling);
  process.stdout.write(`${report}\n`);
  return passed ? 0 : 1;
}
