import { z } from "zod";
import { UNANSWERED } from "../pairs/anchor.js";
import { PAIR_VERDICTS, type PairVerdict } from "../pairs/questions.js";
import { isAnswered, pairGroups } from "../pairs/report.js";

/** The slice of a `sweep` verdict row `consolidate` reads. */
export const ClusterRow = z.object({
  path: z.string(),
  scope: z.string(),
  answers: z.object({
    feature: z.object({ choice: z.string() }),
    role: z.object({ choice: z.string() }),
  }),
});
export type ClusterRow = z.infer<typeof ClusterRow>;

const JudgedFunction = z.object({ path: z.string(), function: z.string() });

/** The slice of a `pairs` row `consolidate` reads: its two functions and the verdict Jev gave, if any. */
export const JudgedPairRow = z.object({
  scope: z.string(),
  a: JudgedFunction,
  b: JudgedFunction,
  answers: z.object({
    verdict: z.union([
      z.object({
        choice: z.enum(PAIR_VERDICTS as [PairVerdict, ...PairVerdict[]]),
        confidence: z.number().min(0).max(1),
      }),
      z.object({ choice: z.literal(UNANSWERED) }),
    ]),
  }),
});
export type JudgedPairRow = z.infer<typeof JudgedPairRow>;

/** @deprecated Renamed `JudgedPairRow`: `consolidate` reads every verdict off a pair row, not only `shared_helper`. */
export const HelperPairRow = JudgedPairRow;
/** @deprecated Renamed `JudgedPairRow`. */
export type HelperPairRow = JudgedPairRow;

export interface SmallFile {
  readonly path: string;
  /** Non-blank lines at the plan's ref. */
  readonly lines: number;
}

/** Tiny files sharing one scope, feature and role: candidates to merge into one module. */
export interface MergeProposal {
  readonly scope: string;
  readonly feature: string;
  readonly role: string;
  readonly files: readonly SmallFile[];
  readonly lines: number;
}

/**
 * Functions joined by `same_decision` pairs at or above the collapse floor: copies of one business
 * rule to collapse into one function.
 */
export interface CollapseProposal {
  readonly scope: string;
  /** `path:function`, sorted. */
  readonly members: readonly string[];
  /** The `same_decision` pairs at or above the floor that joined them. */
  readonly pairs: number;
  /** The weakest of those pairs' confidences. */
  readonly confidence: number;
}

/** Functions joined by `shared_helper` pairs: plumbing to extract into one helper. */
export interface ExtractProposal {
  readonly scope: string;
  /** `path:function`, sorted. */
  readonly members: readonly string[];
  readonly pairs: number;
}

export interface ClusterOptions {
  /** A file counts as small at or under this many non-blank lines (default 40). */
  readonly maxLines?: number;
  /** A group becomes a proposal at this many small files (default 3). */
  readonly minCluster?: number;
}

export interface CollapseOptions {
  /** A `same_decision` pair joins a group at or above this confidence (default `DEFAULT_COLLAPSE_FLOOR`). */
  readonly floor?: number;
}

export interface ConsolidationPlan {
  readonly ref: string;
  readonly maxLines: number;
  readonly minCluster: number;
  /** `null` when the verdicts file was absent: not computed, as against none found. */
  readonly merge: readonly MergeProposal[] | null;
  /** The confidence a `same_decision` pair needs to join a collapse group. */
  readonly floor: number;
  /** `null` when the pairs file was absent. */
  readonly collapse: readonly CollapseProposal[] | null;
  /** `null` when the pairs file was absent. */
  readonly extract: readonly ExtractProposal[] | null;
}

export const DEFAULT_MAX_LINES = 40;
export const DEFAULT_MIN_CLUSTER = 3;

/**
 * The confidence a `same_decision` pair needs before `consolidate` joins its two functions. A group
 * is a connected component of the pairs left at or above it, so one weak link merges two rules into
 * one proposal: the floor sits where `move` trusts a verdict, not at the bare yes of one half.
 */
export const DEFAULT_COLLAPSE_FLOOR = 0.8;

/** A collapse floor is a confidence, from 0 to 1. */
export function collapseFloor(floor: number): number {
  if (!Number.isFinite(floor) || floor < 0 || floor > 1)
    throw new RangeError(`--floor is a confidence from 0 to 1, not ${floor}`);
  return floor;
}

export const nonBlankLines = (text: string) =>
  text.split("\n").filter((line) => line.trim() !== "").length;

const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Group verdict rows by scope + feature + role and keep, per group, the files at or under
 * `maxLines`; a group with at least `minCluster` of them is one proposal. `linesOf` answers
 * `undefined` for a file absent at the ref, which then counts toward nothing. Only groups that could
 * reach `minCluster` are measured.
 */
export function mergeProposals(
  rows: readonly ClusterRow[],
  linesOf: (path: string) => number | undefined,
  options: ClusterOptions = {},
): MergeProposal[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const minCluster = options.minCluster ?? DEFAULT_MIN_CLUSTER;
  // One row per path, the last one winning, as the verdict file itself keys them.
  const unique = [...new Map(rows.map((r) => [r.path, r])).values()];
  const groups = new Map<string, ClusterRow[]>();
  for (const row of unique) {
    const k = [
      row.scope,
      row.answers.feature.choice,
      row.answers.role.choice,
    ].join("\0");
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  const proposals: MergeProposal[] = [];
  for (const group of groups.values()) {
    if (group.length < minCluster) continue;
    const files = group
      .map((r) => ({ path: r.path, lines: linesOf(r.path) }))
      .filter(
        (f): f is SmallFile => f.lines !== undefined && f.lines <= maxLines,
      )
      .sort((x, y) => byText(x.path, y.path));
    const [first] = group;
    if (first === undefined || files.length < minCluster) continue;
    proposals.push({
      scope: first.scope,
      feature: first.answers.feature.choice,
      role: first.answers.role.choice,
      files,
      lines: files.reduce((sum, f) => sum + f.lines, 0),
    });
  }
  return proposals.sort(
    (x, y) =>
      y.files.length - x.files.length ||
      byText(x.scope, y.scope) ||
      byText(x.feature, y.feature) ||
      byText(x.role, y.role),
  );
}

interface ScopedGroup {
  readonly scope: string;
  readonly members: readonly string[];
  readonly pairs: number;
}

/** Most members first, then most pairs, then scope and first member, so the order is stable. */
const bySize = (x: ScopedGroup, y: ScopedGroup) =>
  y.members.length - x.members.length ||
  y.pairs - x.pairs ||
  byText(x.scope, y.scope) ||
  byText(x.members[0] ?? "", y.members[0] ?? "");

/** The connected groups the `verdict` pairs form within each scope, scopes in order. */
function scopedGroups<R extends JudgedPairRow>(
  rows: readonly R[],
  verdict: PairVerdict,
) {
  const scopes = [...new Set(rows.map((r) => r.scope))].sort(byText);
  return scopes.flatMap((scope) =>
    pairGroups(
      rows.filter((r) => r.scope === scope),
      verdict,
    ).map((g) => ({ scope, ...g })),
  );
}

/**
 * One proposal per connected group of `same_decision` pairs within a scope, counting only pairs at
 * or above `floor`. An `unanswered` pair or one under the floor joins nothing, so every function in
 * a group is linked to it by confirmations at the floor. The pairs can come from any number of
 * anchors: two pairs sharing a function join wherever each was asked.
 */
export function collapseProposals(
  rows: readonly JudgedPairRow[],
  options: CollapseOptions = {},
): CollapseProposal[] {
  const floor = collapseFloor(options.floor ?? DEFAULT_COLLAPSE_FLOOR);
  const confirmed = rows
    .filter(isAnswered)
    .filter((r) => r.answers.verdict.confidence >= floor);
  return scopedGroups(confirmed, "same_decision")
    .map(({ scope, members, pairs }) => ({
      scope,
      members,
      pairs: pairs.length,
      confidence: Math.min(...pairs.map((p) => p.answers.verdict.confidence)),
    }))
    .sort(bySize);
}

/** One candidate per connected group of `shared_helper` pairs within a scope. */
export function extractProposals(
  rows: readonly JudgedPairRow[],
): ExtractProposal[] {
  return scopedGroups(rows, "shared_helper")
    .map(({ scope, members, pairs }) => ({
      scope,
      members,
      pairs: pairs.length,
    }))
    .sort(bySize);
}

function mergeLines(merge: ConsolidationPlan["merge"]): string[] {
  if (merge === null) return ["skipped: no sweep verdicts", ""];
  if (merge.length === 0) return ["none", ""];
  return merge.flatMap((p, i) => [
    `${i + 1}. **${p.scope}** · ${p.feature} · ${p.role}: ${p.files.length} files, ${p.lines} lines`,
    ...p.files.map((f) => `   - \`${f.path}\` (${f.lines})`),
    "",
  ]);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function collapseLines(collapse: ConsolidationPlan["collapse"]): string[] {
  if (collapse === null) return ["skipped: no judged pairs", ""];
  if (collapse.length === 0) return ["none", ""];
  return collapse.flatMap((p, i) => [
    `${i + 1}. **${p.scope}**: ${p.members.length} functions, ${p.pairs} pairs judged same_decision, weakest ${pct(p.confidence)}`,
    ...p.members.map((m) => `   - \`${m}\``),
    "",
  ]);
}

function extractLines(extract: ConsolidationPlan["extract"]): string[] {
  if (extract === null) return ["skipped: no judged pairs", ""];
  if (extract.length === 0) return ["none", ""];
  return extract.flatMap((p, i) => [
    `${i + 1}. **${p.scope}**: ${p.members.length} functions, ${p.pairs} pairs judged shared_helper`,
    ...p.members.map((m) => `   - \`${m}\``),
    "",
  ]);
}

/** The plan as a markdown summary: merge clusters, collapse groups, then extract candidates. */
export function renderConsolidation(plan: ConsolidationPlan): string {
  return [
    "# Consolidation plan",
    "",
    `Files with at most ${plan.maxLines} non-blank lines at \`${plan.ref}\`, in groups of at least ${plan.minCluster} sharing scope, feature and role.`,
    "",
    "## Merge small files",
    "",
    ...mergeLines(plan.merge),
    "## Collapse copies of one rule",
    "",
    `Functions joined by \`same_decision\` pairs at confidence ${pct(plan.floor)} or above.`,
    "",
    ...collapseLines(plan.collapse),
    "## Extract shared helpers",
    "",
    ...extractLines(plan.extract),
  ].join("\n");
}
