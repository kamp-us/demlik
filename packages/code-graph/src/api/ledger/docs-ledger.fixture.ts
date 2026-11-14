import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import {
  DOCS_MAP,
  DOCS_REPORT,
  DOCS_SHAPE,
  type DocsRun,
  runDocsCli,
} from "../docs/docs-package.fixture.js";
import { API_DOCS_LEDGER_FILENAME } from "./docs.js";

// The doc gate (SPEC §13.11) over the doc report's fixture package: 48 published declarations, 18
// of them with a finding, 22 finding lines.
export const FINDING_LINES: readonly string[] = DOCS_REPORT.trimEnd().split("\n").slice(0, -1);
export const WITH_A_FINDING = 18;

export const FAILED_TAIL =
  'Fix each doc block, or record the declaration: --api <map> --api-docs <shape> --accept-api-docs --reason "<why>".';

export const IN_SHAPE = (what: string): string =>
  `/**\n * ${what}\n *\n * @stability stable\n * @category constructors\n */\n`;

export type DocsEntry = {
  scope: string;
  block: string;
  file: string;
  name: string;
  reason: string;
};

export type GateArgs = { readonly shape?: string; readonly env?: Readonly<Record<string, string>> };

// The two gate runs on the package at `root`, with the fixture's map and shape unless `shape`
// names another.
export const gateArgs = (root: string, shape = DOCS_SHAPE): string[] => [
  root,
  "--api",
  DOCS_MAP,
  "--api-docs",
  shape,
];
export const check = (root: string, extra: readonly string[] = [], args: GateArgs = {}): DocsRun =>
  runDocsCli([...gateArgs(root, args.shape), "--ci", ...extra], args.env);
export const accept = (
  root: string,
  reason: string,
  extra: readonly string[] = [],
  args: GateArgs = {},
): DocsRun =>
  runDocsCli(
    [...gateArgs(root, args.shape), "--accept-api-docs", "--reason", reason, ...extra],
    args.env,
  );

export const ledgerFile = (top: string): string => path.join(top, API_DOCS_LEDGER_FILENAME);
export const ledgerText = (top: string): string => fs.readFileSync(ledgerFile(top), "utf8");
export const entries = (top: string): DocsEntry[] => JSON.parse(ledgerText(top)).entries;
export const keysOf = (list: readonly DocsEntry[]): string[] =>
  list.map(({ file, name }) => `${file}  ${name}`);

export function replaceIn(root: string, relative: string, from: string, to: string): void {
  const file = path.join(root, relative);
  const text = fs.readFileSync(file, "utf8");
  expect(text).toContain(from);
  fs.writeFileSync(file, text.replace(from, to));
}

export const append = (root: string, relative: string, text: string): void => {
  fs.appendFileSync(path.join(root, relative), text);
};

// The 1-based line `needle` starts on.
export function lineOf(root: string, relative: string, needle: string): number {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  const at = text.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  return text.slice(0, at).split("\n").length;
}
