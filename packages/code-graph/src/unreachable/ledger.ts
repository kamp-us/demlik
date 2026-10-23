import fs from "node:fs";
import { z } from "zod";
import { stableStringify } from "../render/json.js";
import {
  type UnreachableCategory,
  UnreachableCategorySchema,
  type UnreachableSymbol,
} from "../schema.js";

// `unreachable-ledger.json` at the repo root: one entry per unreachable export a scope still
// carries. The gate fails only on a finding the ledger does not name, and drops the entries whose
// finding is gone, so the file only shrinks unless someone adds to it by name and with a reason.
export const UNREACHABLE_LEDGER_FILENAME = "unreachable-ledger.json";

const EntrySchema = z
  .object({
    scope: z.string().min(1),
    kind: UnreachableCategorySchema,
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
  unreachable: readonly UnreachableSymbol[],
): UnreachableFinding[] {
  return unreachable
    .map((symbol) => ({ scope, kind: symbol.category, id: symbol.id }))
    .sort(compareFindings);
}

// What one run found against the ledger. Only the entries of the analyzed scope and of a gated
// kind are in reach: `pruned` are those whose finding is gone, and `kept` is the ledger without
// them. An entry of another scope, or of a kind the run does not gate, is kept as it is.
export type UnreachableReconciliation = {
  readonly scope: string;
  readonly gated: readonly UnreachableCategory[];
  readonly unrecorded: readonly UnreachableFinding[];
  readonly pruned: readonly UnreachableLedgerEntry[];
  readonly kept: UnreachableLedger;
};

export function reconcileUnreachable(
  ledger: UnreachableLedger,
  scope: string,
  findings: readonly UnreachableFinding[],
  gated: readonly UnreachableCategory[],
): UnreachableReconciliation {
  const isGated = (finding: UnreachableFinding) => gated.includes(finding.kind);
  const measured = findings.filter(isGated);
  const measuredKeys = new Set(measured.map(findingKey));
  const recordedKeys = new Set(ledger.entries.map(findingKey));
  const gone = (entry: UnreachableLedgerEntry) =>
    entry.scope === scope && isGated(entry) && !measuredKeys.has(findingKey(entry));
  return {
    scope,
    gated,
    unrecorded: measured.filter((finding) => !recordedKeys.has(findingKey(finding))),
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
