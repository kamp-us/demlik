import type { MeasuredApi } from "../view.js";
import { compareLedgerKeys, type LedgerKey, type LedgerMeasurement } from "./keyed.js";
import type { LedgerRow } from "./text.js";

export const API_LEDGER_FILENAME = "api-ledger.json";

export const API_LEDGER: LedgerRow<"subpath" | "name"> = {
  filename: API_LEDGER_FILENAME,
  keyFields: ["subpath", "name"],
  labels: { pass: "api ledger", fail: "API LEDGER", invalid: "API ledger" },
  noun: "name",
  failedTail:
    'Stop publishing each name, or record it by name: --api <map> --accept-api --reason "<why>".',
  pruned: "the name is gone",
  unmeasured:
    "the compiler reported errors or the read could not resolve a module, so this run cannot say these names were removed; the first clean run decides",
  acceptFlag: "--accept-api",
  entryLine: ({ subpath, name }) => `  ${subpath}  ${name}`,
};

export function publishedNamesOf(
  scope: string,
  { view, diagnostics }: MeasuredApi,
): LedgerMeasurement<"subpath" | "name"> {
  const measured = diagnostics === 0;
  const names = Object.entries(view.subpaths)
    .flatMap(([subpath, { names }]) =>
      Object.keys(names).map((name): LedgerKey<"subpath" | "name"> => ({ scope, subpath, name })),
    )
    .filter(({ name }) => measured || name !== "")
    .sort((a, b) => compareLedgerKeys(API_LEDGER, a, b));
  return {
    items: names.map((key) => ({ key, lines: [API_LEDGER.entryLine(key)] })),
    measured,
  };
}
