import { stableStringify } from "../render/json.js";
import type { BoundaryKind, BoundaryViolation, ScopeBoundaryReport } from "./analyze.js";
import {
  type BoundaryLedger,
  type BoundaryLedgerEntry,
  LEDGER_FILENAME,
  ledgerTargetOf,
} from "./ledger.js";
import type { CeilingBreach } from "./migrate.js";
import type { Reconciliation } from "./reconcile.js";
import { LEGACY_CEILINGS_FILENAME } from "./rules.js";

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

function entryLine(entry: BoundaryLedgerEntry): string {
  const reason = entry.reason === undefined ? "" : `  — ${entry.reason}`;
  return (
    `  ${entry.scope}  ${ruleOf(entry.kind)} ${entry.kind}  ${entry.from} -> ` +
    `${ledgerTargetOf(entry)}  ("${entry.specifier}")${reason}`
  );
}

function prunedLines(pruned: readonly BoundaryLedgerEntry[]): string[] {
  if (pruned.length === 0) return [];
  return [
    `pruned ${pruned.length} ${LEDGER_FILENAME} entr${pruned.length === 1 ? "y" : "ies"} whose crossing is gone:`,
    ...pruned.map(entryLine),
  ];
}

const FIX_LINES = [
  "  Import a feature from outside it through its index.ts, keep rules/ on contracts only, and",
  "  keep lib/ out of features. A crossing that has to stay is added by name and with a reason:",
  '  `code-graph <scope> --boundaries --accept-crossings --reason "<why>"`.',
];

export function renderLedgerGate(
  result: Reconciliation,
  json: boolean,
  pretty: boolean,
): BoundaryRender {
  const passed = result.unrecorded.length === 0;
  const exitCode = passed ? 0 : 1;
  if (json) {
    const { scopesChecked, unrecorded, pruned } = result;
    return {
      stdout: stableStringify({ passed, scopesChecked, unrecorded, pruned }, pretty),
      exitCode,
    };
  }
  const head = passed
    ? [
        `boundary ledger: PASS — ${result.scopesChecked} scope(s), ` +
          `${result.kept.entries.length} recorded crossing(s), none new.`,
      ]
    : [
        `BOUNDARY LEDGER FAILED — ${result.unrecorded.length} crossing(s) not in ${LEDGER_FILENAME}:`,
        ...result.unrecorded.map(entryLine),
        ...FIX_LINES,
      ];
  return { stdout: [...head, ...prunedLines(result.pruned)].join("\n"), exitCode };
}

export function renderAccepted(
  result: Reconciliation,
  reason: string,
  json: boolean,
  pretty: boolean,
): string {
  if (json) {
    return stableStringify({ accepted: result.unrecorded, pruned: result.pruned, reason }, pretty);
  }
  const accepted =
    result.unrecorded.length === 0
      ? ["accept-crossings: no unrecorded crossing — nothing to add."]
      : [
          `accepted ${result.unrecorded.length} crossing(s) into ${LEDGER_FILENAME}, reason "${reason}":`,
          ...result.unrecorded.map(entryLine),
        ];
  return [...accepted, ...prunedLines(result.pruned)].join("\n");
}

export function renderMigrated(
  ledger: BoundaryLedger,
  scopes: number,
  json: boolean,
  pretty: boolean,
): string {
  if (json) return stableStringify({ migrated: ledger.entries.length, scopes }, pretty);
  return (
    `migrated ${scopes} scope(s): seeded ${LEDGER_FILENAME} with ${ledger.entries.length} ` +
    `crossing(s) and removed ${LEGACY_CEILINGS_FILENAME}.`
  );
}

export function renderMigrationRefused(breaches: readonly CeilingBreach[]): string {
  const lines = breaches.map(
    (b) => `  ${b.scope}: ${b.measured} crossing(s) against a recorded ceiling of ${b.ceiling}`,
  );
  return [
    `--migrate-ceilings refused, nothing written: ${breaches.length} scope(s) cross more than ` +
      `${LEGACY_CEILINGS_FILENAME} allows, and seeding the ledger from them would loosen it.`,
    ...lines,
    "  Remove the new crossings, then migrate.",
  ].join("\n");
}
