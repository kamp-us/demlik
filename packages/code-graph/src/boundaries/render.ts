import { hasDirection, ratchetTableLines, type ScopeCountVerdict } from "../ratchet/scope-count.js";
import { stableStringify } from "../render/json.js";
import type { BoundaryKind, BoundaryViolation, ScopeBoundaryReport } from "./analyze.js";

export type BoundaryRender = { readonly stdout: string; readonly exitCode: number };

function ruleOf(kind: BoundaryKind): string {
  switch (kind) {
    case "cross-feature":
      return "B1";
    case "impure-rules":
      return "B2";
    case "lib-imports-feature":
      return "B3";
    case "outside-imports-feature-internal":
      return "B4";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function targetOf(violation: BoundaryViolation): string {
  switch (violation.kind) {
    case "cross-feature":
    case "lib-imports-feature":
    case "outside-imports-feature-internal":
      return violation.to;
    case "impure-rules":
      return violation.to ?? violation.specifier;
    default: {
      const exhaustive: never = violation;
      return exhaustive;
    }
  }
}

function violationLine(violation: BoundaryViolation): string {
  const tag = violation.typeOnly ? "  [type-only]" : "";
  return (
    `  ${ruleOf(violation.kind)} ${violation.kind.padEnd(19)} ${violation.from} -> ` +
    `${targetOf(violation)}  ("${violation.specifier}")${tag}`
  );
}

function scopeLines(report: ScopeBoundaryReport): string[] {
  return [
    `${report.scope} — features: ${report.features.join(", ")}`,
    `  scanned ${report.filesScanned} files — ${report.violations.length} violation(s)`,
    ...report.violations.map(violationLine),
  ];
}

export function renderBoundaries(
  reports: readonly ScopeBoundaryReport[],
  under: string,
  json: boolean,
  pretty: boolean,
): string {
  if (json) return stableStringify({ scopes: reports }, pretty);
  if (reports.length === 0) {
    return `boundaries: no feature scope declared at or under "${under}" — nothing to check.`;
  }
  return reports.flatMap(scopeLines).join("\n");
}

function failureLines(verdict: ScopeCountVerdict): string[] {
  const lines = ratchetTableLines(verdict, "BOUNDARY");
  if (hasDirection(verdict, "EXCEEDED")) {
    lines.push(
      "  EXCEEDED: a new import crosses a feature boundary. Import a feature from outside it",
      "  through its index.ts, keep rules/ on contracts only, and keep lib/ out of features.",
      "  `pnpm code-graph <scope> --boundaries` lists the edges.",
    );
  }
  if (hasDirection(verdict, "SLACK")) {
    lines.push(
      "  SLACK: the ceiling sits above reality, so it is no longer a ceiling. Re-record:",
      "  `pnpm code-graph <scope> --boundaries --write-ceilings`.",
    );
  }
  return lines;
}

export function renderBoundaryRatchet(
  verdict: ScopeCountVerdict,
  json: boolean,
  pretty: boolean,
): BoundaryRender {
  const exitCode = verdict.passed ? 0 : 1;
  if (json) return { stdout: stableStringify(verdict, pretty), exitCode };
  if (verdict.passed) {
    return {
      stdout: `boundary ratchet: PASS — ${verdict.scopesChecked} scope(s) on their ceiling.`,
      exitCode,
    };
  }
  return { stdout: failureLines(verdict).join("\n"), exitCode };
}
