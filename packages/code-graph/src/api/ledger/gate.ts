import path from "node:path";
import { findRepoRoot } from "../../extract/project.js";
import { scopeOf } from "../../ratchet/scope-count.js";
import { ApiInputError } from "../map.js";
import { readMeasuredApi } from "../view.js";
import {
  API_LEDGER_FILENAME,
  type ApiLedger,
  prunesEntries,
  publishedNamesOf,
  readApiLedger,
  reconcileApiNames,
  withAcceptedNames,
  writeApiLedger,
} from "./ledger.js";
import { renderApiLedgerAccept, renderApiLedgerCheck } from "./text.js";

export type ApiLedgerMode =
  | { readonly kind: "check" }
  | { readonly kind: "accept"; readonly reason: string };

export type ApiLedgerRun = {
  readonly rootAbsolute: string;
  readonly map: unknown;
  readonly mode: ApiLedgerMode;
  readonly json: boolean;
  readonly pretty: boolean;
};

export type ApiLedgerOutcome = { readonly payload: string; readonly code: number };

function readLedgerOrRefuse(file: string): ApiLedger {
  const read = readApiLedger(file);
  if (read.kind === "invalid") {
    throw new ApiInputError(`invalid API ledger "${file}": ${read.message}; nothing was written.`);
  }
  return read.kind === "read" ? read.ledger : { entries: [] };
}

// The ledger is read before the emit, so a run that cannot gate never measures or writes. Its only
// input besides the file is the view, which needs no git.
export async function runApiLedger(run: ApiLedgerRun): Promise<ApiLedgerOutcome> {
  const repoRoot = findRepoRoot(run.rootAbsolute);
  const file = path.join(repoRoot, API_LEDGER_FILENAME);
  const ledger = readLedgerOrRefuse(file);
  const scope = scopeOf(repoRoot, run.rootAbsolute);
  const published = await readMeasuredApi(run.rootAbsolute, run.map, { repoRoot });
  const result = reconcileApiNames(ledger, scope, publishedNamesOf(scope, published));
  const { mode } = run;
  if (mode.kind === "accept") {
    if (prunesEntries(result) || result.unrecorded.length > 0) {
      writeApiLedger(file, withAcceptedNames(result.kept, result.unrecorded, mode.reason));
    }
    return { payload: `${renderApiLedgerAccept(result, mode.reason, run)}\n`, code: 0 };
  }
  if (prunesEntries(result)) writeApiLedger(file, result.kept);
  return {
    payload: `${renderApiLedgerCheck(result, run)}\n`,
    code: result.unrecorded.length === 0 ? 0 : 1,
  };
}
