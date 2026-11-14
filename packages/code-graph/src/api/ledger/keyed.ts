import fs from "node:fs";
import { z } from "zod";
import { byText } from "../../order.js";
import { stableStringify } from "../../render/json.js";

export type LedgerDescription<Field extends string> = {
  readonly filename: string;
  readonly keyFields: readonly Field[];
};

export type LedgerKey<Field extends string> = Readonly<Record<"scope" | Field, string>>;
type LedgerEntry<Field extends string> = LedgerKey<Field> & { readonly reason: string };
export type Ledger<Field extends string> = { readonly entries: readonly LedgerEntry<Field>[] };

export type FoundItem<Field extends string> = {
  readonly key: LedgerKey<Field>;
  readonly lines: readonly string[];
};

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

export type MissingEntries<Field extends string> = {
  readonly kind: "pruned" | "unmeasured";
  readonly entries: readonly LedgerEntry<Field>[];
};

export type LedgerReconciliation<Field extends string> = {
  readonly scope: string;
  readonly unrecorded: readonly FoundItem<Field>[];
  readonly missing: MissingEntries<Field>;
  readonly kept: Ledger<Field>;
};

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
