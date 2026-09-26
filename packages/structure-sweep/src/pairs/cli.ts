import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULTS, treeScopeOf, underRoot } from "../cli-paths.js";
import { repoRootOf } from "../git.js";
import {
  DEFAULT_MODEL,
  fetchPost,
  httpJevClient,
  type JevClient,
  requireApiKey,
} from "../jev.js";
import { readLoweringGraph } from "../lowering/lower.js";
import type { AnchorJev } from "./anchor.js";
import { DEFAULT_MAX_PARTNERS, maxPartners } from "./cap.js";
import { type PairQuestions, pairQuestions } from "./questions.js";
import { countVerdicts, renderMarkdown, shownCounts } from "./report.js";
import {
  type Bodies,
  type PairsJev,
  type PairsMode,
  type PairsPlan,
  type PairTarget,
  planPairs,
  runPairs,
} from "./run.js";

export const PAIRS_USAGE = `structure-sweep pairs <folder>=<collapse.json>... [options]

  Ask Jev what each code-graph collapse pair means. By default each pair is dealt to one anchor
  function, and each anchor is asked in one request, one yes/no question per candidate partner,
  whether it encodes the same business rule: a yes is same_decision, a no look_alike. An anchor
  with more candidates than one request's question cap is asked in one request per chunk.
  <collapse.json> is the output of \`code-graph <folder> --collapse --json\`.
  <folder> may be ., the whole tree: only its report holds a pair whose two functions
  sit in different top-level folders.

  --pairwise            ask once per pair instead, the three-way same_decision, look_alike or
                        shared_helper verdict plus business_rule, for gold-set evaluation
                        (default: off; anchor and pairwise answers never share cached rows)
  --plan                print the pairs, anchors, functions and estimated tokens a run in the
                        selected mode would spend, then exit: no Jev call, no TYPESAFE_API_KEY,
                        nothing written
  --max-partners <n>    judge each anchor against at most its n best partners by graph
                        confidence; the rest are reported as skipped (default: ${DEFAULT_MAX_PARTNERS})
  --graph <graph.json>  the \`code-graph <folder> --graph --json\` output for the one target: send each
                        function's stage-2 lowered body instead of its source where stage 2 lowers it
                        (default: off; lowered and raw sends never share cached answers)
  --ref <ref>           git tree the collapse report was taken from (default: HEAD)
  --out <file>          judged pairs (default: ${DEFAULTS.pairs})
  --report <file>       markdown summary (default: ${DEFAULTS.pairsReport})
  --redact              show Jev each function's name and source, not its file path
                        (default: off; redacted and plain runs never share cached answers)
  --model <id>          Jev model (default: ${DEFAULT_MODEL})
  --concurrency <n>     calls in flight (default: 6)`;

/** One `<folder>=<collapse.json>` argument; `.` (or any folder resolving to the root) is the whole tree. */
export function parsePairsTarget(
  root: string,
  cwd: string,
  arg: string,
): PairTarget {
  const at = arg.indexOf("=");
  if (at <= 0) throw new Error(`expected <folder>=<collapse.json>, got ${arg}`);
  return {
    scope: treeScopeOf(root, cwd, arg.slice(0, at)),
    collapsePath: underRoot(cwd, arg.slice(at + 1)),
  };
}

/** `pairs`' flags and targets, defaults applied. */
export const parsePairsArgs = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      pairwise: { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      "max-partners": { type: "string", default: String(DEFAULT_MAX_PARTNERS) },
      graph: { type: "string" },
      ref: { type: "string", default: "HEAD" },
      out: { type: "string", default: DEFAULTS.pairs },
      report: { type: "string", default: DEFAULTS.pairsReport },
      redact: { type: "boolean", default: false },
      model: { type: "string", default: DEFAULT_MODEL },
      concurrency: { type: "string", default: "6" },
    },
  });

/** The line a `--graph` run adds: how many functions sent went out lowered. */
const bodiesLine = ({ lowered, sides }: Bodies) =>
  `${lowered} of ${sides} functions sent as their stage-2 lowered body, the rest as source`;

/** `--plan`'s answer: one line per scope, then the total. */
export function renderPlan(
  plan: PairsPlan,
  cap: number,
  lowering: boolean,
): string[] {
  return [
    ...plan.scopes.map(
      (s) =>
        `${s.scope}: ${s.candidates} candidate pairs over ${s.functions} functions, ${s.anchors} anchors, ${s.skipped} skipped over --max-partners ${cap}, ${s.toAsk} Jev calls to make, ~${s.tokens} input tokens`,
    ),
    ...(lowering ? [bodiesLine(plan.bodies)] : []),
    `plan (${plan.mode} mode): ${plan.candidates} candidate pairs, ${plan.anchors} anchors, ${plan.functions} functions, ${plan.skipped} skipped, ${plan.toAsk} Jev calls to make, ~${plan.tokens} input tokens (request JSON at 4 characters per token); no Jev call made`,
  ];
}

/** The client factories a run builds its one client from, per mode. */
export interface PairsJevs {
  readonly anchor: (model: string) => AnchorJev;
  readonly pairwise: (model: string) => JevClient<PairQuestions>;
}

/** The Jev clients a real run asks through; reading `TYPESAFE_API_KEY` happens here and nowhere earlier. */
const httpPairsJevs: PairsJevs = {
  anchor: (model) => {
    const post = fetchPost(requireApiKey());
    return (questions, state) =>
      httpJevClient({ questions, model, post })(state);
  },
  pairwise: (model) =>
    httpJevClient({
      questions: pairQuestions,
      model,
      post: fetchPost(requireApiKey()),
    }),
};

const clientFor = (
  mode: PairsMode,
  jevs: PairsJevs,
  model: string,
): PairsJev =>
  mode === "pairwise"
    ? { mode, ask: jevs.pairwise(model) }
    : { mode, ask: jevs.anchor(model) };

/** `jevs` builds the client for the mode and `--model`; `--plan` returns before either is called. */
export async function pairsCommand(
  argv: readonly string[],
  cwd: string,
  jevs: PairsJevs = httpPairsJevs,
): Promise<void> {
  const { values, positionals } = parsePairsArgs(argv);
  if (positionals.length === 0)
    throw new Error(`pass <folder>=<collapse.json>\n\n${PAIRS_USAGE}`);
  const root = repoRootOf(cwd);
  const targets = positionals.map((p) => parsePairsTarget(root, cwd, p));
  if (values.graph !== undefined && targets.length !== 1)
    throw new Error(
      `--graph names one code-graph run's functions, so it takes exactly one <folder>=<collapse.json>, not ${targets.length}`,
    );
  const cap = maxPartners(Number(values["max-partners"]));
  const mode: PairsMode = values.pairwise ? "pairwise" : "anchor";
  const graph =
    values.graph === undefined
      ? undefined
      : readLoweringGraph(underRoot(cwd, values.graph));
  const outPath = underRoot(root, values.out);
  const log = (line: string) => console.error(line);
  const selection = {
    root,
    ref: values.ref,
    targets,
    outPath,
    redact: values.redact,
    maxPartners: cap,
    ...(graph === undefined ? {} : { graph }),
    log,
  };

  if (values.plan) {
    const plan = planPairs({ ...selection, mode, model: values.model });
    for (const line of renderPlan(plan, cap, graph !== undefined))
      console.log(line);
    return;
  }

  const jev = clientFor(mode, jevs, values.model);
  const reportPath = underRoot(root, values.report);
  const { rows, spent, skipped, bodies } = await runPairs({
    ...selection,
    jev,
    concurrency: Number(values.concurrency),
  });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, renderMarkdown(rows, skipped));
  for (const { scope } of targets) {
    log(
      `${scope} ${JSON.stringify(Object.fromEntries(shownCounts(countVerdicts(rows.filter((r) => r.scope === scope)))))}`,
    );
  }
  log(
    `${skipped.length} pairs skipped over --max-partners ${cap}${skipped.length === 0 ? "" : `, listed in ${reportPath}`}`,
  );
  if (graph !== undefined) log(bodiesLine(bodies));
  log(
    `${rows.length} pairs judged, this run input ${spent.input} output ${spent.output} tokens → ${outPath}, ${reportPath}`,
  );
}
