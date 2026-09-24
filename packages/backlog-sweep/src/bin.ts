#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetchClosedIssues, fetchOpenIssues } from "./github.js";
import {
  DEFAULT_MODEL,
  fetchPost,
  httpJevClient,
  requireApiKey,
} from "./jev.js";
import { git, resolveRepo, snapshotRepo } from "./repo.js";
import { runBacklogSweep } from "./run.js";
import { questions } from "./verdict.js";

const DEFAULT_OUT = ".backlog-sweep/verdicts.json";
const DEFAULT_EXCLUDED = ["type:epic", "status:awaiting-release"];

const USAGE = `backlog-sweep [options]

  Gather evidence for every open issue of a GitHub repository and ask Jev whether each is still
  needed. Writes one verdict per issue; closing anything is a human's call.

  --repo <owner/name>     repository to sweep (default: this checkout's origin remote)
  --ref <ref>             tree the evidence is read from (default: origin/main)
  --out <file>            verdict file (default: ${DEFAULT_OUT})
  --exclude-label <name>  skip issues with this label (repeatable; default: ${DEFAULT_EXCLUDED.join(", ")})
  --sample <n>            judge a seeded random sample of n issues
  --seed <n>              seed for --sample (default: 4498)
  --model <id>            Jev model (default: ${DEFAULT_MODEL})
  --concurrency <n>       calls in flight (default: 6)`;

async function main(argv: readonly string[], cwd: string): Promise<void> {
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
  const outPath = isAbsolute(values.out)
    ? values.out
    : resolve(root, values.out);
  const apiKey = requireApiKey();
  const log = (line: string) => console.error(line);

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

  const tally = new Map<string, number>();
  for (const r of rows)
    tally.set(r.proposal.kind, (tally.get(r.proposal.kind) ?? 0) + 1);
  const input = rows.reduce((n, r) => n + r.usage.input_tokens, 0);
  log(
    `${JSON.stringify(Object.fromEntries(tally))} input tokens ${input} → ${outPath}`,
  );
}

main(process.argv.slice(2), process.cwd()).catch((error: unknown) => {
  console.error(
    `backlog-sweep: ${error instanceof Error ? error.message : String(error)}\n(backlog-sweep --help for usage)`,
  );
  process.exitCode = 1;
});
