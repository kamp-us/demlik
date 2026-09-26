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

/** The slice of a `sweep` verdict row `plan` reads. */
export const VerdictRow = z.object({
  path: z.string(),
  answers: z.object({
    feature: z.object({ choice: z.string(), confidence: z.number() }),
    role: z.object({ choice: z.string() }),
  }),
});
export type VerdictRow = z.infer<typeof VerdictRow>;
