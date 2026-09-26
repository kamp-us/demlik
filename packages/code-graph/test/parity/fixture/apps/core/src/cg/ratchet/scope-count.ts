import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Reporter } from "../config.js";

export const ScopeCountCeilingsSchema = z
  .object({
    default: z.number().int().nonnegative().default(0),
    scopes: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .strict();

export type ScopeCountCeilings = z.infer<typeof ScopeCountCeilingsSchema>;

export type ScopeCount = { readonly scope: string; readonly count: number };

export type CeilingDirection = "EXCEEDED" | "SLACK";

export type ScopeCountViolation = {
  scope: string;
  measured: number;
  ceiling: number;
  direction: CeilingDirection;
  delta: number;
};

export type ScopeCountVerdict = {
  passed: boolean;
  scopesChecked: number;
  violations: ScopeCountViolation[];
};

export function scopeOf(repoRoot: string, absolute: string): string {
  const rel = path.relative(repoRoot, absolute).split(path.sep).join("/");
  return rel === "" ? "." : rel;
}

export function scopesUnder(scopes: readonly string[], under: string): string[] {
  const prefix = under === "." ? "" : `${under}/`;
  return scopes
    .filter((scope) => under === "." || scope === under || scope.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b));
}

export function evaluateScopeRatchet(
  measurements: readonly ScopeCount[],
  ceilings: ScopeCountCeilings,
): ScopeCountVerdict {
  const violations: ScopeCountViolation[] = [];
  for (const { scope, count } of measurements) {
    const ceiling = ceilings.scopes[scope] ?? ceilings.default;
    const delta = count - ceiling;
    if (delta === 0) continue;
    violations.push({
      scope,
      measured: count,
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

export function recordScopeCeilings(
  measurements: readonly ScopeCount[],
  ceilings: ScopeCountCeilings,
): ScopeCountCeilings {
  const scopes = { ...ceilings.scopes };
  for (const { scope, count } of measurements) scopes[scope] = count;
  return { default: ceilings.default, scopes };
}

export function readScopeCeilings(file: string, report: Reporter): ScopeCountCeilings | null {
  const defaults = ScopeCountCeilingsSchema.parse({});
  if (!fs.existsSync(file)) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    report(`ceilings file "${file}" is not valid JSON.`);
    return null;
  }
  const result = ScopeCountCeilingsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    report(
      `invalid ceilings in "${file}": ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
    );
    return null;
  }
  return result.data;
}

function violationLine(violation: ScopeCountViolation): string {
  const sign = violation.delta > 0 ? "+" : "";
  return (
    `  ${violation.scope.padEnd(46)}${String(violation.measured).padStart(8)}` +
    `${String(violation.ceiling).padStart(9)}  ${violation.direction.padEnd(9)}` +
    `${`${sign}${violation.delta}`.padStart(7)}`
  );
}

export function ratchetTableLines(verdict: ScopeCountVerdict, title: string): string[] {
  return [
    `${title} RATCHET FAILED — ${verdict.violations.length} of ${verdict.scopesChecked} scope(s) off their ceiling.`,
    `  ${"scope".padEnd(46)}${"measured".padStart(8)}${"ceiling".padStart(9)}  ${"direction".padEnd(9)}${"delta".padStart(7)}`,
    ...verdict.violations.map(violationLine),
  ];
}

export function hasDirection(verdict: ScopeCountVerdict, direction: CeilingDirection): boolean {
  return verdict.violations.some((v) => v.direction === direction);
}
