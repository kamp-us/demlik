import type { ApiDocGap } from "../docs/gaps.js";
import type { ApiDocsReport } from "../docs/judge.js";
import { declarationFindingLines } from "../docs/text.js";
import type { LedgerMeasurement } from "./keyed.js";
import type { LedgerRow } from "./text.js";

export const API_DOCS_LEDGER_FILENAME = "api-docs-ledger.json";

export const API_DOCS_LEDGER: LedgerRow<"block" | "file" | "name"> = {
  filename: API_DOCS_LEDGER_FILENAME,
  keyFields: ["block", "file", "name"],
  labels: { pass: "api docs ledger", fail: "API DOCS LEDGER", invalid: "API docs ledger" },
  noun: "declaration",
  failedTail:
    'Fix each doc block, or record the declaration: --api <map> --api-docs <shape> --accept-api-docs --reason "<why>".',
  pruned: "the declaration has no finding any more",
  unmeasured:
    "the read could not see everything, so this run cannot say these declarations are fixed or gone; the first run with no gap decides",
  acceptFlag: "--accept-api-docs",
  entryLine: ({ file, name }) => `  ${file}  ${name}`,
};

export function docFindingsOf(
  scope: string,
  report: ApiDocsReport,
  gaps: readonly ApiDocGap[],
): LedgerMeasurement<"block" | "file" | "name"> {
  return {
    items: report.declarations.map((declaration) => ({
      key: { scope, block: declaration.block, file: declaration.file, name: declaration.name },
      lines: declarationFindingLines(declaration).map((line) => `  ${line}`),
    })),
    measured: gaps.length === 0,
  };
}
