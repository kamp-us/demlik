import { stableStringify } from "../render/json.js";
import {
  UNREACHABLE_LEDGER_FILENAME,
  type UnreachableFinding,
  type UnreachableLedgerEntry,
  type UnreachableReconciliation,
} from "./ledger.js";

export type UnreachableRender = { readonly stdout: string; readonly exitCode: number };

const findingLine = (finding: UnreachableFinding): string => `  ${finding.kind}  ${finding.id}`;

function prunedLines(pruned: readonly UnreachableLedgerEntry[]): string[] {
  if (pruned.length === 0) return [];
  return [
    `pruned ${pruned.length} entr${pruned.length === 1 ? "y" : "ies"} from ${UNREACHABLE_LEDGER_FILENAME} — the finding is gone:`,
    ...pruned.map(findingLine),
  ];
}

export function renderUnreachableGate(
  result: UnreachableReconciliation,
  json: boolean,
  pretty: boolean,
): UnreachableRender {
  const passed = result.unrecorded.length === 0;
  const exitCode = passed ? 0 : 1;
  if (json) {
    const { scope, gated, unrecorded, pruned } = result;
    return {
      stdout: stableStringify({ passed, scope, gated, unrecorded, pruned }, pretty),
      exitCode,
    };
  }
  const recorded = result.kept.entries.filter((entry) => entry.scope === result.scope).length;
  const head = passed
    ? [
        `unreachable ledger: PASS — scope ${result.scope}, ${recorded} recorded finding(s), none new.`,
      ]
    : [
        `UNREACHABLE LEDGER FAILED — ${result.unrecorded.length} finding(s) in scope ${result.scope} not in ${UNREACHABLE_LEDGER_FILENAME}:`,
        ...result.unrecorded.map(findingLine),
        "Delete or use each export (drop the `export` keyword of an unused-export), or record it by name: " +
          '--unreachable --accept-dead --reason "<why>".',
      ];
  return { stdout: [...head, ...prunedLines(result.pruned)].join("\n"), exitCode };
}

export function renderAcceptedDead(
  result: UnreachableReconciliation,
  reason: string,
  json: boolean,
  pretty: boolean,
): string {
  if (json) {
    const { scope, unrecorded, pruned } = result;
    return stableStringify({ scope, accepted: unrecorded, pruned, reason }, pretty);
  }
  const accepted =
    result.unrecorded.length === 0
      ? ["accept-dead: no unrecorded finding — nothing to add."]
      : [
          `accepted ${result.unrecorded.length} finding(s) of scope ${result.scope} into ${UNREACHABLE_LEDGER_FILENAME}, reason "${reason}":`,
          ...result.unrecorded.map(findingLine),
        ];
  return [...accepted, ...prunedLines(result.pruned)].join("\n");
}
