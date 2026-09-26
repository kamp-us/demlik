#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_NEIGHBOURS, findDuplicateGroups } from "./duplicates.js";
import { fetchClosedIssues, fetchOpenIssues } from "./github.js";
import {
  DEFAULT_MODEL,
  fetchPost,
  httpJevClient,
  requireApiKey,
} from "./jev.js";
import { git, resolveRepo, snapshotRepo } from "./repo.js";
import { runBacklogSweep } from "./run.js";
import { PROPOSAL_KINDS, pairQuestions, questions } from "./verdict.js";

const DEFAULT_OUT = ".backlog-sweep/verdicts.json";
const DEFAULT_DUPLICATES_OUT = ".backlog-sweep/duplicates.json";
const DEFAULT_EXCLUDED = ["type:epic", "status:awaiting-release"];

const USAGE = `backlog-sweep [options]

  Gather evidence for every open issue of a GitHub repository and ask Jev whether each is still
  needed. Writes one proposal per issue — keep, verify, close, close_duplicate or review. It closes
  nothing; closing anything is a human's call.

  --repo <owner/name>     repository to sweep (default: this checkout's origin remote)
  --ref <ref>             tree the evidence is read from (default: origin/main)
  --out <file>            verdict file (default: ${DEFAULT_OUT})
  --exclude-label <name>  skip issues with this label (repeatable; default: ${DEFAULT_EXCLUDED.join(", ")})
  --sample <n>            judge a seeded random sample of n issues
  --seed <n>              seed for --sample (default: 4498)
  --model <id>            Jev model (default: ${DEFAULT_MODEL})
  --concurrency <n>       calls in flight (default: 6)

backlog-sweep duplicates [options]

  Group open issues that are the same concrete defect: each issue's nearest open neighbours by
  TF-IDF become candidate pairs, Jev judges each pair, and a confident duplicate joins two issues.
  It closes nothing and labels nothing.

  --repo <owner/name>     repository to read (default: this checkout's origin remote)
  --out <file>            duplicate groups (default: ${DEFAULT_DUPLICATES_OUT})
  --exclude-label <name>  skip issues with this label (repeatable; default: ${DEFAULT_EXCLUDED.join(", ")})
  --neighbours <n>        nearest open issues paired with each issue (default: ${DEFAULT_NEIGHBOURS})
  --model <id>            Jev model (default: ${DEFAULT_MODEL})
  --concurrency <n>       calls in flight (default: 6)`;

const log = (line: string) => console.error(line);

function outPathOf(root: string, out: string): string {
  return isAbsolute(out) ? out : resolve(root, out);
}

async function sweep(argv: readonly string[], cwd: string): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      ref: { type: "string", default: "origin/main" },
      out: { type: "string", default: DEFAULT_OUT },
      "exclude-label": { type: "string", multiple: true },
      sample: { type: "string" },
      seed: { type: "string", default: "4498" },
      model: { type: "string", default: DEFAULT_MODEL },
      concurrency: { type: "string", default: "6" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    return;
  }
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const repo = resolveRepo(values.repo, cwd);
  const [owner = "", name = ""] = repo.split("/");
  const outPath = outPathOf(root, values.out);
  const apiKey = requireApiKey();

  log(`snapshotting ${values.ref}…`);
  const snapshot = snapshotRepo(root, values.ref);
  log(`fetching open and closed issues of ${repo}…`);
  const rows = await runBacklogSweep({
    snapshot,
    open: fetchOpenIssues(owner, name),
    closed: fetchClosedIssues(repo),
    jev: httpJevClient({
      questions,
      model: values.model,
      post: fetchPost(apiKey),
    }),
    outPath,
    excludeLabels: values["exclude-label"] ?? DEFAULT_EXCLUDED,
    ...(values.sample === undefined
      ? {}
      : { sample: { size: Number(values.sample), seed: Number(values.seed) } }),
    concurrency: Number(values.concurrency),
    log,
  });

  const tally = new Map(PROPOSAL_KINDS.map((kind) => [kind, 0]));
  for (const r of rows)
    tally.set(r.proposal.kind, (tally.get(r.proposal.kind) ?? 0) + 1);
  const input = rows.reduce((n, r) => n + r.usage.input_tokens, 0);
  log(
    `${JSON.stringify(Object.fromEntries(tally))} input tokens ${input} → ${outPath}`,
  );
}

async function duplicates(argv: readonly string[], cwd: string): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      out: { type: "string", default: DEFAULT_DUPLICATES_OUT },
      "exclude-label": { type: "string", multiple: true },
      neighbours: { type: "string", default: String(DEFAULT_NEIGHBOURS) },
      model: { type: "string", default: DEFAULT_MODEL },
      concurrency: { type: "string", default: "6" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    return;
  }
  const neighbours = Number(values.neighbours);
  if (!Number.isInteger(neighbours) || neighbours < 1)
    throw new Error(
      `--neighbours takes a positive integer, got ${values.neighbours}`,
    );
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const repo = resolveRepo(values.repo, cwd);
  const [owner = "", name = ""] = repo.split("/");
  const outPath = outPathOf(root, values.out);
  const apiKey = requireApiKey();

  log(`fetching open issues of ${repo}…`);
  const report = await findDuplicateGroups({
    open: fetchOpenIssues(owner, name),
    jev: httpJevClient({
      questions: pairQuestions,
      model: values.model,
      post: fetchPost(apiKey),
    }),
    excludeLabels: values["exclude-label"] ?? DEFAULT_EXCLUDED,
    neighbours,
    concurrency: Number(values.concurrency),
    log,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`);
  log(
    `${report.candidates} pairs asked, ${report.unanswered.length} unanswered, ${report.groups.length} groups, input tokens ${report.inputTokens} → ${outPath}`,
  );
}

function main(argv: readonly string[], cwd: string): Promise<void> {
  const [command, ...rest] = argv;
  return command === "duplicates" ? duplicates(rest, cwd) : sweep(argv, cwd);
}

main(process.argv.slice(2), process.cwd()).catch((error: unknown) => {
  console.error(
    `backlog-sweep: ${error instanceof Error ? error.message : String(error)}\n(backlog-sweep --help for usage)`,
  );
  process.exitCode = 1;
});
