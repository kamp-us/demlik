import { stableStringify } from "../render/json.js";
import {
  type BoundaryKind,
  type BoundaryViolation,
  crossingOf,
  type ScopeBoundaryReport,
} from "./analyze.js";
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

// Each kind's rule label, and whether only a hexagonal feature layout produces it.
const KINDS = {
  "cross-feature": { rule: "B1", hexagonal: false },
  "impure-rules": { rule: "B2", hexagonal: false },
  "lib-imports-feature": { rule: "B3", hexagonal: false },
  "outside-imports-feature-internal": { rule: "B4", hexagonal: false },
  "door-outside-owner": { rule: "B5", hexagonal: false },
  "application-imports-adapter": { rule: "B6", hexagonal: true },
  "impure-application": { rule: "B7", hexagonal: true },
  "driving-reaches-driven": { rule: "B8", hexagonal: true },
  "door-outside-driven-adapter": { rule: "B9", hexagonal: true },
  "unknown-zone": { rule: "B10", hexagonal: true },
} as const satisfies Record<BoundaryKind, { rule: string; hexagonal: boolean }>;

// A door, and a feature's entry, is its own target: no import specifier was written for it.
function writtenAs(entry: Pick<BoundaryLedgerEntry, "kind" | "specifier" | "global">): string {
  return crossingOf(entry) === "import" ? `  ("${entry.specifier}")` : "";
}

function violationLine(violation: BoundaryViolation): string {
  const tag = violation.typeOnly ? "  [type-only]" : "";
  return (
    `  ${KINDS[violation.kind].rule} ${violation.kind.padEnd(19)} ${violation.from} -> ` +
    `${ledgerTargetOf(violation)}${writtenAs(violation)}${tag}`
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
    `  ${entry.scope}  ${KINDS[entry.kind].rule} ${entry.kind}  ${entry.from} -> ` +
    `${ledgerTargetOf(entry)}${writtenAs(entry)}${reason}`
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
  "  Import a feature from outside it through its index.ts, keep rules/ on contracts only and free",
  "  of world reads (any process.<member>, fetch, the clock), and keep lib/ out of features. Open a",
  '  world door only in the file its `doors` declaration names (`--boundary-rules`: { "doors":',
  '  { "<scope>": { "<door>": ["<owner file>"] } } }). A crossing that has to stay is added by name',
  '  and with a reason: `code-graph <scope> --boundaries --accept-crossings --reason "<why>"`.',
];

const HEXAGONAL_FIX_LINES = [
  "  In a hexagonal feature, keep application/ off its own adapters/ and free of every world door,",
  "  let adapters/driving/ reach the core only through ports.ts and index.ts, open a declared door",
  "  only in adapters/driven/, and keep the feature to index.ts, ports.ts, application/,",
  "  adapters/driving/ and adapters/driven/.",
];

function fixLines(unrecorded: readonly BoundaryLedgerEntry[]): readonly string[] {
  const hexagonal = unrecorded.some((entry) => KINDS[entry.kind].hexagonal);
  return hexagonal ? [...FIX_LINES, ...HEXAGONAL_FIX_LINES] : FIX_LINES;
}

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
        ...fixLines(result.unrecorded),
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
