import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { DEFAULTS, underRoot } from "../cli-paths.js";
import { git, repoRootOf } from "../git.js";
import {
  ClusterRow,
  type ConsolidationPlan,
  DEFAULT_MAX_LINES,
  DEFAULT_MIN_CLUSTER,
  extractProposals,
  HelperPairRow,
  mergeProposals,
  nonBlankLines,
  renderConsolidation,
} from "./plan.js";

export const CONSOLIDATE_USAGE = `structure-sweep consolidate [options]

  Propose consolidations from outputs already on disk: clusters of tiny files sharing scope,
  feature and role to merge, and groups of shared_helper pairs to extract. Writes a plan and
  changes no source file. No Jev call, no network.

  --verdicts <file>     sweep output (default: ${DEFAULTS.verdicts})
  --pairs <file>        pairs output (default: ${DEFAULTS.pairs})
  --ref <ref>           git tree file sizes are read from (default: HEAD)
  --max-lines <n>       a file is small at or under this many non-blank lines (default: ${DEFAULT_MAX_LINES})
  --min-cluster <n>     small files a group needs to become a proposal (default: ${DEFAULT_MIN_CLUSTER})
  --out <file>          JSON plan (default: ${DEFAULTS.consolidate})
  --report <file>       markdown summary (default: ${DEFAULTS.consolidateReport})`;

/** The rows at `path` parsed by `row`, or `null` when there is no such file. */
function readRows<T>(
  path: string,
  row: z.ZodType<T>,
  log: (line: string) => void,
): T[] | null {
  if (!existsSync(path)) {
    log(`no ${path}; skipping its proposals`);
    return null;
  }
  try {
    return z.array(row).parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Non-blank line counts of files as `ref` has them; `undefined` for a path absent there. */
function linesAt(
  root: string,
  ref: string,
): (path: string) => number | undefined {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]);
  } catch {
    throw new Error(`--ref ${ref} names no tree in ${root}`);
  }
  const present = new Set(
    git(root, ["-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", ref])
      .split("\n")
      .filter(Boolean),
  );
  return (path) =>
    present.has(path)
      ? nonBlankLines(git(root, ["show", `${ref}:${path}`]))
      : undefined;
}

const count = (name: string, value: string, min: number) =>
  z.coerce
    .number()
    .int()
    .min(min, `--${name} must be an integer of at least ${min}`)
    .parse(value);

export function consolidateCommand(argv: readonly string[], cwd: string): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      verdicts: { type: "string", default: DEFAULTS.verdicts },
      pairs: { type: "string", default: DEFAULTS.pairs },
      ref: { type: "string", default: "HEAD" },
      "max-lines": { type: "string", default: String(DEFAULT_MAX_LINES) },
      "min-cluster": { type: "string", default: String(DEFAULT_MIN_CLUSTER) },
      out: { type: "string", default: DEFAULTS.consolidate },
      report: { type: "string", default: DEFAULTS.consolidateReport },
    },
  });
  const log = (line: string) => console.error(line);
  const root = repoRootOf(cwd);
  const maxLines = count("max-lines", values["max-lines"], 1);
  const minCluster = count("min-cluster", values["min-cluster"], 2);
  const verdicts = readRows(underRoot(root, values.verdicts), ClusterRow, log);
  const pairs = readRows(underRoot(root, values.pairs), HelperPairRow, log);

  const plan: ConsolidationPlan = {
    ref: values.ref,
    maxLines,
    minCluster,
    merge:
      verdicts === null
        ? null
        : mergeProposals(verdicts, linesAt(root, values.ref), {
            maxLines,
            minCluster,
          }),
    extract: pairs === null ? null : extractProposals(pairs),
  };

  const outPath = underRoot(root, values.out);
  const reportPath = underRoot(root, values.report);
  for (const path of [outPath, reportPath])
    mkdirSync(dirname(path), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(plan, null, 1)}\n`);
  writeFileSync(reportPath, renderConsolidation(plan));
  log(
    `${plan.merge?.length ?? "no"} merge, ${plan.extract?.length ?? "no"} extract proposals → ${outPath}, ${reportPath}`,
  );
}
