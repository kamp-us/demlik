import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULTS, scopeOf, underRoot } from "../cli-paths.js";
import { repoRootOf } from "../git.js";
import {
  DEFAULT_MODEL,
  fetchPost,
  httpJevClient,
  requireApiKey,
} from "../jev.js";
import { pairQuestions } from "./questions.js";
import { countVerdicts, renderMarkdown } from "./report.js";
import { type PairTarget, runPairs } from "./run.js";

export const PAIRS_USAGE = `structure-sweep pairs <folder>=<collapse.json>... [options]

  Ask Jev what each code-graph collapse pair means: same_decision, look_alike or shared_helper.
  <collapse.json> is the output of \`code-graph <folder> --collapse --json\`.

  --ref <ref>           git tree the collapse report was taken from (default: HEAD)
  --out <file>          judged pairs (default: ${DEFAULTS.pairs})
  --report <file>       markdown summary (default: ${DEFAULTS.pairsReport})
  --model <id>          Jev model (default: ${DEFAULT_MODEL})
  --concurrency <n>     calls in flight (default: 6)`;

function parseTarget(root: string, cwd: string, arg: string): PairTarget {
  const at = arg.indexOf("=");
  if (at <= 0) throw new Error(`expected <folder>=<collapse.json>, got ${arg}`);
  return {
    scope: scopeOf(root, cwd, arg.slice(0, at)),
    collapsePath: underRoot(cwd, arg.slice(at + 1)),
  };
}

export async function pairsCommand(
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      ref: { type: "string", default: "HEAD" },
      out: { type: "string", default: DEFAULTS.pairs },
      report: { type: "string", default: DEFAULTS.pairsReport },
      model: { type: "string", default: DEFAULT_MODEL },
      concurrency: { type: "string", default: "6" },
    },
  });
  if (positionals.length === 0)
    throw new Error(`pass <folder>=<collapse.json>\n\n${PAIRS_USAGE}`);
  const root = repoRootOf(cwd);
  const targets = positionals.map((p) => parseTarget(root, cwd, p));
  const apiKey = requireApiKey();
  const outPath = underRoot(root, values.out);
  const reportPath = underRoot(root, values.report);
  const log = (line: string) => console.error(line);

  const { rows, spent } = await runPairs({
    root,
    ref: values.ref,
    targets,
    jev: httpJevClient({
      questions: pairQuestions,
      model: values.model,
      post: fetchPost(apiKey),
    }),
    outPath,
    concurrency: Number(values.concurrency),
    log,
  });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, renderMarkdown(rows));
  for (const { scope } of targets) {
    log(
      `${scope} ${JSON.stringify(countVerdicts(rows.filter((r) => r.scope === scope)))}`,
    );
  }
  log(
    `${rows.length} pairs judged, this run input ${spent.input} output ${spent.output} tokens → ${outPath}, ${reportPath}`,
  );
}
