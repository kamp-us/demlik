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
import { sweepQuestions } from "./questions.js";
import { runSweep } from "./run.js";

export const SWEEP_USAGE = `structure-sweep sweep <folder>... [options]

  Ask Jev which feature and which role every source file under each folder belongs to.
  Files whose content and vocabulary are unchanged since the last run are not asked again.

  --config <file>       vocabulary (default: ${DEFAULTS.config})
  --ref <ref>           git tree to read sources from (default: HEAD)
  --out <file>          verdict file, created if absent (default: ${DEFAULTS.verdicts})
  --graph <file>        code-graph --graph JSON to pass as evidence (repeatable)
  --redact              show Jev opaque ids, not paths, relative imports or sibling names
                        (default: off; redacted and plain runs never share cached answers)
  --model <id>          Jev model (default: ${DEFAULT_MODEL})
  --concurrency <n>     calls in flight (default: 6)`;

/** `sweep`'s flags and folders, defaults applied. */
export const parseSweepArgs = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: "string", default: DEFAULTS.config },
      ref: { type: "string", default: "HEAD" },
      out: { type: "string", default: DEFAULTS.verdicts },
      graph: { type: "string", multiple: true, default: [] },
      redact: { type: "boolean", default: false },
      model: { type: "string", default: DEFAULT_MODEL },
      concurrency: { type: "string", default: "6" },
    },
  });

export async function sweepCommand(
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  const { values, positionals } = parseSweepArgs(argv);
  if (positionals.length === 0)
    throw new Error(`pass one or more folders\n\n${SWEEP_USAGE}`);
  const root = repoRootOf(cwd);
  const vocabulary = loadVocabulary(underRoot(root, values.config));
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
    scopes: positionals.map((p) => scopeOf(root, cwd, p)),
    vocabulary,
    jev: httpJevClient({
      questions,
      model: values.model,
      post: fetchPost(apiKey),
    }),
    verdictsPath,
    graph,
    redact: values.redact,
    concurrency: Number(values.concurrency),
    log,
  });
  const input = result.rows.reduce((n, r) => n + r.usage.input_tokens, 0);
  const failed = result.scopes.flatMap((s) => s.failed);
  log(
    `${result.rows.length} files judged, input tokens ${input} → ${verdictsPath}`,
  );
  if (failed.length > 0) {
    log(
      `${failed.length} files failed and were not recorded; re-run to ask them again`,
    );
    process.exitCode = 1;
  }
}
