import fs from "node:fs";
import { type BoundaryLedger, ledgerTargetOf, readBoundaryLedger } from "../boundaries/ledger.js";
import type { LibraryCensus } from "../boundaries/libraries/census.js";
import type { BoundaryViolation } from "../boundaries/violation.js";
import type { BoundaryRepo, GateRun } from "./boundary-repo.js";

export type LibraryReport = {
  readonly scopes: readonly { readonly scope: string; readonly violations: BoundaryViolation[] }[];
  readonly libraries?: LibraryCensus;
};

export function reportOf(run: GateRun): LibraryReport {
  return JSON.parse(run.stdout);
}

export const sorted = (rows: readonly (readonly string[])[]): string[][] =>
  rows.map((row) => [...row]).sort((a, b) => a.join("\0").localeCompare(b.join("\0")));

// `[kind, importer or package, target or door]` of every crossing a `--json` run lists, sorted.
export function crossingsOf(run: GateRun): string[][] {
  return sorted(
    reportOf(run)
      .scopes.flatMap((s) => s.violations)
      .map((v) => [v.kind, v.from, ledgerTargetOf(v)]),
  );
}

export function ledgerOf(repo: BoundaryRepo): BoundaryLedger {
  const read = readBoundaryLedger(repo.ledgerFile);
  if (read.kind !== "read") throw new Error(`expected a readable ledger, got ${read.kind}`);
  return read.ledger;
}

export const ledgerText = (repo: BoundaryRepo): string => fs.readFileSync(repo.ledgerFile, "utf8");

// The failing gate's entry lines: `  <scope>  B<n> <kind>  <importer> -> <target> …`.
export const entryLines = (stdout: string): string[] =>
  stdout.split("\n").filter((line) => /^ {2}\S+ {2}B\d+ /.test(line));
