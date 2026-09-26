import { posix } from "node:path";
import { z } from "zod";
import { CONFIDENCE_FLOOR } from "../move/plan.js";

/** The slice of a `sweep` verdict row `score` reads. */
export const ScoreRow = z.object({
  path: z.string(),
  scope: z.string(),
  answers: z.object({
    feature: z.object({ choice: z.string(), confidence: z.number() }),
  }),
});
export type ScoreRow = z.infer<typeof ScoreRow>;

/** The files one commit touched, repo-relative. */
export type ChangeSet = readonly string[];

/** A ratio whose denominator was zero is `null`, never `NaN`. */
export type Metric = number | null;

export interface Prf {
  readonly precision: Metric;
  readonly recall: Metric;
  readonly f1: Metric;
}

/** Rows judged at or above the floor, out of all rows. */
export interface ConfidenceShare {
  readonly confident: number;
  readonly rows: number;
  readonly share: Metric;
}

export interface FeatureScore extends Prf {
  readonly feature: string;
  readonly confidence: ConfidenceShare;
}

export interface ScoreReport extends Prf {
  /** Change sets left after the 2..maxFiles cut. */
  readonly changeSets: number;
  /** Labelled files touched by at least one kept change set. */
  readonly files: number;
  readonly floor: number;
  readonly confidence: ConfidenceShare;
  /** The same score with each file's leaf folder as its label. */
  readonly baseline: Prf;
  readonly features: readonly FeatureScore[];
}

export interface ScoreOptions {
  /** Change sets with more labelled files than this are dropped (default 40). */
  readonly maxFiles?: number;
}

const ratio = (n: number, d: number): Metric => (d === 0 ? null : n / d);

function prf(hits: number, predicted: number, actual: number): Prf {
  const precision = ratio(hits, predicted);
  const recall = ratio(hits, actual);
  const f1 =
    precision === null || recall === null
      ? null
      : ratio(2 * precision * recall, precision + recall);
  return { precision, recall, f1 };
}

/** Rows at or above `CONFIDENCE_FLOOR`, out of `rows`. */
export function confidenceShare(rows: readonly ScoreRow[]): ConfidenceShare {
  const confident = rows.filter(
    (r) => r.answers.feature.confidence >= CONFIDENCE_FLOOR,
  ).length;
  return { confident, rows: rows.length, share: ratio(confident, rows.length) };
}

const pairsIn = (n: number) => (n * (n - 1)) / 2;

/** Same-scope pairs among `files` that share a label. */
function predictedPairs(
  files: Iterable<string>,
  scopeOf: ReadonlyMap<string, string>,
  labelOf: (path: string) => string | undefined,
): number {
  const groups = new Map<string, number>();
  for (const f of files) {
    const key = `${scopeOf.get(f)}\0${labelOf(f)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.values()].reduce((sum, n) => sum + pairsIn(n), 0);
}

/** One row per path, the last one winning, as the verdict file itself keys them. */
export const uniqueRows = <R extends ScoreRow>(rows: readonly R[]): R[] => [
  ...new Map(rows.map((r) => [r.path, r])).values(),
];

/** The change sets a score reads, and every same-scope file pair at least one of them touched. */
export interface CoChange {
  /** Each change set cut to labelled paths, sorted, kept only when it holds 2..maxFiles of them. */
  readonly changeSets: readonly ChangeSet[];
  /** Each co-changed pair once, `a < b`, both files in one `scope`. */
  readonly pairs: readonly (readonly [string, string])[];
}

/**
 * The co-change `scoreCoChange` grades against: the kept change sets and the same-scope pairs they
 * touched. Exported so a diagnostic over the same assignment reads the pairs the score read.
 */
export function coChangedPairs(
  rows: readonly ScoreRow[],
  changeSets: readonly ChangeSet[],
  options: ScoreOptions = {},
): CoChange {
  const maxFiles = options.maxFiles ?? 40;
  const scopeOf = new Map(uniqueRows(rows).map((r) => [r.path, r.scope]));
  const kept = changeSets
    .map((set) => [...new Set(set.filter((p) => scopeOf.has(p)))].sort())
    .filter((set) => set.length >= 2 && set.length <= maxFiles);
  const cochanged = new Map<string, readonly [string, string]>();
  for (const set of kept) {
    for (let i = 0; i < set.length; i++) {
      for (let j = i + 1; j < set.length; j++) {
        const [a, b] = [set[i] as string, set[j] as string];
        if (scopeOf.get(a) === scopeOf.get(b))
          cochanged.set(`${a}\0${b}`, [a, b]);
      }
    }
  }
  return { changeSets: kept, pairs: [...cochanged.values()] };
}

/**
 * Grade a file-to-feature assignment against the change sets it has to explain: files in one feature
 * should change together. Only pairs of files in the same `scope` count. Pure — the history comes in
 * as change sets, see `readChangeSets`.
 */
export function scoreCoChange(
  rows: readonly ScoreRow[],
  changeSets: readonly ChangeSet[],
  options: ScoreOptions = {},
): ScoreReport {
  const unique = uniqueRows(rows);
  const scopeOf = new Map(unique.map((r) => [r.path, r.scope]));
  const labels = new Map(unique.map((r) => [r.path, r.answers.feature.choice]));
  const featureOf = (p: string) => labels.get(p);
  const { changeSets: kept, pairs } = coChangedPairs(
    unique,
    changeSets,
    options,
  );
  const active = new Set(kept.flat());

  const overall = (labelOf: (p: string) => string | undefined) =>
    prf(
      pairs.filter(([a, b]) => labelOf(a) === labelOf(b)).length,
      predictedPairs(active, scopeOf, labelOf),
      pairs.length,
    );

  const features = [...new Set(labels.values())]
    .sort()
    .map((feature): FeatureScore => {
      const inF = (p: string) => featureOf(p) === feature;
      const touching = pairs.filter(([a, b]) => inF(a) || inF(b));
      const inside = touching.filter(([a, b]) => inF(a) && inF(b)).length;
      return {
        feature,
        ...prf(
          inside,
          predictedPairs([...active].filter(inF), scopeOf, () => feature),
          touching.length,
        ),
        confidence: confidenceShare(
          unique.filter((r) => r.answers.feature.choice === feature),
        ),
      };
    });

  return {
    changeSets: kept.length,
    files: active.size,
    floor: CONFIDENCE_FLOOR,
    ...overall(featureOf),
    confidence: confidenceShare(unique),
    baseline: overall((p) => posix.dirname(p)),
    features,
  };
}
