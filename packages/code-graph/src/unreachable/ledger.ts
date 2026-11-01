import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { stableStringify } from "../render/json.js";
import {
  type ReachabilityReport,
  UNUSED_EXPORT,
  type UnreachableFindingKind,
  UnreachableFindingKindSchema,
} from "../schema.js";

// `unreachable-ledger.json` at the repo root: one entry per unreachable or unused export a scope
// still carries. The gate fails only on a finding the ledger does not name, and drops the entries
// whose finding is gone, so the file only shrinks unless someone adds to it by name and with a
// reason.
export const UNREACHABLE_LEDGER_FILENAME = "unreachable-ledger.json";

const EntrySchema = z
  .object({
    scope: z.string().min(1),
    kind: UnreachableFindingKindSchema,
    id: z.string().min(1),
    reason: z.string().refine((reason) => reason.trim() !== "", "a reason must not be blank"),
  })
  .strict();

// `scope` is the analyzed path relative to the repo root (`.` for the root itself), `kind` the
// finding's category and `id` its scope-relative function id, such as `src/shell/execute.ts:inWords`.
export type UnreachableLedgerEntry = z.infer<typeof EntrySchema>;
export type UnreachableFinding = Omit<UnreachableLedgerEntry, "reason">;
export type UnreachableLedger = { readonly entries: readonly UnreachableLedgerEntry[] };

export function findingKey(finding: UnreachableFinding): string {
  return JSON.stringify([finding.scope, finding.kind, finding.id]);
}

const UnreachableLedgerSchema = z
  .object({ entries: z.array(EntrySchema) })
  .strict()
  .superRefine(({ entries }, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = findingKey(entry);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate entry ${key}`,
          path: ["entries", index],
        });
      }
      seen.add(key);
    });
  });

function compareFindings(a: UnreachableFinding, b: UnreachableFinding): number {
  return a.scope.localeCompare(b.scope) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}

// Sorted, one entry per key; on a collision the entry already held wins, so a merge keeps the
// reason someone wrote first.
export function unreachableLedgerOf(entries: readonly UnreachableLedgerEntry[]): UnreachableLedger {
  const byKey = new Map<string, UnreachableLedgerEntry>();
  for (const entry of entries) {
    const key = findingKey(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return { entries: [...byKey.values()].sort(compareFindings) };
}

export type UnreachableLedgerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly ledger: UnreachableLedger }
  | { readonly kind: "invalid"; readonly message: string };

export function parseUnreachableLedger(text: string): UnreachableLedgerRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", message: "not valid JSON" };
  }
  const result = UnreachableLedgerSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { kind: "invalid", message: `${issue?.path.join(".") || "(root)"}: ${issue?.message}` };
  }
  return { kind: "read", ledger: unreachableLedgerOf(result.data.entries) };
}

export function readUnreachableLedger(file: string): UnreachableLedgerRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", message: "unreadable" };
  }
  return parseUnreachableLedger(text);
}

export function serializeUnreachableLedger(ledger: UnreachableLedger): string {
  return `${stableStringify(unreachableLedgerOf(ledger.entries), true)}\n`;
}

export function writeUnreachableLedger(file: string, ledger: UnreachableLedger): void {
  fs.writeFileSync(file, serializeUnreachableLedger(ledger));
}

export function findingsOf(
  scope: string,
  report: Pick<ReachabilityReport, "unreachable" | "unusedExports">,
): UnreachableFinding[] {
  return [
    ...report.unreachable.map(
      (symbol): UnreachableFinding => ({
        scope,
        kind: symbol.category,
        id: symbol.id,
      }),
    ),
    ...report.unusedExports.map(
      (symbol): UnreachableFinding => ({
        scope,
        kind: UNUSED_EXPORT,
        id: symbol.id,
      }),
    ),
  ].sort(compareFindings);
}

// What a finding names, whichever scope measured it: `packages/core` with `src/x.ts:f` and `.` with
// `packages/core/src/x.ts:f` are one symbol.
function repoSymbol(finding: UnreachableFinding): string {
  return path.posix.join(finding.scope, finding.id);
}

// How much use of a symbol each kind says a run saw: nothing, a name in a test, a production path.
const USE_SEEN: Readonly<Record<UnreachableFindingKind, number>> = {
  dead: 0,
  "only-called-from-tests": 1,
  [UNUSED_EXPORT]: 2,
};

// Whether an entry records a finding of the same symbol. The same kind always does, and within one
// scope nothing else does. Across two scopes a wider run sees all a narrower run sees and more, so it
// can only measure more use: `packages/a` measures `dead` where the root, seeing a test in `packages/b`,
// measures `only-called-from-tests`, and `only-called-from-tests` where the root, seeing a path from
// `packages/b`, measures `unused-export`. A wider run measuring less use is a code change and does not
// count. Two scopes naming one symbol both hold its file, so one sits inside the other.
function covers(entry: UnreachableLedgerEntry, finding: UnreachableFinding): boolean {
  if (entry.kind === finding.kind) return true;
  if (entry.scope === finding.scope) return false;
  const entryIsNarrower = finding.scope === "." || entry.scope.startsWith(`${finding.scope}/`);
  const [narrower, wider] = entryIsNarrower ? [entry, finding] : [finding, entry];
  return USE_SEEN[narrower.kind] < USE_SEEN[wider.kind];
}

function entriesBySymbol(
  entries: readonly UnreachableLedgerEntry[],
): ReadonlyMap<string, readonly UnreachableLedgerEntry[]> {
  const bySymbol = new Map<string, UnreachableLedgerEntry[]>();
  for (const entry of entries) {
    const symbol = repoSymbol(entry);
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), entry]);
  }
  return bySymbol;
}

// What one run found against the ledger. A finding is recorded when an entry naming its symbol
// `covers` it. Only the entries of the analyzed scope and of a gated kind can be pruned: `pruned` are
// those whose finding is gone, and `kept` is the ledger without them. An entry of another scope is
// kept as it is, since that run's callers are not this run's and so this run cannot say its finding
// is gone.
export type UnreachableReconciliation = {
  readonly scope: string;
  readonly gated: readonly UnreachableFindingKind[];
  // How many of this run's gated findings an entry names.
  readonly recorded: number;
  readonly unrecorded: readonly UnreachableFinding[];
  readonly pruned: readonly UnreachableLedgerEntry[];
  readonly kept: UnreachableLedger;
};

export function reconcileUnreachable(
  ledger: UnreachableLedger,
  scope: string,
  findings: readonly UnreachableFinding[],
  gated: readonly UnreachableFindingKind[],
): UnreachableReconciliation {
  const isGated = (finding: UnreachableFinding) => gated.includes(finding.kind);
  const measured = findings.filter(isGated);
  const measuredKeys = new Set(measured.map(findingKey));
  const bySymbol = entriesBySymbol(ledger.entries);
  const gone = (entry: UnreachableLedgerEntry) =>
    entry.scope === scope && isGated(entry) && !measuredKeys.has(findingKey(entry));
  const unrecorded = measured.filter(
    (finding) => !bySymbol.get(repoSymbol(finding))?.some((entry) => covers(entry, finding)),
  );
  return {
    scope,
    gated,
    recorded: measured.length - unrecorded.length,
    unrecorded,
    pruned: ledger.entries.filter(gone),
    kept: unreachableLedgerOf(ledger.entries.filter((entry) => !gone(entry))),
  };
}

export function withAcceptedFindings(
  ledger: UnreachableLedger,
  accepted: readonly UnreachableFinding[],
  reason: string,
): UnreachableLedger {
  return unreachableLedgerOf([
    ...ledger.entries,
    ...accepted.map((finding) => ({ ...finding, reason })),
  ]);
}
