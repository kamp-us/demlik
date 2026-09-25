import { z } from "zod";
import { PAIR_VERDICTS, type PairVerdict } from "../pairs/questions.js";
import { pairGroups } from "../pairs/report.js";

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

/** The slice of a `pairs` row `consolidate` reads. */
export const HelperPairRow = z.object({
  scope: z.string(),
  a: JudgedFunction,
  b: JudgedFunction,
  answers: z.object({
    verdict: z.object({
      choice: z.enum(PAIR_VERDICTS as [PairVerdict, ...PairVerdict[]]),
    }),
  }),
});
export type HelperPairRow = z.infer<typeof HelperPairRow>;

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

export interface ConsolidationPlan {
  readonly ref: string;
  readonly maxLines: number;
  readonly minCluster: number;
  /** `null` when the verdicts file was absent: not computed, as against none found. */
  readonly merge: readonly MergeProposal[] | null;
  /** `null` when the pairs file was absent. */
  readonly extract: readonly ExtractProposal[] | null;
}

export const DEFAULT_MAX_LINES = 40;
export const DEFAULT_MIN_CLUSTER = 3;

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

/** One candidate per connected group of `shared_helper` pairs within a scope. */
export function extractProposals(
  rows: readonly HelperPairRow[],
): ExtractProposal[] {
  const scopes = [...new Set(rows.map((r) => r.scope))].sort(byText);
  return scopes
    .flatMap((scope) =>
      pairGroups(
        rows.filter((r) => r.scope === scope),
        "shared_helper",
      ).map((g) => ({
        scope,
        members: g.members,
        pairs: g.pairs.length,
      })),
    )
    .sort(
      (x, y) =>
        y.members.length - x.members.length ||
        y.pairs - x.pairs ||
        byText(x.scope, y.scope) ||
        byText(x.members[0] ?? "", y.members[0] ?? ""),
    );
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

function extractLines(extract: ConsolidationPlan["extract"]): string[] {
  if (extract === null) return ["skipped: no judged pairs", ""];
  if (extract.length === 0) return ["none", ""];
  return extract.flatMap((p, i) => [
    `${i + 1}. **${p.scope}**: ${p.members.length} functions, ${p.pairs} pairs judged shared_helper`,
    ...p.members.map((m) => `   - \`${m}\``),
    "",
  ]);
}

/** The plan as a markdown summary: merge clusters, then extract candidates. */
export function renderConsolidation(plan: ConsolidationPlan): string {
  return [
    "# Consolidation plan",
    "",
    `Files with at most ${plan.maxLines} non-blank lines at \`${plan.ref}\`, in groups of at least ${plan.minCluster} sharing scope, feature and role.`,
    "",
    "## Merge small files",
    "",
    ...mergeLines(plan.merge),
    "## Extract shared helpers",
    "",
    ...extractLines(plan.extract),
  ].join("\n");
}
