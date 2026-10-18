import { z } from "zod";

const RepoPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").includes(".."),
    "repo-relative path",
  );

/** A feature or role key as the vocabulary spells it; `plan` checks it against the vocabulary. */
const VocabularyKey = z.string().min(1);

/** Where a file is and where it goes — the only part of a move row `apply` reads. */
export type PathMove = { readonly from: string; readonly to: string };

export const MoveRow = z.object({
  from: RepoPath,
  to: RepoPath,
  feature: VocabularyKey,
  role: VocabularyKey,
  confidence: z.number().min(0).max(1),
});
export type MoveRow = z.infer<typeof MoveRow>;

/**
 * What the import graph says about a file: the named feature holding a strict majority of its
 * import edges to judged neighbours, and that feature's share of them. With no strict majority, or
 * no such edges, there is no pull and so no share.
 */
export const GraphPull = z.union([
  z.object({
    feature: VocabularyKey,
    share: z.number().gt(0.5).max(1),
    edges: z.number().int().min(1),
  }),
  z.object({
    feature: z.null(),
    edges: z.number().int().min(0),
  }),
]);
export type GraphPull = z.infer<typeof GraphPull>;

/**
 * A file the graph and Jev do not agree on: `feature`, `role` and `confidence` are Jev's opinion,
 * `graph` is the import graph's.
 */
export const ReviewRow = z.object({
  path: RepoPath,
  feature: VocabularyKey,
  role: VocabularyKey,
  confidence: z.number().min(0).max(1),
  graph: GraphPull,
});
export type ReviewRow = z.infer<typeof ReviewRow>;

/** A file that must stay where it is, and the convention or config that says so. */
export const PinnedRow = z.object({ path: RepoPath, entry: z.string().min(1) });
export type PinnedRow = z.infer<typeof PinnedRow>;

export const Manifest = z.object({
  scope: RepoPath,
  features: z.array(VocabularyKey).min(1),
  floor: z.number().min(0).max(1),
  moves: z.array(MoveRow),
  review: z.array(ReviewRow),
  pinned: z.array(PinnedRow),
});
export type Manifest = z.infer<typeof Manifest>;

/**
 * One move a person planned: a from/to pair and nothing else. Strict, so a row carrying Jev's
 * `feature`, `role` or `confidence` is refused rather than read as a sweep's judgment.
 */
export const HandPlanRow = z.strictObject({ from: RepoPath, to: RepoPath });
export type HandPlanRow = z.infer<typeof HandPlanRow>;

const rowName = (row: HandPlanRow, i: number) =>
  `moves[${i}] ${row.from} -> ${row.to}`;

/** Every pair of rows that share an end, named by both rows. */
function sharedEnds(moves: readonly HandPlanRow[]): string[] {
  const clashes: string[] = [];
  for (const end of ["from", "to"] as const) {
    const first = new Map<string, string>();
    moves.forEach((row, i) => {
      const seen = first.get(row[end]);
      if (seen === undefined) first.set(row[end], rowName(row, i));
      else clashes.push(`${seen} and ${rowName(row, i)} share a \`${end}\``);
    });
  }
  return clashes;
}

/**
 * A move plan written by hand: the scope `apply` loads, and from/to rows no sweep judged. Strict at
 * every level, so a Jev manifest's header or row fields cannot pass as a hand plan, and no two rows
 * share a `from` or a `to`.
 */
export const HandPlan = z
  .strictObject({ scope: RepoPath, moves: z.array(HandPlanRow) })
  .superRefine((plan, ctx) => {
    for (const message of sharedEnds(plan.moves))
      ctx.addIssue({ code: "custom", path: ["moves"], message });
  });
export type HandPlan = z.infer<typeof HandPlan>;

/**
 * Where a schema issue sits: inside a row, that row named by index and by the from/to it was
 * written with; elsewhere, its path. A shared-end issue names its rows itself and sits on `moves`.
 */
function issueSite(raw: unknown, path: readonly PropertyKey[]): string {
  const [head, index] = path;
  if (head !== "moves" || typeof index !== "number")
    return path.length === 0 ? "plan" : path.join(".");
  const row: unknown = (raw as { moves?: unknown[] }).moves?.[index];
  const end = (key: "from" | "to") =>
    typeof row === "object" && row !== null && key in row
      ? String((row as Record<string, unknown>)[key])
      : "?";
  const field = path.slice(2).join(".");
  return `moves[${index}] ${end("from")} -> ${end("to")}${field === "" ? "" : ` (${field})`}`;
}

/** Parse a hand plan, or throw an error naming each bad row and what is wrong with it. */
export function parseHandPlan(raw: unknown): HandPlan {
  const parsed = HandPlan.safeParse(raw);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map(
    (issue) => `  ${issueSite(raw, issue.path)}: ${issue.message}`,
  );
  throw new Error(`hand plan refused:\n${lines.join("\n")}`);
}

/** The slice of a `sweep` verdict row `plan` reads. */
export const VerdictRow = z.object({
  path: z.string(),
  answers: z.object({
    feature: z.object({ choice: z.string(), confidence: z.number() }),
    role: z.object({ choice: z.string() }),
  }),
});
export type VerdictRow = z.infer<typeof VerdictRow>;
