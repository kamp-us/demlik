import { stableStringify } from "../render/json.js";
import type { ScopeBoundaryReport } from "./analyze.js";
import { type DeployableCensus, deployableCensusLines } from "./deployables/census.js";
import {
  type BoundaryLedger,
  type BoundaryLedgerEntry,
  LEDGER_FILENAME,
  ledgerKey,
  ledgerTargetOf,
} from "./ledger.js";
import { censusLines, type LibraryCensus } from "./libraries/census.js";
import type { CeilingBreach } from "./migrate.js";
import type { Reconciliation } from "./reconcile.js";
import { LEGACY_CEILINGS_FILENAME } from "./rules.js";
import {
  type BoundaryKind,
  type BoundaryViolation,
  crossingOf,
  type WriteSite,
} from "./violation.js";

export type BoundaryRender = { readonly stdout: string; readonly exitCode: number };

// Which fix advice a kind's failure adds: `feature` is always printed, and the hexagonal, library,
// deployable and shape blocks only when a kind that needs them fails.
type Advice = "feature" | "hexagonal" | "library" | "deployable" | "shape";

// Each kind's rule label, and the advice it adds.
const KINDS = {
  "cross-feature": { rule: "B1", advice: "feature" },
  "impure-rules": { rule: "B2", advice: "feature" },
  "lib-imports-feature": { rule: "B3", advice: "feature" },
  "outside-imports-feature-internal": { rule: "B4", advice: "feature" },
  "door-outside-owner": { rule: "B5", advice: "feature" },
  "application-imports-adapter": { rule: "B6", advice: "hexagonal" },
  "impure-application": { rule: "B7", advice: "hexagonal" },
  "driving-reaches-driven": { rule: "B8", advice: "hexagonal" },
  "door-outside-driven-adapter": { rule: "B9", advice: "hexagonal" },
  "unknown-zone": { rule: "B10", advice: "hexagonal" },
  "library-undeclared": { rule: "B11", advice: "library" },
  "library-imports-up": { rule: "B12", advice: "library" },
  "impure-library": { rule: "B13", advice: "library" },
  "adapter-library-imported-outside-driven": { rule: "B14", advice: "library" },
  "index-not-exports-only": { rule: "B15", advice: "shape" },
  "application-import-outside-allowlist": { rule: "B16", advice: "shape" },
  "binding-outside-driven-adapter": { rule: "B17", advice: "deployable" },
  "worker-call-cycle": { rule: "B18", advice: "deployable" },
  "relative-import-crosses-workspace": { rule: "B19", advice: "deployable" },
} as const satisfies Record<BoundaryKind, { rule: string; advice: Advice }>;

// A door, a binding and an entry are their own target: no import specifier was written for them.
function writtenAs(entry: Pick<BoundaryLedgerEntry, "kind" | "specifier" | "global">): string {
  return crossingOf(entry) === "import" ? `  ("${entry.specifier}")` : "";
}

// The data write that voids a read allowance: the one thing a B8 row says that its ledger entry
// does not.
function writeNote(write: WriteSite | undefined): string {
  return write === undefined ? "" : `  [write: ${write.binding} at ${write.file}:${write.line}]`;
}

function violationLine(violation: BoundaryViolation): string {
  const tag = violation.typeOnly ? "  [type-only]" : "";
  const write = violation.kind === "driving-reaches-driven" ? violation.write : undefined;
  return (
    `  ${KINDS[violation.kind].rule} ${violation.kind.padEnd(19)} ${violation.from} -> ` +
    `${ledgerTargetOf(violation)}${writtenAs(violation)}${tag}${writeNote(write)}`
  );
}

// A scope that declares features lists them; one without is a library scope: a declared library,
// or a library root holding the packages no library names.
function scopeHeader(report: ScopeBoundaryReport): string {
  return report.features.length === 0
    ? `${report.scope} — library scope`
    : `${report.scope} — features: ${report.features.join(", ")}`;
}

// The worker call graph is read from the deploy configs, not from files: it lists its workers.
function scopeLines(report: ScopeBoundaryReport): string[] {
  const { workers, violations } = report;
  return [
    ...(workers === undefined
      ? [
          scopeHeader(report),
          `  scanned ${report.filesScanned} files — ${violations.length} violation(s)`,
        ]
      : [
          `${report.scope} — worker call graph`,
          `  ${workers.length} worker(s) — ${violations.length} violation(s)`,
        ]),
    ...violations.map(violationLine),
  ];
}

// What a run says about the keys it was given, beside its violations: a census per key family,
// each null when the rules file declares none of that family's keys, and then it says nothing.
export type Censuses = {
  readonly libraries: LibraryCensus | null;
  readonly deployables: DeployableCensus | null;
};

function censusJson(censuses: Censuses): Record<string, unknown> {
  const { libraries, deployables } = censuses;
  return {
    ...(libraries === null ? {} : { libraries }),
    ...(deployables === null ? {} : { deployables }),
  };
}

export function renderBoundaries(
  reports: readonly ScopeBoundaryReport[],
  under: string,
  censuses: Censuses,
  json: boolean,
  pretty: boolean,
): string {
  if (json) return stableStringify({ scopes: reports, ...censusJson(censuses) }, pretty);
  if (reports.length === 0) {
    const declared = censuses.libraries === null ? "feature scope" : "feature or library scope";
    return `boundaries: no ${declared} declared at or under "${under}" — nothing to check.`;
  }
  return [
    ...reports.flatMap(scopeLines),
    ...(censuses.libraries === null ? [] : censusLines(censuses.libraries)),
    ...(censuses.deployables === null ? [] : deployableCensusLines(censuses.deployables)),
  ].join("\n");
}

function entryLine(entry: BoundaryLedgerEntry, write?: WriteSite): string {
  const reason = entry.reason === undefined ? "" : `  — ${entry.reason}`;
  return (
    `  ${entry.scope}  ${KINDS[entry.kind].rule} ${entry.kind}  ${entry.from} -> ` +
    `${ledgerTargetOf(entry)}${writtenAs(entry)}${writeNote(write)}${reason}`
  );
}

// The unrecorded entries a run lists, each with the write its report row named, if any.
function unrecordedLines(result: Reconciliation): string[] {
  return result.unrecorded.map((entry) => entryLine(entry, result.writes.get(ledgerKey(entry))));
}

function prunedLines(pruned: readonly BoundaryLedgerEntry[]): string[] {
  if (pruned.length === 0) return [];
  return [
    `pruned ${pruned.length} ${LEDGER_FILENAME} entr${pruned.length === 1 ? "y" : "ies"} whose crossing is gone:`,
    ...pruned.map((entry) => entryLine(entry)),
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

const LIBRARY_FIX_LINES = [
  "  Declare every package under a library root in `libraries`, import only the library types a",
  "  type's `imports` lists, keep a pure library free of world doors and `worldLibraries`, and",
  "  import a library that names `importedFrom` only from those zones.",
];

const SHAPE_FIX_LINES = [
  "  Keep an entry file (a library's src/index.ts, a feature's index.ts) to named re-exports, and an",
  "  application/ file to its own ports.ts and application/, another feature's index.ts, lib, a",
  "  library whose type `applicationMayImport` lists and a `pureDependencies` package.",
];

const DEPLOYABLE_FIX_LINES = [
  "  Use a worker binding only in a feature's adapters/driven/ or in its worker's wrangler main",
  "  (`bindingOwners` narrows one to exact driven files), break a loop of workers that bind each",
  "  other, and reach another workspace by its package name, never a relative path.",
];

// What each advice adds to the lines every failure prints, in the order they print.
const ADVICE_LINES = {
  feature: [],
  hexagonal: HEXAGONAL_FIX_LINES,
  library: LIBRARY_FIX_LINES,
  deployable: DEPLOYABLE_FIX_LINES,
  shape: SHAPE_FIX_LINES,
} as const satisfies Record<Advice, readonly string[]>;

function fixLines(unrecorded: readonly BoundaryLedgerEntry[]): readonly string[] {
  const needed = new Set(unrecorded.map((entry) => KINDS[entry.kind].advice));
  const added = (Object.keys(ADVICE_LINES) as Advice[]).filter((advice) => needed.has(advice));
  return [...FIX_LINES, ...added.flatMap((advice) => ADVICE_LINES[advice])];
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
        ...unrecordedLines(result),
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
          ...unrecordedLines(result),
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
