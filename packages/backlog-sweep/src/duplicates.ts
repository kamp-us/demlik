import { buildIndex, clip } from "./evidence.js";
import type { OpenIssue } from "./github.js";
import { type JevClient, pool } from "./jev.js";
import { CONFIDENCE_FLOOR, type PairQuestions } from "./verdict.js";

export const DEFAULT_NEIGHBOURS = 5;

const BODY_LIMIT = 1500;

/** An unordered pair of open issues, stored with the lower number first so it has one spelling. */
export interface CandidatePair {
  readonly a: number;
  readonly b: number;
}

export interface ConfirmedPair extends CandidatePair {
  readonly confidence: number;
}

export interface DuplicateGroup {
  readonly issues: readonly {
    readonly number: number;
    readonly title: string;
    readonly url: string;
  }[];
  readonly pairs: readonly ConfirmedPair[];
}

export interface DuplicateReport {
  readonly candidates: number;
  /** Pairs whose Jev call failed for good: unjudged, so they confirm nothing. */
  readonly unanswered: readonly CandidatePair[];
  readonly groups: readonly DuplicateGroup[];
  readonly inputTokens: number;
}

export interface DuplicateOptions {
  readonly open: readonly OpenIssue[];
  readonly jev: JevClient<PairQuestions>;
  /** Issues carrying any of these labels are not paired — the sweep's own rule. */
  readonly excludeLabels?: readonly string[];
  /** How many nearest open neighbours each issue is paired with. */
  readonly neighbours?: number;
  readonly concurrency?: number;
  readonly log?: (line: string) => void;
}

/**
 * The deterministic first stage: each issue's `neighbours` nearest by TF-IDF among `issues`, as
 * unordered pairs, each pair once and never an issue with itself.
 */
export function candidatePairs(
  issues: readonly OpenIssue[],
  neighbours: number,
): CandidatePair[] {
  const index = buildIndex(issues, []);
  const seen = new Set<string>();
  const pairs: CandidatePair[] = [];
  for (const issue of issues) {
    for (const hit of index.nearest(issue.number, neighbours)) {
      if (hit.id === issue.number) continue;
      const a = Math.min(issue.number, hit.id);
      const b = Math.max(issue.number, hit.id);
      const key = `${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b });
    }
  }
  return pairs;
}

/** Union-find over confirmed pairs: every connected set of two or more issues is one group. */
function groupsOf(
  confirmed: readonly ConfirmedPair[],
  byNumber: ReadonlyMap<number, OpenIssue>,
): DuplicateGroup[] {
  const parent = new Map<number, number>();
  const find = (n: number): number => {
    const p = parent.get(n) ?? n;
    if (p === n) return n;
    const root = find(p);
    parent.set(n, root);
    return root;
  };
  for (const { a, b } of confirmed) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
  const members = new Map<number, Set<number>>();
  for (const { a, b } of confirmed) {
    const root = find(a);
    const set = members.get(root) ?? new Set<number>();
    set.add(a).add(b);
    members.set(root, set);
  }
  return [...members.entries()]
    .sort(([x], [y]) => x - y)
    .map(([root, set]) => ({
      issues: [...set]
        .sort((x, y) => x - y)
        .map((number) => {
          const issue = byNumber.get(number);
          return {
            number,
            title: issue?.title ?? "",
            url: issue?.url ?? "",
          };
        }),
      pairs: confirmed
        .filter((p) => find(p.a) === root)
        .sort((x, y) => x.a - y.a || x.b - y.b),
    }));
}

const sideOf = (issue: OpenIssue) => ({
  number: issue.number,
  title: issue.title,
  body: clip(issue.body, BODY_LIMIT),
});

/**
 * Find groups of open issues that are the same concrete defect: TF-IDF proposes candidate pairs,
 * Jev judges each pair, and only a `duplicate` at or above `CONFIDENCE_FLOOR` joins two issues.
 * Closes nothing and labels nothing.
 */
export async function findDuplicateGroups(
  options: DuplicateOptions,
): Promise<DuplicateReport> {
  const log = options.log ?? (() => {});
  const excluded = new Set(options.excludeLabels ?? []);
  const eligible = options.open.filter(
    (i) => !i.labels.some((l) => excluded.has(l)),
  );
  const byNumber = new Map(eligible.map((i) => [i.number, i]));
  const candidates = candidatePairs(
    eligible,
    options.neighbours ?? DEFAULT_NEIGHBOURS,
  );
  log(
    `${options.open.length} open, ${eligible.length} eligible, ${candidates.length} candidate pairs`,
  );

  const confirmed: ConfirmedPair[] = [];
  const unanswered: CandidatePair[] = [];
  let inputTokens = 0;
  await pool(candidates, options.concurrency ?? 6, async (pair) => {
    const left = byNumber.get(pair.a);
    const right = byNumber.get(pair.b);
    if (left === undefined || right === undefined) return;
    try {
      const ok = await options.jev({
        left: sideOf(left),
        right: sideOf(right),
      });
      inputTokens += ok.usage.input_tokens;
      const { choice, confidence } = ok.answers.pair;
      if (choice === "duplicate" && confidence >= CONFIDENCE_FLOOR)
        confirmed.push({ ...pair, confidence });
    } catch (error) {
      unanswered.push(pair);
      log(
        `#${pair.a}~#${pair.b} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  });

  return {
    candidates: candidates.length,
    unanswered,
    groups: groupsOf(confirmed, byNumber),
    inputTokens,
  };
}
