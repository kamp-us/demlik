import { stableStringify } from "../render/json.js";
import {
  SMELL_LEDGER_FILENAME,
  type SmellChange,
  type SmellFinding,
  type SmellLedgerEntry,
  type SmellReconciliation,
} from "./ledger.js";

export type SmellLedgerRender = { readonly stdout: string; readonly exitCode: number };

const findingLine = (finding: SmellFinding): string =>
  `  ${finding.rule}  ${finding.target}  ${finding.value}`;

const changeLine = (change: SmellChange): string =>
  `  ${change.rule}  ${change.target}  recorded ${change.recorded}, measured ${change.measured}`;

const entries = (count: number): string => `${count} entr${count === 1 ? "y" : "ies"}`;

function section<T>(items: readonly T[], head: string, line: (item: T) => string): string[] {
  return items.length === 0 ? [] : [head, ...items.map(line)];
}

// The lines every run prints for what it wrote back: entries lowered to a smaller measure and
// entries pruned because their smell is gone.
function writtenBackLines(result: SmellReconciliation): string[] {
  return [
    ...section(
      result.lowered,
      `lowered ${entries(result.lowered.length)} in ${SMELL_LEDGER_FILENAME} — the smell shrank:`,
      changeLine,
    ),
    ...section(
      result.pruned,
      `pruned ${entries(result.pruned.length)} from ${SMELL_LEDGER_FILENAME} — the smell is gone:`,
      (entry: SmellLedgerEntry) => findingLine(entry),
    ),
  ];
}

export function renderSmellLedgerGate(
  result: SmellReconciliation,
  json: boolean,
  pretty: boolean,
): SmellLedgerRender {
  const passed = result.unrecorded.length === 0 && result.worsened.length === 0;
  const exitCode = passed ? 0 : 1;
  if (json) {
    const { scope, gated, unrecorded, worsened, lowered, pruned } = result;
    return {
      stdout: stableStringify(
        { passed, scope, gated, unrecorded, worsened, lowered, pruned },
        pretty,
      ),
      exitCode,
    };
  }
  const gated = result.gated.join(", ");
  const head = passed
    ? [
        `smell ledger: PASS — scope ${result.scope}, gated ${gated}, ${result.kept.entries.length} recorded smell(s), none new or worse.`,
      ]
    : [
        `SMELL LEDGER FAILED — scope ${result.scope}, gated ${gated}:`,
        ...section(
          result.unrecorded,
          `${result.unrecorded.length} smell(s) not in ${SMELL_LEDGER_FILENAME}:`,
          findingLine,
        ),
        ...section(
          result.worsened,
          `${result.worsened.length} recorded smell(s) worse than recorded:`,
          changeLine,
        ),
        'Shrink each one, or record it by name: --accept-smells --reason "<why>".',
      ];
  return { stdout: [...head, ...writtenBackLines(result)].join("\n"), exitCode };
}

export function renderAcceptedSmells(
  result: SmellReconciliation,
  reason: string,
  json: boolean,
  pretty: boolean,
): string {
  if (json) {
    const { scope, gated, unrecorded, worsened, lowered, pruned } = result;
    return stableStringify(
      { scope, gated, accepted: unrecorded, raised: worsened, lowered, pruned, reason },
      pretty,
    );
  }
  const changed = result.unrecorded.length + result.worsened.length;
  const accepted =
    changed === 0
      ? ["accept-smells: no unrecorded or worsened smell — nothing to add."]
      : [
          ...section(
            result.unrecorded,
            `accepted ${result.unrecorded.length} smell(s) of scope ${result.scope} into ${SMELL_LEDGER_FILENAME}, reason "${reason}":`,
            findingLine,
          ),
          ...section(
            result.worsened,
            `raised ${entries(result.worsened.length)} to the measured value, reason "${reason}":`,
            changeLine,
          ),
        ];
  return [...accepted, ...writtenBackLines(result)].join("\n");
}
