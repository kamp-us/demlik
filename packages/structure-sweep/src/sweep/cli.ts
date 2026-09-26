import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULTS, scopeOf, underRoot } from "../cli-paths.js";
import { repoRootOf } from "../git.js";
import {
  DEFAULT_MODEL,
  fetchPost,
  httpJevClient,
  requireApiKey,
} from "../jev.js";
import { loadVocabulary } from "../vocabulary.js";
import { loadGraphFacts } from "./graph.js";
import { graphNominator } from "./nominate.js";
import { sweepQuestions } from "./questions.js";
import { runSweep, type SweepResult, type SweepSelection } from "./run.js";

export const SWEEP_USAGE = `structure-sweep sweep <folder>... [options]
structure-sweep sweep --files <path> [options]

  Ask Jev which feature and which role every source file under each folder belongs to.
  Files whose content and vocabulary are unchanged since the last run are not asked again.

  --files <path>        judge only the repo-relative paths listed one per line in <path>
                        (- reads stdin), each over its parent folder's evidence;
                        cannot be combined with folders
  --config <file>       vocabulary (default: ${DEFAULTS.config})
  --ref <ref>           git tree to read sources from (default: HEAD)
  --out <file>          verdict file, created if absent (default: ${DEFAULTS.verdicts})
  --graph <file>        code-graph --graph JSON to pass as evidence (repeatable)
  --redact              show Jev opaque ids, not paths, relative imports or sibling names
                        (default: off; redacted and plain runs never share cached answers)
  --nominated           ask only about files whose import-graph pull disagrees with the
                        feature folder they sit in now, and report the calls skipped
                        (default: off; the graph is read from the checkout, not --ref)
  --model <id>          Jev model (default: ${DEFAULT_MODEL})
  --concurrency <n>     calls in flight (default: 6)`;

/** `sweep`'s flags and folders, defaults applied. */
export const parseSweepArgs = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      files: { type: "string" },
      config: { type: "string", default: DEFAULTS.config },
      ref: { type: "string", default: "HEAD" },
      out: { type: "string", default: DEFAULTS.verdicts },
      graph: { type: "string", multiple: true, default: [] },
      redact: { type: "boolean", default: false },
      nominated: { type: "boolean", default: false },
      model: { type: "string", default: DEFAULT_MODEL },
      concurrency: { type: "string", default: "6" },
    },
  });

/** A `--files` list: one path per line, blank lines skipped, a repeated path kept once. */
export const parseFileList = (text: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim() !== ""),
  ),
];

/**
 * What the run judges: `--files` or the positional folders, exactly one of them. `--files -`
 * reads the list from `stdin`; any other value is a file resolved from `cwd`.
 */
export function sweepSelection(
  files: string | undefined,
  folders: readonly string[],
  where: { readonly root: string; readonly cwd: string },
  stdin: () => string = () => readFileSync(0, "utf8"),
): SweepSelection {
  if (files !== undefined && folders.length > 0) {
    throw new Error(
      `--files ${files} and folders ${folders.join(", ")} both choose what to judge; pass one\n\n${SWEEP_USAGE}`,
    );
  }
  if (files === undefined) {
    if (folders.length === 0) {
      throw new Error(
        `pass one or more folders, or --files <path>\n\n${SWEEP_USAGE}`,
      );
    }
    return { scopes: folders.map((f) => scopeOf(where.root, where.cwd, f)) };
  }
  const text =
    files === "-" ? stdin() : readFileSync(underRoot(where.cwd, files), "utf8");
  return { files: parseFileList(text) };
}

/**
 * The run's closing line. A nominated run — one whose scopes carry `skipped` — adds how many Jev
 * calls nomination saved; a default run's line is unchanged.
 */
export function summaryLine(result: SweepResult, verdictsPath: string): string {
  const input = result.rows.reduce((n, r) => n + r.usage.input_tokens, 0);
  const line = `${result.rows.length} files judged, input tokens ${input} → ${verdictsPath}`;
  const skipped = result.scopes.flatMap((s) =>
    s.skipped === undefined ? [] : [s.skipped],
  );
  if (skipped.length === 0) return line;
  const total = skipped.reduce((n, s) => n + s, 0);
  return `${line}; ${total} Jev calls skipped (not nominated)`;
}

export async function sweepCommand(
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  const { values, positionals } = parseSweepArgs(argv);
  const root = repoRootOf(cwd);
  const selection = sweepSelection(values.files, positionals, { root, cwd });
  const vocabularyPath = underRoot(root, values.config);
  const vocabulary = loadVocabulary(vocabularyPath);
  const apiKey = requireApiKey();
  const questions = sweepQuestions(vocabulary);
  const verdictsPath = underRoot(root, values.out);
  const graph = loadGraphFacts(
    root,
    values.graph.map((g) => underRoot(cwd, g)),
  );
  const log = (line: string) => console.error(line);
  if (graph.size > 0) log(`graph facts for ${graph.size} files`);

  const result = await runSweep({
    root,
    ref: values.ref,
    ...selection,
    vocabulary,
    vocabularyPath,
    jev: httpJevClient({
      questions,
      model: values.model,
      post: fetchPost(apiKey),
    }),
    verdictsPath,
    graph,
    redact: values.redact,
    ...(values.nominated
      ? { nominate: graphNominator(root, vocabulary, selection) }
      : {}),
    concurrency: Number(values.concurrency),
    log,
  });
  const failed = result.scopes.flatMap((s) => s.failed);
  log(summaryLine(result, verdictsPath));
  if (failed.length > 0) {
    log(
      `${failed.length} files failed and were not recorded; re-run to ask them again`,
    );
    process.exitCode = 1;
  }
}
