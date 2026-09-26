import type { JevUsage } from "@demlik/tea/jev";
import { absurd } from "../absurd.js";
import { type AnchorAnswers, UNANSWERED } from "./anchor.js";
import type { GraphSignal, PairFunction } from "./collapse.js";
import {
  PAIR_VERDICTS,
  type PairAnswers,
  type PairVerdict,
} from "./questions.js";

export type JudgedFunction = Omit<PairFunction, "source" | "lowered">;

/** A collapse pair the partner cap left unasked: both its functions and the score it was ranked by. */
export interface SkippedPair {
  readonly scope: string;
  readonly a: JudgedFunction;
  readonly b: JudgedFunction;
  readonly graphConfidence: number;
}

export interface PairRow {
  readonly id: string;
  readonly scope: string;
  readonly a: JudgedFunction;
  readonly b: JudgedFunction;
  readonly signals: readonly GraphSignal[];
  readonly graphConfidence: number;
  /** Present only on a row Jev answered without file paths; a default row has no such field. Part of the cache key. */
  readonly redacted?: true;
  /**
   * Present only on a row where Jev was sent at least one side's stage-2 lowered body in place of its
   * source: a hash of the bodies sent. Part of the cache key, so lowered and raw sends never share an answer.
   */
  readonly lowered?: string;
  /** The pairwise three-way verdict, or an anchor-mode row's reading of its anchor's one answer. */
  readonly answers: PairAnswers | AnchorAnswers;
  readonly model: string;
  /** The call that answered the row; on an anchor-mode row, the one call over its anchor's whole menu. */
  readonly usage: JevUsage;
}

/** What a `pairs.json` row can record: a verdict Jev gave, or `unanswered` where it gave none. */
export type RowVerdict = PairVerdict | typeof UNANSWERED;

/** Every row verdict, in the order `pairs.md` counts them. */
export const ROW_VERDICTS: readonly RowVerdict[] = [
  ...PAIR_VERDICTS,
  UNANSWERED,
];

/** The slice of a pair row `pairGroups` reads: its two functions and the verdict. */
export interface GroupablePair {
  readonly a: Pick<JudgedFunction, "path" | "function">;
  readonly b: Pick<JudgedFunction, "path" | "function">;
  readonly answers: { readonly verdict: { readonly choice: RowVerdict } };
}

/** A verdict Jev gave, at the confidence it gave it. */
interface GivenVerdict {
  readonly choice: PairVerdict;
  readonly confidence: number;
}

/** A row whose verdict is either one Jev gave or `unanswered`. */
export interface VerdictRow {
  readonly answers: {
    readonly verdict: GivenVerdict | { readonly choice: typeof UNANSWERED };
  };
}

/** A row carrying a verdict Jev gave. */
export type Answered<R extends VerdictRow> = R & {
  readonly answers: { readonly verdict: GivenVerdict };
};

/** Whether Jev answered the row. An `unanswered` row is never counted as, or served as, a verdict. */
export const isAnswered = <R extends VerdictRow>(row: R): row is Answered<R> =>
  row.answers.verdict.choice !== UNANSWERED;

/** Functions (`path:function`) joined by pairs that share one, and the pairs that joined them. */
export interface PairGroup<R extends GroupablePair = PairRow> {
  readonly members: readonly string[];
  readonly pairs: readonly R[];
}

export type DecisionGroup = PairGroup<Answered<PairRow>>;

const key = (fn: Pick<JudgedFunction, "path" | "function">) =>
  `${fn.path}:${fn.function}`;

/** What a human does about a pair Jev judged this way. Exhaustive: a new verdict fails to compile here. */
export function actionFor(verdict: RowVerdict): string {
  switch (verdict) {
    case "same_decision":
      return "collapse into one function";
    case "look_alike":
      return "keep apart";
    case "shared_helper":
      return "extract a shared helper";
    case UNANSWERED:
      return "run pairs again to ask Jev";
    default:
      return absurd(verdict);
  }
}

export function countVerdicts(
  rows: readonly PairRow[],
): Record<RowVerdict, number> {
  const counts: Record<RowVerdict, number> = {
    same_decision: 0,
    look_alike: 0,
    shared_helper: 0,
    unanswered: 0,
  };
  for (const row of rows) counts[row.answers.verdict.choice] += 1;
  return counts;
}

/**
 * The counts a report prints: every verdict Jev can give, and `unanswered` only where a row is.
 * A run in which Jev answered every row prints what it printed before the state existed.
 */
export function shownCounts(
  counts: Record<RowVerdict, number>,
): [RowVerdict, number][] {
  return ROW_VERDICTS.filter((v) => v !== UNANSWERED || counts[v] > 0).map(
    (v) => [v, counts[v]],
  );
}

/**
 * The connected groups the `verdict` pairs form: two pairs sharing a function land in one group.
 * Groups come in first-seen order, each with its members sorted.
 */
export function pairGroups<R extends GroupablePair>(
  rows: readonly R[],
  verdict: PairVerdict,
): PairGroup<R>[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const same = rows.filter((r) => r.answers.verdict.choice === verdict);
  for (const row of same) parent.set(find(key(row.a)), find(key(row.b)));
  const groups = new Map<string, { members: Set<string>; pairs: R[] }>();
  for (const row of same) {
    const root = find(key(row.a));
    const group = groups.get(root) ?? { members: new Set<string>(), pairs: [] };
    group.members.add(key(row.a)).add(key(row.b));
    group.pairs.push(row);
    groups.set(root, group);
  }
  return [...groups.values()].map((g) => ({
    members: [...g.members].sort(),
    pairs: g.pairs,
  }));
}

export function decisionGroups(rows: readonly PairRow[]): DecisionGroup[] {
  return pairGroups(rows.filter(isAnswered), "same_decision").sort(
    (x, y) =>
      y.members.length - x.members.length || y.pairs.length - x.pairs.length,
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function groupLines(group: DecisionGroup, index: number): string[] {
  const confidences = group.pairs.map((p) => p.answers.verdict.confidence);
  const rule = Math.max(
    ...group.pairs.map((p) => p.answers.business_rule.noul),
  );
  return [
    `${index + 1}. **${group.members.length} functions**, ${group.pairs.length} pairs judged same, confidence ${pct(Math.min(...confidences))}–${pct(Math.max(...confidences))}, business rule ${pct(rule)}`,
    ...group.members.map((m) => `   - \`${m}\``),
  ];
}

function skippedLines(skipped: readonly SkippedPair[]): string[] {
  if (skipped.length === 0) return [];
  return [
    "### skipped over the partner cap",
    "",
    `${skipped.length} pairs not asked: each is outside the top \`--max-partners\` by graph confidence of the anchor it was dealt to.`,
    "",
    ...skipped.map(
      (p) =>
        `- \`${key(p.a)}\` × \`${key(p.b)}\`, graph confidence ${pct(p.graphConfidence)}`,
    ),
    "",
  ];
}

export function renderMarkdown(
  rows: readonly PairRow[],
  skipped: readonly SkippedPair[] = [],
): string {
  const scopes = [...new Set([...rows, ...skipped].map((r) => r.scope))].sort();
  const lines = ["# Collapse candidates judged by Jev", ""];
  for (const scope of scopes) {
    const scoped = rows.filter((r) => r.scope === scope);
    const counts = countVerdicts(scoped);
    lines.push(
      `## ${scope}`,
      "",
      "| verdict | pairs | action |",
      "|---|---|---|",
    );
    for (const [verdict, count] of shownCounts(counts)) {
      lines.push(`| ${verdict} | ${count} | ${actionFor(verdict)} |`);
    }
    lines.push("", "### same_decision groups", "");
    const groups = decisionGroups(scoped);
    if (groups.length === 0) lines.push("none", "");
    for (const [i, group] of groups.entries())
      lines.push(...groupLines(group, i), "");
    lines.push(...skippedLines(skipped.filter((p) => p.scope === scope)));
  }
  return lines.join("\n");
}
