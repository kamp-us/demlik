import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { DEFAULTS, underRoot } from "../cli-paths.js";
import { repoRootOf } from "../git.js";
import { readChangeSets } from "./history.js";
import {
  type ConfidenceShare,
  type Metric,
  type Prf,
  type ScoreReport,
  ScoreRow,
  scoreCoChange,
} from "./score.js";

export const SCORE_USAGE = `structure-sweep score [options]

  Grade the sweep's file-to-feature assignment against git history: files in one feature should
  change together. Prints a table and writes the JSON report. No Jev call, no network.

  --verdicts <file>     sweep output (default: ${DEFAULTS.verdicts})
  --ref <ref>           read history back from here (default: HEAD)
  --since <date>        only commits after this date (git log --since)
  --pr-only             only commits whose subject ends in (#N)
  --max-files <n>       drop commits touching more labelled files than this (default: 40)
  --out <file>          JSON report (default: ${DEFAULTS.score})`;

const pct = (m: Metric) => (m === null ? "n/a" : (m * 100).toFixed(1));

const line = (label: string, s: Prf, c?: ConfidenceShare) =>
  [
    label,
    pct(s.precision),
    pct(s.recall),
    pct(s.f1),
    c ? `${pct(c.share)} (${c.confident}/${c.rows})` : "",
  ].join("\t");

/** The report as a tab-separated table, percentages to one decimal. */
export function renderScoreTable(report: ScoreReport): string {
  return [
    `${report.changeSets} change sets, ${report.files} files, confidence floor ${report.floor}`,
    ["", "precision", "recall", "f1", "confident"].join("\t"),
    line("overall", report, report.confidence),
    line("leaf folders", report.baseline),
    ...report.features.map((f) => line(f.feature, f, f.confidence)),
  ].join("\n");
}

export function scoreCommand(argv: readonly string[], cwd: string): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      verdicts: { type: "string", default: DEFAULTS.verdicts },
      ref: { type: "string", default: "HEAD" },
      since: { type: "string" },
      "pr-only": { type: "boolean", default: false },
      "max-files": { type: "string", default: "40" },
      out: { type: "string", default: DEFAULTS.score },
    },
  });
  const root = repoRootOf(cwd);
  const verdictsPath = underRoot(root, values.verdicts);
  if (!existsSync(verdictsPath))
    throw new Error(`no sweep verdicts at ${verdictsPath}`);
  const report = scoreCoChange(
    z.array(ScoreRow).parse(JSON.parse(readFileSync(verdictsPath, "utf8"))),
    readChangeSets(root, {
      ref: values.ref,
      since: values.since,
      prOnly: values["pr-only"],
    }),
    { maxFiles: z.coerce.number().int().min(2).parse(values["max-files"]) },
  );
  const outPath = underRoot(root, values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`);
  console.log(renderScoreTable(report));
  console.error(`→ ${outPath}`);
}
