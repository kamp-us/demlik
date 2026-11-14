import fs from "node:fs";
import { z } from "zod";
import { byText } from "../../order.js";
import { stableStringify } from "../../render/json.js";

// One ledger file at the repo root: the entries a gate holds for a package, each keyed by its scope
// and the file's own fields and carrying a reason. The gate fails only on what the file does not
// hold and drops the entries a run no longer finds, so the file changes by key and with a reason.
// An entry is never dropped on a run that could not measure everything, which cannot tell a thing
// that is gone from one it could not read.
export type LedgerDescription<Field extends string> = {
  readonly filename: string;
  // The key's fields after `scope`, in the order the entries are sorted by.
  readonly keyFields: readonly Field[];
};

// `scope` is the package root relative to the repo root (`.` for the root itself): one file serves
// every package of a workspace, and two packages can each hold the same key.
export type LedgerKey<Field extends string> = Readonly<Record<"scope" | Field, string>>;
type LedgerEntry<Field extends string> = LedgerKey<Field> & { readonly reason: string };
export type Ledger<Field extends string> = { readonly entries: readonly LedgerEntry<Field>[] };

// One thing a run found that the ledger must hold, and the lines a failed gate prints for it.
export type FoundItem<Field extends string> = {
  readonly key: LedgerKey<Field>;
  readonly lines: readonly string[];
};

// What one run found, and whether it saw enough to say that a thing it did not find is gone.
export type LedgerMeasurement<Field extends string> = {
  readonly items: readonly FoundItem<Field>[];
  readonly measured: boolean;
};

const keyOf = <Field extends string>(
  description: LedgerDescription<Field>,
  key: LedgerKey<Field>,
): string => JSON.stringify([key.scope, ...description.keyFields.map((field) => key[field])]);

export function compareLedgerKeys<Field extends string>(
  description: LedgerDescription<Field>,
  a: LedgerKey<Field>,
  b: LedgerKey<Field>,
): number {
  for (const field of ["scope" as const, ...description.keyFields]) {
    const compared = byText(a[field], b[field]);
    if (compared !== 0) return compared;
  }
  return 0;
}

const sorted = <Field extends string>(
  description: LedgerDescription<Field>,
  entries: readonly LedgerEntry<Field>[],
): Ledger<Field> => ({
  entries: [...entries].sort((a, b) => compareLedgerKeys(description, a, b)),
});

function ledgerSchema<Field extends string>(description: LedgerDescription<Field>) {
  const fields = Object.fromEntries(
    description.keyFields.map((field) => [field, z.string().min(1)] as const),
  );
  const entry = z
    .object({
      scope: z.string().min(1),
      ...fields,
      reason: z.string().refine((reason) => reason.trim() !== "", "a reason must not be blank"),
    })
    .strict();
  return z
    .object({ entries: z.array(entry) })
    .strict()
    .superRefine(({ entries }, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const key = keyOf(description, entry as LedgerKey<Field>);
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
}

type LedgerRead<Field extends string> =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly ledger: Ledger<Field> }
  | { readonly kind: "invalid"; readonly message: string };

function parseLedger<Field extends string>(
  description: LedgerDescription<Field>,
  text: string,
): LedgerRead<Field> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", message: "not valid JSON" };
  }
  const result = ledgerSchema(description).safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { kind: "invalid", message: `${issue?.path.join(".") || "(root)"}: ${issue?.message}` };
  }
  return { kind: "read", ledger: sorted(description, result.data.entries as LedgerEntry<Field>[]) };
}

export function readLedger<Field extends string>(
  description: LedgerDescription<Field>,
  file: string,
): LedgerRead<Field> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", message: "unreadable" };
  }
  return parseLedger(description, text);
}

export function writeLedger<Field extends string>(
  description: LedgerDescription<Field>,
  file: string,
  ledger: Ledger<Field>,
): void {
  fs.writeFileSync(file, `${stableStringify(sorted(description, ledger.entries), true)}\n`);
}

// The run's scope's entries the run did not find. They are `pruned` on a measured run, and
// `unmeasured` on any other: those stay in the ledger until a measured run decides.
export type MissingEntries<Field extends string> = {
  readonly kind: "pruned" | "unmeasured";
  readonly entries: readonly LedgerEntry<Field>[];
};

// What one run found against the ledger. Only the entries of the run's scope are in reach: `kept`
// is the ledger without the entries it pruned, and an entry of another scope is kept as it is.
export type LedgerReconciliation<Field extends string> = {
  readonly scope: string;
  readonly unrecorded: readonly FoundItem<Field>[];
  readonly missing: MissingEntries<Field>;
  readonly kept: Ledger<Field>;
};

// One item per key, in the order first found: two things found under one key are one entry.
function foldItems<Field extends string>(
  description: LedgerDescription<Field>,
  items: readonly FoundItem<Field>[],
): ReadonlyMap<string, FoundItem<Field>> {
  const folded = new Map<string, FoundItem<Field>>();
  for (const item of items) {
    const key = keyOf(description, item.key);
    const previous = folded.get(key);
    folded.set(key, { key: item.key, lines: [...(previous?.lines ?? []), ...item.lines] });
  }
  return folded;
}

export function reconcileLedger<Field extends string>(
  description: LedgerDescription<Field>,
  ledger: Ledger<Field>,
  scope: string,
  found: LedgerMeasurement<Field>,
): LedgerReconciliation<Field> {
  const items = foldItems(description, found.items);
  const recorded = new Set(ledger.entries.map((entry) => keyOf(description, entry)));
  const gone = (entry: LedgerEntry<Field>) =>
    entry.scope === scope && !items.has(keyOf(description, entry));
  const unrecorded = [...items].filter(([key]) => !recorded.has(key)).map(([, item]) => item);
  const entries = ledger.entries.filter(gone);
  return found.measured
    ? {
        scope,
        unrecorded,
        missing: { kind: "pruned", entries },
        kept: sorted(
          description,
          ledger.entries.filter((entry) => !gone(entry)),
        ),
      }
    : { scope, unrecorded, missing: { kind: "unmeasured", entries }, kept: ledger };
}

// Whether the run has anything to write besides what it accepts.
export const prunesEntries = <Field extends string>({
  missing,
}: LedgerReconciliation<Field>): boolean => missing.kind === "pruned" && missing.entries.length > 0;

export function withAcceptedEntries<Field extends string>(
  description: LedgerDescription<Field>,
  ledger: Ledger<Field>,
  accepted: readonly FoundItem<Field>[],
  reason: string,
): Ledger<Field> {
  return sorted(description, [
    ...ledger.entries,
    ...accepted.map(({ key }) => ({ ...key, reason })),
  ]);
}
