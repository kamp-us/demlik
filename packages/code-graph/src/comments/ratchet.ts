import { stableStringify } from "../render/json.js";
import { CEILINGS_FILENAME, type CommentCeilings, isGovernedScope, toPoints } from "./ceilings.js";
import { type CommentCensus, governedRatio } from "./census.js";

export type CeilingDirection = "EXCEEDED" | "SLACK";

export type CeilingViolation = {
  scope: string;
  measured: number;
  ceiling: number;
  direction: CeilingDirection;
  delta: number;
  inherited: boolean;
};

export type RatchetVerdict = {
  passed: boolean;
  scopesChecked: number;
  inheritedScopes: number;
  defaultCeiling: number;
  slackPoints: number;
  violations: CeilingViolation[];
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function checkScope(
  scope: string,
  ratio: number,
  ceilings: CommentCeilings,
): CeilingViolation | null {
  const recorded = ceilings.scopes[scope];
  const inherited = recorded === undefined;
  const ceiling = recorded ?? ceilings.default;
  const measured = toPoints(ratio);
  const delta = round1(measured - ceiling);

  if (delta > 0) return { scope, measured, ceiling, direction: "EXCEEDED", delta, inherited };
  if (inherited) return null;
  if (-delta > ceilings.slackPoints) {
    return { scope, measured, ceiling, direction: "SLACK", delta, inherited };
  }
  return null;
}

export function evaluateRatchet(census: CommentCensus, ceilings: CommentCeilings): RatchetVerdict {
  const violations: CeilingViolation[] = [];
  let inheritedScopes = 0;
  for (const row of census.scopes) {
    if (!isGovernedScope(row.scope)) continue;
    if (ceilings.scopes[row.scope] === undefined) inheritedScopes += 1;
    const violation = checkScope(row.scope, governedRatio(row), ceilings);
    if (violation !== null) violations.push(violation);
  }
  violations.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.scope.localeCompare(b.scope),
  );
  return {
    passed: violations.length === 0,
    scopesChecked: census.scopes.filter((s) => isGovernedScope(s.scope)).length,
    inheritedScopes,
    defaultCeiling: ceilings.default,
    slackPoints: ceilings.slackPoints,
    violations,
  };
}

function pts(value: number): string {
  return `${value.toFixed(1)}%`;
}

function violationLine(violation: CeilingViolation): string {
  const sign = violation.delta > 0 ? "+" : "";
  const tag = violation.inherited ? "  (default)" : "";
  return (
    `  ${violation.scope.padEnd(46)}${pts(violation.measured).padStart(8)}` +
    `${pts(violation.ceiling).padStart(9)}  ${violation.direction.padEnd(9)}` +
    `${`${sign}${violation.delta.toFixed(1)}`.padStart(7)} pts${tag}`
  );
}

function failureLines(verdict: RatchetVerdict): string[] {
  const lines = [
    `COMMENT RATCHET FAILED — ${verdict.violations.length} of ${verdict.scopesChecked} scope(s) off their ceiling.`,
    `  ${"scope".padEnd(46)}${"measured".padStart(8)}${"ceiling".padStart(9)}  ${"direction".padEnd(9)}${"delta".padStart(7)}`,
    ...verdict.violations.map(violationLine),
  ];
  if (verdict.violations.some((v) => v.direction === "EXCEEDED")) {
    lines.push(
      "  EXCEEDED: comment volume grew past what this scope recorded. Cut it back, or",
      `  raise the entry in ${CEILINGS_FILENAME} and say why in the PR body.`,
    );
  }
  if (verdict.violations.some((v) => v.direction === "SLACK")) {
    lines.push(
      `  SLACK: the ceiling sits more than ${verdict.slackPoints} pts above reality, so it is no`,
      "  longer a ceiling. Re-record: `pnpm code-graph . --comments --write-ceilings`.",
    );
  }
  return lines;
}

export type RatchetRender = { readonly stdout: string; readonly exitCode: number };

export function renderRatchet(
  verdict: RatchetVerdict,
  json: boolean,
  pretty: boolean,
): RatchetRender {
  const exitCode = verdict.passed ? 0 : 1;
  if (json) return { stdout: stableStringify(verdict, pretty), exitCode };
  if (verdict.passed) {
    return {
      stdout:
        `comment ratchet: PASS — ${verdict.scopesChecked} scope(s) within ceiling ` +
        `(${verdict.inheritedScopes} on the ${pts(verdict.defaultCeiling)} default, slack ${verdict.slackPoints} pts).`,
      exitCode,
    };
  }
  return { stdout: failureLines(verdict).join("\n"), exitCode };
}
