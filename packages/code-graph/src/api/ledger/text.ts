import { stableStringify } from "../../render/json.js";
import { API_LEDGER_FILENAME, type ApiName, type ApiReconciliation } from "./ledger.js";

const nameLine = ({ subpath, name }: ApiName): string => `  ${subpath}  ${name}`;

function prunedLines(pruned: readonly ApiName[]): string[] {
  if (pruned.length === 0) return [];
  return [
    `pruned ${pruned.length} entr${pruned.length === 1 ? "y" : "ies"} from ${API_LEDGER_FILENAME} — the name is gone:`,
    ...pruned.map(nameLine),
  ];
}

export function renderApiLedgerCheck(
  result: ApiReconciliation,
  output: { readonly json: boolean; readonly pretty: boolean },
): string {
  const { scope, unrecorded, pruned, kept } = result;
  const passed = unrecorded.length === 0;
  if (output.json) {
    return stableStringify({ passed, scope, unrecorded, pruned }, output.pretty);
  }
  const recorded = kept.entries.filter((entry) => entry.scope === scope).length;
  const head = passed
    ? [`api ledger: PASS — scope ${scope}, ${recorded} recorded name(s), none new.`]
    : [
        `API LEDGER FAILED — ${unrecorded.length} name(s) in scope ${scope} not in ${API_LEDGER_FILENAME}:`,
        ...unrecorded.map(nameLine),
        'Stop publishing each name, or record it by name: --api <map> --accept-api --reason "<why>".',
      ];
  return [...head, ...prunedLines(pruned)].join("\n");
}

export function renderApiLedgerAccept(
  result: ApiReconciliation,
  reason: string,
  output: { readonly json: boolean; readonly pretty: boolean },
): string {
  const { scope, unrecorded, pruned } = result;
  if (output.json) {
    return stableStringify({ scope, accepted: unrecorded, pruned, reason }, output.pretty);
  }
  const accepted =
    unrecorded.length === 0
      ? ["accept-api: no unrecorded name — nothing to add."]
      : [
          `accepted ${unrecorded.length} name(s) of scope ${scope} into ${API_LEDGER_FILENAME}, reason "${reason}":`,
          ...unrecorded.map(nameLine),
        ];
  return [...accepted, ...prunedLines(pruned)].join("\n");
}
