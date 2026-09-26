import { z } from "zod";
import {
  canonicalJson,
  contentHash,
  type Stage,
  type StageArtifact,
  type StageInput,
} from "./artifact.js";
import type { Fact } from "./fact.js";
import {
  type LoweredBranch,
  lowerStage,
  renderAtom,
  renderOutcome,
  renderTerm,
} from "./lower.js";

// ── the port ──────────────────────────────────────────────────────────────

/** Embed each text, in order: one vector per text, every vector the same length. */
export type Embed = (texts: string[]) => Promise<number[][]>;

/**
 * The consumer-supplied embedding port. structure-sweep bundles no provider and makes no network
 * call: whatever `embed` does is the consumer's. `model` names the space the vectors live in; it is
 * part of the cache key, so a different model never reads another model's vectors.
 */
export interface EmbeddingPort {
  readonly model: string;
  readonly embed: Embed;
}

/** The similarity at or above which a nearest-neighbour branch pair becomes a stage-6 candidate. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.9;

// ── the embedded text ─────────────────────────────────────────────────────

/**
 * What gets embedded for one branch: its lowered form, never its source. Stage 2's neutral names
 * stand for its locals and parameters, so the function's own name and its local names are not in it.
 */
export function embeddingText(branch: LoweredBranch): string {
  const bindings = branch.bindings.map(
    (b) => `${b.local} = ${renderTerm(b.init)}`,
  );
  const path = branch.path.map(renderAtom).join(" ∧ ");
  const outcome = renderOutcome(branch.outcome);
  return [
    ...bindings,
    path === "" ? `⇒ ${outcome}` : `${path} ⇒ ${outcome}`,
  ].join("\n");
}

// ── the vector stage ──────────────────────────────────────────────────────

/** One branch's embedded text and its vector. */
export const BranchVector = z.strictObject({
  text: z.string(),
  vector: z.array(z.number()).min(1),
});

export type BranchVector = z.infer<typeof BranchVector>;

export const EMBED_STAGE = "embed";

const EmbedContent = z.strictObject({ model: z.string().min(1) });

/**
 * A file's embedding input: the model as the content and the file's stage-2 artifact, so the key
 * is the model and the lowered branches' content hash. A second run over the same lowered input
 * under the same model is a `hit` and calls `embed` for nothing.
 */
export function embeddingInput(
  port: EmbeddingPort,
  lowered: StageArtifact<LoweredBranch>,
): StageInput {
  return {
    content: canonicalJson({ model: port.model }),
    artifacts: [lowered],
  };
}

function checkedVectors(
  texts: readonly string[],
  vectors: unknown,
): readonly number[][] {
  const parsed = z.array(z.array(z.number())).safeParse(vectors);
  if (!parsed.success || parsed.data.length !== texts.length)
    throw new TypeError(
      `embed returned ${parsed.success ? parsed.data.length : "no list of"} vectors for ${texts.length} texts; the port returns one number[] per text, in order`,
    );
  const [first] = parsed.data;
  const width = first?.length ?? 0;
  if (width === 0 || parsed.data.some((v) => v.length !== width))
    throw new TypeError(
      "embed returned vectors of differing or zero length; every vector the port returns has one non-zero length",
    );
  if (parsed.data.some((v) => v.some((x) => !Number.isFinite(x))))
    throw new TypeError("embed returned a vector holding a non-finite number");
  return parsed.data;
}

/**
 * The embedding stage over `port`: one fact per known branch of the file's stage-2 artifact, its
 * lowered text and that text's vector. Equal texts are embedded once, in one `embed` call per file.
 */
export function embeddingStage(port: EmbeddingPort): Stage<BranchVector> {
  return {
    name: EMBED_STAGE,
    version: "1",
    run: async (input) => {
      const { model } = EmbedContent.parse(JSON.parse(input.content));
      if (model !== port.model)
        throw new TypeError(
          `the embedding stage runs model "${port.model}", and its input names "${model}"`,
        );
      const [lowered, ...rest] = input.artifacts;
      if (
        lowered === undefined ||
        rest.length > 0 ||
        lowered.stage !== lowerStage.name
      )
        throw new TypeError(
          `the embedding stage reads exactly one "${lowerStage.name}" artifact`,
        );
      const branches = (lowered as StageArtifact<LoweredBranch>).facts.flatMap(
        (fact) =>
          fact.value._tag === "known"
            ? [{ fact, text: embeddingText(fact.value.value) }]
            : [],
      );
      const texts = [...new Set(branches.map((b) => b.text))].sort();
      if (texts.length === 0) return [];
      const vectors = checkedVectors(texts, await port.embed([...texts]));
      const vectorOf = new Map(texts.map((t, i) => [t, vectors[i] ?? []]));
      return branches.map(
        ({ fact, text }): Fact<BranchVector> => ({
          id: fact.id,
          span: fact.span,
          value: {
            _tag: "known",
            value: { text, vector: vectorOf.get(text) ?? [] },
            basis: { _tag: "derived" },
          },
        }),
      );
    },
  };
}

// ── nearest neighbours ────────────────────────────────────────────────────

/** Cosine similarity; a zero vector is similar to nothing. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length)
    throw new TypeError(
      `vectors of length ${a.length} and ${b.length} are from different spaces`,
    );
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** One embedded branch, as the neighbour search reads it. */
export interface EmbeddedBranch {
  readonly branch: string;
  readonly function: string;
  readonly text: string;
  readonly vector: readonly number[];
}

export interface NeighbourPair {
  /** The two branch ids, sorted. */
  readonly branches: readonly [string, string];
  readonly similarity: number;
}

/** A threshold is a cosine similarity: a number in (0, 1]. */
export function similarityThreshold(threshold: number): number {
  if (!(threshold > 0 && threshold <= 1))
    throw new RangeError(
      `a similarity threshold is in (0, 1], not ${threshold}`,
    );
  return threshold;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every branch's nearest neighbour in a different function, kept when their similarity is at or
 * above `threshold`. A tie goes to the lower branch id, so the answer does not depend on input
 * order. Each unordered pair is returned once, sorted.
 */
export function nearestNeighbourPairs(
  branches: readonly EmbeddedBranch[],
  threshold: number,
): readonly NeighbourPair[] {
  const floor = similarityThreshold(threshold);
  const sorted = [...branches].sort((a, b) => byText(a.branch, b.branch));
  const pairs = new Map<string, NeighbourPair>();
  for (const self of sorted) {
    let best: { other: EmbeddedBranch; similarity: number } | null = null;
    for (const other of sorted) {
      if (other.function === self.function) continue;
      const similarity = cosineSimilarity(self.vector, other.vector);
      if (best === null || similarity > best.similarity)
        best = { other, similarity };
    }
    if (best === null || best.similarity < floor) continue;
    const ids = [self.branch, best.other.branch].sort(byText) as [
      string,
      string,
    ];
    pairs.set(canonicalJson(ids), {
      branches: ids,
      similarity: best.similarity,
    });
  }
  return [...pairs.values()].sort((a, b) =>
    byText(canonicalJson(a.branches), canonicalJson(b.branches)),
  );
}

/** A lowered text's content hash, as an embedding cluster's basis names it. */
export const textHash = (text: string): string =>
  contentHash(text).slice(0, 16);
