import type { JevUsage } from "@demlik/tea/jev";
import { absurd } from "../absurd.js";
import type { GraphSignal, PairFunction } from "./collapse.js";
import {
  PAIR_VERDICTS,
  type PairAnswers,
  type PairVerdict,
} from "./questions.js";

export type JudgedFunction = Omit<PairFunction, "source">;

export interface PairRow {
  readonly id: string;
  readonly scope: string;
  readonly a: JudgedFunction;
  readonly b: JudgedFunction;
  readonly signals: readonly GraphSignal[];
  readonly graphConfidence: number;
  /** Present only on a row Jev answered without file paths; a default row has no such field. Part of the cache key. */
  readonly redacted?: true;
  readonly answers: PairAnswers;
  readonly model: string;
  readonly usage: JevUsage;
}

/** The slice of a pair row `pairGroups` reads: its two functions and the verdict. */
export interface GroupablePair {
  readonly a: Pick<JudgedFunction, "path" | "function">;
  readonly b: Pick<JudgedFunction, "path" | "function">;
  readonly answers: { readonly verdict: { readonly choice: PairVerdict } };
}

/** Functions (`path:function`) joined by pairs that share one, and the pairs that joined them. */
export interface PairGroup<R extends GroupablePair = PairRow> {
  readonly members: readonly string[];
  readonly pairs: readonly R[];
}

export type DecisionGroup = PairGroup<PairRow>;

const key = (fn: Pick<JudgedFunction, "path" | "function">) =>
  `${fn.path}:${fn.function}`;

/** What a human does about a pair Jev judged this way. Exhaustive: a new verdict fails to compile here. */
export function actionFor(verdict: PairVerdict): string {
  switch (verdict) {
    case "same_decision":
      return "collapse into one function";
    case "look_alike":
      return "keep apart";
    case "shared_helper":
      return "extract a shared helper";
    default:
      return absurd(verdict);
  }
}

export function countVerdicts(
  rows: readonly PairRow[],
): Record<PairVerdict, number> {
  const counts: Record<PairVerdict, number> = {
    same_decision: 0,
    look_alike: 0,
    shared_helper: 0,
  };
  for (const row of rows) counts[row.answers.verdict.choice] += 1;
  return counts;
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
  return pairGroups(rows, "same_decision").sort(
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

export function renderMarkdown(rows: readonly PairRow[]): string {
  const scopes = [...new Set(rows.map((r) => r.scope))].sort();
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
    for (const verdict of PAIR_VERDICTS) {
      lines.push(`| ${verdict} | ${counts[verdict]} | ${actionFor(verdict)} |`);
    }
    lines.push("", "### same_decision groups", "");
    const groups = decisionGroups(scoped);
    if (groups.length === 0) lines.push("none", "");
    for (const [i, group] of groups.entries())
      lines.push(...groupLines(group, i), "");
  }
  return lines.join("\n");
}
