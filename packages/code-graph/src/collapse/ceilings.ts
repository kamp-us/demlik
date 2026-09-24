import { z } from "zod";
import { stableStringify } from "../render/json.js";

export const CEILINGS_FILENAME = "collapse-ceilings.json";

export const CollapseCeilingsSchema = z
  .object({
    default: z.number().int().nonnegative().default(0),
    scopes: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .strict();

export type CollapseCeilings = z.infer<typeof CollapseCeilingsSchema>;

export type ScopeMeasurement = { readonly scope: string; readonly partialTwins: number };

export type CeilingDirection = "EXCEEDED" | "SLACK";

export type PartialTwinViolation = {
  scope: string;
  measured: number;
  ceiling: number;
  direction: CeilingDirection;
  delta: number;
};

export type PartialTwinVerdict = {
  passed: boolean;
  scopesChecked: number;
  violations: PartialTwinViolation[];
};

export function governedScopes(ceilings: CollapseCeilings, under: string): string[] {
  const prefix = under === "." ? "" : `${under}/`;
  return Object.keys(ceilings.scopes)
    .filter((scope) => under === "." || scope === under || scope.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b));
}

export function evaluatePartialTwinRatchet(
  measurements: readonly ScopeMeasurement[],
  ceilings: CollapseCeilings,
): PartialTwinVerdict {
  const violations: PartialTwinViolation[] = [];
  for (const { scope, partialTwins } of measurements) {
    const ceiling = ceilings.scopes[scope] ?? ceilings.default;
    const delta = partialTwins - ceiling;
    if (delta === 0) continue;
    violations.push({
      scope,
      measured: partialTwins,
      ceiling,
      direction: delta > 0 ? "EXCEEDED" : "SLACK",
      delta,
    });
  }
  violations.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.scope.localeCompare(b.scope),
  );
  return { passed: violations.length === 0, scopesChecked: measurements.length, violations };
}

export function recordCeilings(
  measurements: readonly ScopeMeasurement[],
  ceilings: CollapseCeilings,
): CollapseCeilings {
  const scopes = { ...ceilings.scopes };
  for (const { scope, partialTwins } of measurements) scopes[scope] = partialTwins;
  return { default: ceilings.default, scopes };
}

function violationLine(violation: PartialTwinViolation): string {
  const sign = violation.delta > 0 ? "+" : "";
  return (
    `  ${violation.scope.padEnd(46)}${String(violation.measured).padStart(8)}` +
    `${String(violation.ceiling).padStart(9)}  ${violation.direction.padEnd(9)}` +
    `${`${sign}${violation.delta}`.padStart(7)}`
  );
}

function failureLines(verdict: PartialTwinVerdict): string[] {
  const lines = [
    `PARTIAL-TWIN RATCHET FAILED — ${verdict.violations.length} of ${verdict.scopesChecked} scope(s) off their ceiling.`,
    `  ${"scope".padEnd(46)}${"measured".padStart(8)}${"ceiling".padStart(9)}  ${"direction".padEnd(9)}${"delta".padStart(7)}`,
    ...verdict.violations.map(violationLine),
  ];
  if (verdict.violations.some((v) => v.direction === "EXCEEDED")) {
    lines.push(
      "  EXCEEDED: a new shared decision prologue diverges on the same named constants.",
      "  Collapse it, or say in the PR body why the divergence is intended and re-record.",
      "  `pnpm code-graph <scope> --collapse` shows the pairs.",
    );
  }
  if (verdict.violations.some((v) => v.direction === "SLACK")) {
    lines.push(
      "  SLACK: the ceiling sits above reality, so it is no longer a ceiling. Re-record:",
      "  `pnpm code-graph <scope> --collapse --write-ceilings`.",
    );
  }
  return lines;
}

export type RatchetRender = { readonly stdout: string; readonly exitCode: number };

export function renderPartialTwinRatchet(
  verdict: PartialTwinVerdict,
  json: boolean,
  pretty: boolean,
): RatchetRender {
  const exitCode = verdict.passed ? 0 : 1;
  if (json) return { stdout: stableStringify(verdict, pretty), exitCode };
  if (verdict.passed) {
    return {
      stdout: `partial-twin ratchet: PASS — ${verdict.scopesChecked} scope(s) on their ceiling.`,
      exitCode,
    };
  }
  return { stdout: failureLines(verdict).join("\n"), exitCode };
}
