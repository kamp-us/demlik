import { stableStringify } from "../../render/json.js";
import {
  API_LEDGER_FILENAME,
  type ApiName,
  type ApiReconciliation,
  type MissingEntries,
} from "./ledger.js";

const nameLine = ({ subpath, name }: ApiName): string => `  ${subpath}  ${name}`;

const entryCount = (count: number): string => `${count} entr${count === 1 ? "y" : "ies"}`;

function missingLines({ kind, entries }: MissingEntries): string[] {
  if (entries.length === 0) return [];
  const head =
    kind === "pruned"
      ? `pruned ${entryCount(entries.length)} from ${API_LEDGER_FILENAME} — the name is gone:`
      : `kept ${entryCount(entries.length)} in ${API_LEDGER_FILENAME} — the compiler reported errors or the read could not resolve a module, so this run cannot say these names were removed; the first clean run decides:`;
  return [head, ...entries.map(nameLine)];
}

// A clean run's JSON has `pruned` alone; `unmeasured` appears only on a run with diagnostics.
const missingFields = ({ kind, entries }: MissingEntries) =>
  kind === "pruned" ? { pruned: entries } : { pruned: [], unmeasured: entries };

export function renderApiLedgerCheck(
  result: ApiReconciliation,
  output: { readonly json: boolean; readonly pretty: boolean },
): string {
  const { scope, unrecorded, missing, kept } = result;
  const passed = unrecorded.length === 0;
  if (output.json) {
    return stableStringify({ passed, scope, unrecorded, ...missingFields(missing) }, output.pretty);
  }
  const recorded = kept.entries.filter((entry) => entry.scope === scope).length;
  const head = passed
    ? [`api ledger: PASS — scope ${scope}, ${recorded} recorded name(s), none new.`]
    : [
        `API LEDGER FAILED — ${unrecorded.length} name(s) in scope ${scope} not in ${API_LEDGER_FILENAME}:`,
        ...unrecorded.map(nameLine),
        'Stop publishing each name, or record it by name: --api <map> --accept-api --reason "<why>".',
      ];
  return [...head, ...missingLines(missing)].join("\n");
}

export function renderApiLedgerAccept(
  result: ApiReconciliation,
  reason: string,
  output: { readonly json: boolean; readonly pretty: boolean },
): string {
  const { scope, unrecorded, missing } = result;
  if (output.json) {
    return stableStringify(
      { scope, accepted: unrecorded, ...missingFields(missing), reason },
      output.pretty,
    );
  }
  const accepted =
    unrecorded.length === 0
      ? ["accept-api: no unrecorded name — nothing to add."]
      : [
          `accepted ${unrecorded.length} name(s) of scope ${scope} into ${API_LEDGER_FILENAME}, reason "${reason}":`,
          ...unrecorded.map(nameLine),
        ];
  return [...accepted, ...missingLines(missing)].join("\n");
}
