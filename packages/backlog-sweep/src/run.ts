import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JevUsage } from "@demlik/tea/jev";
import {
  buildIndex,
  type Evidence,
  gatherEvidence,
  withCandidates,
} from "./evidence.js";
import type { ClosedIssue, OpenIssue } from "./github.js";
import { type JevClient, pool } from "./jev.js";
import type { RepoSnapshot } from "./repo.js";
import {
  type Answers,
  type Proposal,
  propose,
  type Questions,
} from "./verdict.js";

export interface Row {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly updatedAt: string;
  readonly evidence: Evidence["evidence"];
  readonly answers: Answers;
  readonly proposal: Proposal;
  readonly model: string;
  readonly usage: JevUsage;
}

export interface BacklogSweepOptions {
  readonly snapshot: RepoSnapshot;
  readonly open: readonly OpenIssue[];
  readonly closed: readonly ClosedIssue[];
  readonly jev: JevClient<Questions>;
  readonly outPath: string;
  /** Issues carrying any of these labels are not judged. */
  readonly excludeLabels?: readonly string[];
  /** Judge a seeded random sample of this many instead of every eligible issue. */
  readonly sample?: { readonly size: number; readonly seed: number };
  readonly concurrency?: number;
  readonly log?: (line: string) => void;
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/**
 * Ask Jev whether each open issue is still needed, re-asking only about an issue that changed since
 * the verdict file last saw it. Writes the verdict file after every answer, so a killed run resumes.
 */
export async function runBacklogSweep(
  options: BacklogSweepOptions,
): Promise<readonly Row[]> {
  const { open, closed, outPath } = options;
  const log = options.log ?? (() => {});
  const excluded = new Set(options.excludeLabels ?? []);
  const index = buildIndex(open, closed);
  const openByNumber = new Map(open.map((i) => [i.number, i]));
  const closedByNumber = new Map(closed.map((i) => [i.number, i]));

  const eligible = open.filter((i) => !i.labels.some((l) => excluded.has(l)));
  const chosen =
    options.sample === undefined
      ? eligible
      : seededShuffle(eligible, options.sample.seed).slice(
          0,
          options.sample.size,
        );

  const previous: Row[] = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : [];
  const done = new Map(previous.map((r) => [r.number, r]));
  const todo = chosen.filter(
    (i) => done.get(i.number)?.updatedAt !== i.updatedAt,
  );
  const evidenceOf = (issue: OpenIssue) =>
    gatherEvidence(
      issue,
      options.snapshot,
      index,
      openByNumber,
      closedByNumber,
    );
  // A cached row keeps Jev's answers and the candidates they judged. The facts a close stands on are
  // read fresh and the proposal recomputed, so a row written under an older rule is never replayed.
  for (const issue of chosen) {
    const row = done.get(issue.number);
    if (row === undefined || row.updatedAt !== issue.updatedAt) continue;
    const evidence = withCandidates(evidenceOf(issue), row.evidence.candidates);
    done.set(issue.number, {
      ...row,
      evidence: evidence.evidence,
      proposal: propose(evidence, row.answers),
    });
  }
  log(
    `${open.length} open, ${eligible.length} eligible, ${chosen.length} chosen, ${todo.length} to ask`,
  );

  const rows = () => chosen.flatMap((i) => done.get(i.number) ?? []);
  const save = () => {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(rows(), null, 1)}\n`);
  };

  let asked = 0;
  await pool(todo, options.concurrency ?? 6, async (issue) => {
    const evidence = evidenceOf(issue);
    try {
      const ok = await options.jev(evidence);
      done.set(issue.number, {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels: issue.labels,
        updatedAt: issue.updatedAt,
        evidence: evidence.evidence,
        answers: ok.answers,
        proposal: propose(evidence, ok.answers),
        model: ok.model,
        usage: ok.usage,
      });
      save();
    } catch (error) {
      log(
        `#${issue.number} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    asked++;
    if (asked % 10 === 0) log(`${asked}/${todo.length}`);
  });
  save();
  return rows();
}
