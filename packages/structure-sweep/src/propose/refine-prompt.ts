import type { ConfidenceShare, Metric } from "../score/score.js";
import { MIN_SPLIT_FILES, type RefineReport } from "./refine.js";

/** How many merge, split and confusion rows the prompt names; the report holds them all. */
export const PROMPT_TOP = 5;
/** How many stale or orphaned paths the prompt lists before pointing at the report. */
export const PROMPT_FILES = 40;

/** Repo-relative paths the prompt names, so two checkouts render the same bytes. */
export interface RefinePaths {
  readonly config: string;
  readonly report: string;
  readonly sample: string;
  /** Where the prompt tells the agent to write the sweep over the sample. */
  readonly sweepOut: string;
}

const f1 = (m: Metric) => (m === null ? "n/a" : m.toFixed(4));
const pct = (m: Metric) => (m === null ? "n/a" : `${(m * 100).toFixed(1)}%`);
const signed = (m: Metric) =>
  m === null ? "n/a" : `${m >= 0 ? "+" : "-"}${Math.abs(m).toFixed(4)}`;
const confident = (c: ConfidenceShare) =>
  `${pct(c.share)} (${c.confident}/${c.rows})`;

function fileList(label: string, files: readonly string[], report: string) {
  if (files.length === 0) return [`${label}: none.`];
  const shown = files.slice(0, PROMPT_FILES).map((p) => `- \`${p}\``);
  const rest = files.length - shown.length;
  return [
    `${label} (${files.length}):`,
    "",
    ...shown,
    ...(rest > 0 ? [`- … ${rest} more, listed in \`${report}\``] : []),
  ];
}

function scoreSection(report: RefineReport): string[] {
  const { plateau, score, rows } = report;
  const delta =
    plateau.state === "first-run"
      ? "first run, no delta"
      : `delta ${signed(plateau.delta)} against the previous run's ${f1(plateau.previousF1)}`;
  return [
    "## Score",
    "",
    `Overall co-change F1 ${f1(score.f1)} (${delta}); precision ${f1(score.precision)}, recall ${f1(score.recall)}; leaf-folder baseline F1 ${f1(score.baseline.f1)}.`,
    `Confident share ${confident(score.confidence)} at floor ${score.floor}.`,
    `${rows.scored} of ${rows.total} rows scored over ${score.changeSets} change sets; ${rows.stale} stale, ${rows.orphaned} orphaned.`,
    "",
    "| feature | files | f1 | precision | recall | confident |",
    "|---|---|---|---|---|---|",
    ...report.features.map(
      (f) =>
        `| ${f.feature} | ${f.files} | ${f1(f.f1)} | ${f1(f.precision)} | ${f1(f.recall)} | ${confident(f.confidence)} |`,
    ),
  ];
}

function candidates(report: RefineReport): string[] {
  const merge = report.merge.slice(0, PROMPT_TOP);
  const split = report.split.slice(0, PROMPT_TOP);
  return [
    "## Merge candidates",
    "",
    "Feature pairs whose files change together. Coupling is the share of co-changed pairs touching either feature that cross between the two.",
    "",
    ...(merge.length === 0
      ? ["None: no commit changed files of two features together."]
      : merge.map(
          (m) =>
            `- \`${m.features[0]}\` + \`${m.features[1]}\`: coupling ${f1(m.coupling)}, ${m.crossPairs} crossing of ${m.touchingPairs} co-changed pairs`,
        )),
    "",
    "## Split candidates",
    "",
    `Features whose files do not change together. Cohesion is the share of same-scope file pairs inside the feature that some commit changed together; features under ${MIN_SPLIT_FILES} files are left out.`,
    "",
    ...(split.length === 0
      ? [
          `None: no feature of ${MIN_SPLIT_FILES} or more files has co-change to judge.`,
        ]
      : split.map(
          (s) =>
            `- \`${s.feature}\`: cohesion ${f1(s.cohesion)} over ${s.files} files, f1 ${f1(s.f1)}`,
        )),
  ];
}

function jevSection(report: RefineReport): string[] {
  const { signals } = report;
  if (signals.basis === "co-change")
    return [
      "## Jev signals",
      "",
      "None: no `--sweep` file was given, so these diagnostics are co-change only. Jev's confidence per feature and its top-2 confusion come in once the sample below is swept and passed back.",
    ];
  const { jev } = signals;
  const confusion = jev.confusion.slice(0, PROMPT_TOP);
  return [
    "## Jev signals",
    "",
    `From ${jev.rows} swept rows judged under this vocabulary.`,
    "",
    "Top-2 confusion, the pairs Jev most often ranked first and second:",
    "",
    ...(confusion.length === 0
      ? ["- none"]
      : confusion.map(
          (c) =>
            `- \`${c.features[0]}\` / \`${c.features[1]}\`: ${c.rows} rows`,
        )),
    "",
    "Confident share per feature in the sweep:",
    "",
    ...jev.features.map(
      (f) => `- \`${f.feature}\`: ${confident(f.confidence)}`,
    ),
  ];
}

function nextStep(report: RefineReport, paths: RefinePaths): string[] {
  const { plateau } = report;
  if (plateau.state === "plateaued")
    return [
      "## Next",
      "",
      `Stop. The loop has plateaued: overall F1 moved less than ${plateau.threshold} for ${plateau.streak} consecutive runs (patience ${plateau.patience}). Keep \`${paths.config}\` as it is.`,
    ];
  return [
    "## Next",
    "",
    `1. Edit \`${paths.config}\`: merge the features the evidence above says change together, split the ones whose files do not, and sharpen the descriptions of the pairs Jev confuses. Leave a feature alone when the evidence for it is thin.`,
    `2. Sweep the sample: \`structure-sweep sweep --files ${paths.sample} --config ${paths.config} --out ${paths.sweepOut}\`.`,
    `3. Refine again: \`structure-sweep propose refine --config ${paths.config} --sweep ${paths.sweepOut}\`.`,
    "",
    `The loop stops once overall F1 moves less than ${plateau.threshold} for ${plateau.patience} consecutive runs.`,
  ];
}

/** The refine prompt: where the vocabulary stands, what to change, and whether to go on. */
export function renderRefinePrompt(
  report: RefineReport,
  paths: RefinePaths,
): string {
  return `${[
    "# Refine the feature vocabulary",
    "",
    `Vocabulary \`${paths.config}\`, fingerprint \`${report.vocabulary}\`. Full diagnostics: \`${paths.report}\`.`,
    "",
    ...scoreSection(report),
    "",
    ...candidates(report),
    "",
    ...jevSection(report),
    "",
    "## Stale and orphaned files",
    "",
    "Stale rows were judged under another vocabulary and still count toward the score; orphaned rows name a feature the vocabulary no longer has and do not.",
    "",
    ...fileList("Orphaned", report.orphanedFiles, paths.report),
    "",
    ...fileList("Stale", report.staleFiles, paths.report),
    "",
    `The sample list \`${paths.sample}\` holds ${report.sample.files} files: every orphaned one, then up to ${report.sample.perFeature} per feature, stale ones first.`,
    "",
    ...nextStep(report, paths),
  ].join("\n")}\n`;
}
