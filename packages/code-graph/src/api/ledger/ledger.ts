import fs from "node:fs";
import { z } from "zod";
import { stableStringify } from "../../render/json.js";
import type { PublishedApi } from "../view.js";

// `api-ledger.json` at the repo root: one entry per name a package publishes. The gate fails only
// on a name the ledger does not hold and drops the entries whose name is gone, so adding a public
// name is a change to this file, by name and with a reason. It holds names and never signatures:
// what a signature change owes is `--api-policy`'s question.
export const API_LEDGER_FILENAME = "api-ledger.json";

const EntrySchema = z
  .object({
    scope: z.string().min(1),
    subpath: z.string().min(1),
    name: z.string().min(1),
    reason: z.string().refine((reason) => reason.trim() !== "", "a reason must not be blank"),
  })
  .strict();

// `scope` is the package root relative to the repo root (`.` for the root itself): one file serves
// every package of a workspace, and two packages can each publish `parse` from `.`.
type ApiLedgerEntry = z.infer<typeof EntrySchema>;
export type ApiName = Omit<ApiLedgerEntry, "reason">;
export type ApiLedger = { readonly entries: readonly ApiLedgerEntry[] };

const nameKey = (name: ApiName): string => JSON.stringify([name.scope, name.subpath, name.name]);

const ApiLedgerSchema = z
  .object({ entries: z.array(EntrySchema) })
  .strict()
  .superRefine(({ entries }, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = nameKey(entry);
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

function compareNames(a: ApiName, b: ApiName): number {
  return (
    a.scope.localeCompare(b.scope) ||
    a.subpath.localeCompare(b.subpath) ||
    a.name.localeCompare(b.name)
  );
}

// The sorted form the file is written in.
const sorted = (entries: readonly ApiLedgerEntry[]): ApiLedger => ({
  entries: [...entries].sort(compareNames),
});

type ApiLedgerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly ledger: ApiLedger }
  | { readonly kind: "invalid"; readonly message: string };

function parseApiLedger(text: string): ApiLedgerRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", message: "not valid JSON" };
  }
  const result = ApiLedgerSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { kind: "invalid", message: `${issue?.path.join(".") || "(root)"}: ${issue?.message}` };
  }
  return { kind: "read", ledger: sorted(result.data.entries) };
}

export function readApiLedger(file: string): ApiLedgerRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", message: "unreadable" };
  }
  return parseApiLedger(text);
}

export function writeApiLedger(file: string, ledger: ApiLedger): void {
  fs.writeFileSync(file, `${stableStringify(sorted(ledger.entries), true)}\n`);
}

export function publishedNamesOf(scope: string, published: PublishedApi): ApiName[] {
  return Object.entries(published.subpaths)
    .flatMap(([subpath, { names }]) =>
      Object.keys(names).map((name): ApiName => ({ scope, subpath, name })),
    )
    .sort(compareNames);
}

// What one run found against the ledger. Only the entries of the run's scope are in reach:
// `pruned` are those whose name is no longer published, and `kept` is the ledger without them. An
// entry of another scope is kept as it is.
export type ApiReconciliation = {
  readonly scope: string;
  readonly unrecorded: readonly ApiName[];
  readonly pruned: readonly ApiLedgerEntry[];
  readonly kept: ApiLedger;
};

export function reconcileApiNames(
  ledger: ApiLedger,
  scope: string,
  published: readonly ApiName[],
): ApiReconciliation {
  const publishedKeys = new Set(published.map(nameKey));
  const recordedKeys = new Set(ledger.entries.map(nameKey));
  const gone = (entry: ApiLedgerEntry) =>
    entry.scope === scope && !publishedKeys.has(nameKey(entry));
  return {
    scope,
    unrecorded: published.filter((name) => !recordedKeys.has(nameKey(name))),
    pruned: ledger.entries.filter(gone),
    kept: sorted(ledger.entries.filter((entry) => !gone(entry))),
  };
}

export function withAcceptedNames(
  ledger: ApiLedger,
  accepted: readonly ApiName[],
  reason: string,
): ApiLedger {
  return sorted([...ledger.entries, ...accepted.map((name) => ({ ...name, reason }))]);
}
