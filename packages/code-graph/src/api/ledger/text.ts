import { stableStringify } from "../../render/json.js";
import type {
  LedgerDescription,
  LedgerKey,
  LedgerReconciliation,
  MissingEntries,
} from "./keyed.js";

// One ledger's row: its file, and the words its gate prints.
export type LedgerRow<Field extends string> = LedgerDescription<Field> & {
  readonly labels: { readonly pass: string; readonly fail: string; readonly invalid: string };
  readonly noun: string;
  readonly failedTail: string;
  readonly pruned: string;
  readonly unmeasured: string;
  readonly acceptFlag: string;
  readonly entryLine: (key: LedgerKey<Field>) => string;
};

const entryCount = (count: number): string => `${count} entr${count === 1 ? "y" : "ies"}`;

function missingLines<Field extends string>(
  row: LedgerRow<Field>,
  { kind, entries }: MissingEntries<Field>,
): string[] {
  if (entries.length === 0) return [];
  const head =
    kind === "pruned"
      ? `pruned ${entryCount(entries.length)} from ${row.filename} — ${row.pruned}:`
      : `kept ${entryCount(entries.length)} in ${row.filename} — ${row.unmeasured}:`;
  return [head, ...entries.map(row.entryLine)];
}

// A measured run's JSON has `pruned` alone; `unmeasured` appears only on a run that could not
// measure everything.
const missingFields = <Field extends string>({ kind, entries }: MissingEntries<Field>) =>
  kind === "pruned" ? { pruned: entries } : { pruned: [], unmeasured: entries };

export function renderApiLedgerCheck<Field extends string>(
  row: LedgerRow<Field>,
  result: LedgerReconciliation<Field>,
  output: { readonly json: boolean; readonly pretty: boolean },
): string {
  const { scope, unrecorded, missing, kept } = result;
  const passed = unrecorded.length === 0;
  if (output.json) {
    return stableStringify(
      { passed, scope, unrecorded: unrecorded.map(({ key }) => key), ...missingFields(missing) },
      output.pretty,
    );
  }
  const recorded = kept.entries.filter((entry) => entry.scope === scope).length;
  const head = passed
    ? [`${row.labels.pass}: PASS — scope ${scope}, ${recorded} recorded ${row.noun}(s), none new.`]
    : [
        `${row.labels.fail} FAILED — ${unrecorded.length} ${row.noun}(s) in scope ${scope} not in ${row.filename}:`,
        ...unrecorded.flatMap(({ lines }) => lines),
        row.failedTail,
      ];
  return [...head, ...missingLines(row, missing)].join("\n");
}

export function renderApiLedgerAccept<Field extends string>(
  row: LedgerRow<Field>,
  result: LedgerReconciliation<Field>,
  reason: string,
  output: { readonly json: boolean; readonly pretty: boolean },
): string {
  const { scope, unrecorded, missing } = result;
  if (output.json) {
    return stableStringify(
      { scope, accepted: unrecorded.map(({ key }) => key), ...missingFields(missing), reason },
      output.pretty,
    );
  }
  const accepted =
    unrecorded.length === 0
      ? [`${row.acceptFlag.slice(2)}: no unrecorded ${row.noun} — nothing to add.`]
      : [
          `accepted ${unrecorded.length} ${row.noun}(s) of scope ${scope} into ${row.filename}, reason "${reason}":`,
          ...unrecorded.map(({ key }) => row.entryLine(key)),
        ];
  return [...accepted, ...missingLines(row, missing)].join("\n");
}
