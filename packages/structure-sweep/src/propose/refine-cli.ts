import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { DEFAULTS, underRoot } from "../cli-paths.js";
import { repoRootOf, trackedPaths } from "../git.js";
import { readChangeSets } from "../score/history.js";
import { fileListRefusal } from "../sweep/run.js";
import { loadVocabulary } from "../vocabulary.js";
import {
  DEFAULT_PATIENCE,
  DEFAULT_SAMPLE,
  DEFAULT_THRESHOLD,
  History,
  RefineRow,
  refine,
  SweptRow,
} from "./refine.js";
import { renderRefinePrompt } from "./refine-prompt.js";

export const REFINE_USAGE = `structure-sweep propose refine [options]

  One step of the refine loop: score the drafted vocabulary's assignment against git co-change,
  name what to merge and what to split, record the run, and write the sample to sweep next and a
  prompt saying whether to go on. No model call, no network.

  --config <file>       vocabulary being refined (default: ${DEFAULTS.proposedConfig})
  --verdicts <file>     sweep output to score (default: ${DEFAULTS.verdicts})
  --sweep <file>        a sweep over the sample list; its rows re-judge the verdicts' and add
                        Jev's confidence and top-2 confusion (default: none, co-change only)
  --ref <ref>           read history back from here, and list files tracked here (default: HEAD)
  --since <date>        only commits after this date (git log --since)
  --pr-only             only commits whose subject ends in (#N)
  --max-files <n>       drop commits touching more labelled files than this (default: 40)
  --threshold <x>       |ΔF1| under this counts toward a plateau (default: ${DEFAULT_THRESHOLD})
  --patience <n>        consecutive runs under the threshold that plateau (default: ${DEFAULT_PATIENCE})
  --sample <n>          files spread over the features in the sample list, on top of the orphaned
                        ones (default: ${DEFAULT_SAMPLE})
  --out <file>          report JSON (default: ${DEFAULTS.refineReport})
  --prompt <file>       prompt (default: ${DEFAULTS.refinePrompt})
  --history <file>      one entry per vocabulary, read and rewritten (default: ${DEFAULTS.refineHistory})
  --sample-list <file>  paths to sweep next, one per line (default: ${DEFAULTS.refineSample})`;

const readJson = <T>(schema: z.ZodType<T>, path: string, what: string): T => {
  if (!existsSync(path)) throw new Error(`no ${what} at ${path}`);
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
};

/** A path to print inside the prompt: repo-relative, so two checkouts write the same bytes. */
const shown = (root: string, path: string) =>
  relative(root, path).split("\\").join("/");

export function refineCommand(argv: readonly string[], cwd: string): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string", default: DEFAULTS.proposedConfig },
      verdicts: { type: "string", default: DEFAULTS.verdicts },
      sweep: { type: "string" },
      ref: { type: "string", default: "HEAD" },
      since: { type: "string" },
      "pr-only": { type: "boolean", default: false },
      "max-files": { type: "string", default: "40" },
      threshold: { type: "string", default: String(DEFAULT_THRESHOLD) },
      patience: { type: "string", default: String(DEFAULT_PATIENCE) },
      sample: { type: "string", default: String(DEFAULT_SAMPLE) },
      out: { type: "string", default: DEFAULTS.refineReport },
      prompt: { type: "string", default: DEFAULTS.refinePrompt },
      history: { type: "string", default: DEFAULTS.refineHistory },
      "sample-list": { type: "string", default: DEFAULTS.refineSample },
    },
  });
  const root = repoRootOf(cwd);
  const at = (path: string) => underRoot(root, path);
  const configPath = at(values.config);
  const historyPath = at(values.history);
  const tracked = new Set(trackedPaths(root, { ref: values.ref }));

  const run = refine({
    vocabulary: loadVocabulary(configPath),
    verdicts: readJson(
      z.array(RefineRow),
      at(values.verdicts),
      "sweep verdicts",
    ),
    ...(values.sweep === undefined
      ? {}
      : {
          swept: readJson(
            z.array(SweptRow),
            at(values.sweep),
            "sweep of the sample",
          ),
        }),
    changeSets: readChangeSets(root, {
      ref: values.ref,
      since: values.since,
      prOnly: values["pr-only"],
    }),
    maxFiles: z.coerce.number().int().min(2).parse(values["max-files"]),
    history: existsSync(historyPath)
      ? readJson(History, historyPath, "refine history")
      : [],
    threshold: z.coerce
      .number()
      .min(0, "--threshold must be at least 0")
      .parse(values.threshold),
    patience: z.coerce
      .number()
      .int()
      .min(1, "--patience must be an integer of at least 1")
      .parse(values.patience),
    sampleSize: z.coerce
      .number()
      .int()
      .min(1, "--sample must be an integer of at least 1")
      .parse(values.sample),
    sweepable: (path) =>
      fileListRefusal(path, values.ref, tracked) === undefined,
  });

  const outPath = at(values.out);
  const promptPath = at(values.prompt);
  const samplePath = at(values["sample-list"]);
  const prompt = renderRefinePrompt(run.report, {
    config: shown(root, configPath),
    report: shown(root, outPath),
    sample: shown(root, samplePath),
    sweepOut: shown(root, at(values.sweep ?? DEFAULTS.refineSweep)),
  });
  const writes: readonly (readonly [string, string])[] = [
    [outPath, `${JSON.stringify(run.report, null, 1)}\n`],
    [historyPath, `${JSON.stringify(run.history, null, 1)}\n`],
    [samplePath, run.sample.map((p) => `${p}\n`).join("")],
    [promptPath, prompt],
  ];
  for (const [path, text] of writes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  const { report } = run;
  const f1 = report.score.f1 === null ? "n/a" : report.score.f1.toFixed(4);
  console.error(
    `F1 ${f1}, ${report.merge.length} merge and ${report.split.length} split candidates, ${report.rows.stale} stale and ${report.rows.orphaned} orphaned rows, ${report.signals.basis}; plateau: ${report.plateau.state} → ${outPath}, ${promptPath}, ${samplePath}`,
  );
  console.error(
    report.plateau.state === "plateaued"
      ? "next: stop, the loop has plateaued"
      : `next: follow ${promptPath}: edit ${values.config}, sweep ${values["sample-list"]}, refine again with --sweep`,
  );
}
