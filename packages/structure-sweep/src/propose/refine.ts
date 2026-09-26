import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ChangeSet,
  type ConfidenceShare,
  coChangedPairs,
  confidenceShare,
  type Metric,
  type ScoreReport,
  ScoreRow,
  scoreCoChange,
  uniqueRows,
} from "../score/score.js";
import { isFeature, type Vocabulary } from "../vocabulary.js";
import { byCodeUnit } from "./content.js";

/** `|ΔF1|` below this counts toward a plateau. */
export const DEFAULT_THRESHOLD = 0.005;
/** Consecutive runs under the threshold that make a plateau. */
export const DEFAULT_PATIENCE = 2;
/** The stratified part of the sample list, spread evenly over the vocabulary's features. */
export const DEFAULT_SAMPLE = 64;
/** A feature with fewer scored files than this is never a split candidate. */
export const MIN_SPLIT_FILES = 4;

/** A verdict row as `refine` reads it: `score`'s slice plus the vocabulary it was judged under. */
export const RefineRow = ScoreRow.extend({ vocabulary: z.string() });
export type RefineRow = z.infer<typeof RefineRow>;

/** A row of the sweep over the sample: its feature answer carries Jev's probabilities too. */
export const SweptRow = RefineRow.extend({
  answers: z.object({
    feature: z.object({
      choice: z.string(),
      confidence: z.number(),
      probabilities: z.record(z.string(), z.number()),
    }),
  }),
});
export type SweptRow = z.infer<typeof SweptRow>;

/**
 * Where a row stands against the vocabulary being refined. `orphaned`: its choice is no longer a
 * feature, so it is not scored. `stale`: its choice is still a feature but it was judged under
 * another vocabulary, so it is scored and flagged. `current`: neither.
 */
export type Standing = "current" | "stale" | "orphaned";

export const standingOf = (vocabulary: Vocabulary, row: RefineRow): Standing =>
  !isFeature(vocabulary, row.answers.feature.choice)
    ? "orphaned"
    : row.vocabulary === vocabulary.fingerprint
      ? "current"
      : "stale";

/**
 * The verdicts with every swept row laid over the row it re-judged. The judgement is the swept
 * row's; the scope stays the verdict row's, because `sweep --files` records a file's parent folder
 * as its scope and the score pairs files only within one scope.
 */
export function overlay(
  verdicts: readonly RefineRow[],
  swept: readonly RefineRow[],
): RefineRow[] {
  const byPath = new Map(uniqueRows(verdicts).map((r) => [r.path, r]));
  for (const row of uniqueRows(swept)) {
    const was = byPath.get(row.path);
    byPath.set(
      row.path,
      was === undefined ? row : { ...row, scope: was.scope },
    );
  }
  return [...byPath.values()].sort((a, b) => byCodeUnit(a.path, b.path));
}

/** One feature's cohesion: its score row, with the number of scored files it holds. */
export interface FeatureCohesion {
  readonly feature: string;
  readonly files: number;
  readonly precision: Metric;
  readonly recall: Metric;
  readonly f1: Metric;
  readonly confidence: ConfidenceShare;
}

/**
 * Two features whose files change together. `coupling` is `crossPairs` over every co-changed pair
 * touching either feature: 1 means the two only ever change together, 0 that they never do.
 */
export interface MergeCandidate {
  readonly features: readonly [string, string];
  /** Co-changed same-scope pairs with one file in each feature. */
  readonly crossPairs: number;
  /** Co-changed pairs touching either feature, crossing or not. */
  readonly touchingPairs: number;
  readonly coupling: number;
}

/**
 * A feature whose files do not change together. `cohesion` is its precision: of the same-scope file
 * pairs inside it, the share some commit changed together.
 */
export interface SplitCandidate {
  readonly feature: string;
  readonly files: number;
  readonly cohesion: number;
  readonly f1: Metric;
}

/** Two features that were a row's two most probable answers, and how many rows that was. */
export interface Confusion {
  readonly features: readonly [string, string];
  readonly rows: number;
}

/** What the sweep over the sample says, from its rows judged under this vocabulary. */
export interface JevSignals {
  readonly rows: number;
  readonly features: readonly {
    readonly feature: string;
    readonly confidence: ConfidenceShare;
  }[];
  readonly confusion: readonly Confusion[];
}

/** What the diagnostics were read from: co-change alone, or co-change plus a sweep of the sample. */
export type Signals =
  | { readonly basis: "co-change" }
  | { readonly basis: "co-change and jev"; readonly jev: JevSignals };

/** One refine run in the history: the vocabulary it scored and the overall F1 it got. */
export const HistoryEntry = z.strictObject({
  vocabulary: z.string(),
  f1: z.number().nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;
export const History = z.array(HistoryEntry);
export type History = z.infer<typeof History>;

export interface PlateauRule {
  readonly threshold: number;
  readonly patience: number;
}

/**
 * Whether the loop has stopped improving. `streak` counts the trailing runs whose `|ΔF1|` against
 * the run before stayed under `threshold`; `plateaued` is `streak >= patience`. A run with no F1
 * breaks the streak.
 */
export type Plateau = PlateauRule &
  (
    | { readonly state: "first-run" }
    | {
        readonly state: "improving" | "plateaued";
        readonly previousF1: Metric;
        readonly delta: Metric;
        readonly streak: number;
      }
  );

/** The sample list's make-up; the list itself is written beside the report. */
export interface Sample {
  readonly files: number;
  readonly perFeature: number;
  readonly orphaned: number;
  readonly stale: number;
  /** Rows left out because `sweep --files` would refuse the path at `--ref`. */
  readonly unsweepable: number;
}

export interface RefineReport {
  readonly vocabulary: string;
  readonly rows: {
    readonly total: number;
    readonly scored: number;
    readonly stale: number;
    readonly orphaned: number;
  };
  readonly score: Omit<ScoreReport, "features">;
  readonly features: readonly FeatureCohesion[];
  readonly merge: readonly MergeCandidate[];
  readonly split: readonly SplitCandidate[];
  readonly signals: Signals;
  readonly plateau: Plateau;
  readonly sample: Sample;
  readonly staleFiles: readonly string[];
  readonly orphanedFiles: readonly string[];
}

export interface RefineInput extends PlateauRule {
  readonly vocabulary: Vocabulary;
  readonly verdicts: readonly RefineRow[];
  /** The sweep over the sample; absent, the diagnostics are co-change only. */
  readonly swept?: readonly SweptRow[];
  readonly changeSets: readonly ChangeSet[];
  readonly maxFiles: number;
  readonly history: History;
  readonly sampleSize: number;
  /** Whether `sweep --files` accepts `path`. */
  readonly sweepable: (path: string) => boolean;
}

export interface RefineRun {
  readonly report: RefineReport;
  readonly history: History;
  readonly sample: readonly string[];
}

const byPair = (a: readonly [string, string], b: readonly [string, string]) =>
  byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]);

const pairOf = (a: string, b: string): readonly [string, string] =>
  byCodeUnit(a, b) <= 0 ? [a, b] : [b, a];

const tally = <K>(counts: Map<string, [K, number]>, key: string, of: K) =>
  counts.set(key, [of, (counts.get(key)?.[1] ?? 0) + 1]);

function mergeCandidates(
  rows: readonly RefineRow[],
  pairs: readonly (readonly [string, string])[],
): MergeCandidate[] {
  const featureOf = new Map(
    rows.map((r) => [r.path, r.answers.feature.choice]),
  );
  const touching = new Map<string, [string, number]>();
  const crossing = new Map<string, [readonly [string, string], number]>();
  for (const [a, b] of pairs) {
    const [fa, fb] = [featureOf.get(a), featureOf.get(b)];
    if (fa === undefined || fb === undefined) continue;
    for (const f of new Set([fa, fb])) tally(touching, f, f);
    if (fa !== fb) {
      const pair = pairOf(fa, fb);
      tally(crossing, pair.join("\0"), pair);
    }
  }
  const touchingOf = (f: string) => touching.get(f)?.[1] ?? 0;
  return [...crossing.values()]
    .map(([features, crossPairs]): MergeCandidate => {
      const touchingPairs =
        touchingOf(features[0]) + touchingOf(features[1]) - crossPairs;
      return {
        features,
        crossPairs,
        touchingPairs,
        coupling: crossPairs / touchingPairs,
      };
    })
    .sort(
      (a, b) =>
        b.coupling - a.coupling ||
        b.crossPairs - a.crossPairs ||
        byPair(a.features, b.features),
    );
}

function splitCandidates(features: readonly FeatureCohesion[]) {
  return features
    .flatMap((f): SplitCandidate[] =>
      f.files < MIN_SPLIT_FILES || f.precision === null
        ? []
        : [
            {
              feature: f.feature,
              files: f.files,
              cohesion: f.precision,
              f1: f.f1,
            },
          ],
    )
    .sort(
      (a, b) =>
        a.cohesion - b.cohesion ||
        b.files - a.files ||
        byCodeUnit(a.feature, b.feature),
    );
}

/** The two most probable answers, ties broken by key so one row always names one pair. */
function topTwo(probabilities: Readonly<Record<string, number>>) {
  const [first, second] = Object.entries(probabilities).sort(
    ([a, x], [b, y]) => y - x || byCodeUnit(a, b),
  );
  return first === undefined || second === undefined
    ? undefined
    : pairOf(first[0], second[0]);
}

function jevSignals(
  vocabulary: Vocabulary,
  swept: readonly SweptRow[],
): JevSignals {
  const rows = uniqueRows(swept).filter(
    (r) => r.vocabulary === vocabulary.fingerprint,
  );
  const confusion = new Map<string, [readonly [string, string], number]>();
  for (const row of rows) {
    const pair = topTwo(row.answers.feature.probabilities);
    if (pair !== undefined) tally(confusion, pair.join("\0"), pair);
  }
  return {
    rows: rows.length,
    features: featureKeys(vocabulary).map((feature) => ({
      feature,
      confidence: confidenceShare(
        rows.filter((r) => r.answers.feature.choice === feature),
      ),
    })),
    confusion: [...confusion.values()]
      .map(([features, n]): Confusion => ({ features, rows: n }))
      .sort((a, b) => b.rows - a.rows || byPair(a.features, b.features)),
  };
}

const featureKeys = (vocabulary: Vocabulary) =>
  Object.keys(vocabulary.features).sort(byCodeUnit);

/** The history with this run recorded: a run under the last entry's vocabulary replaces it. */
export function recordRun(history: History, entry: HistoryEntry): History {
  const last = history.at(-1);
  return last?.vocabulary === entry.vocabulary
    ? [...history.slice(0, -1), entry]
    : [...history, entry];
}

const deltaOf = (before: Metric, after: Metric): Metric =>
  before === null || after === null ? null : after - before;

export function plateauOf(history: History, rule: PlateauRule): Plateau {
  const last = history.at(-1);
  const previous = history.at(-2);
  if (last === undefined || previous === undefined)
    return { ...rule, state: "first-run" };
  let streak = 0;
  for (let i = history.length - 1; i > 0; i--) {
    const d = deltaOf(
      (history[i - 1] as HistoryEntry).f1,
      (history[i] as HistoryEntry).f1,
    );
    if (d === null || Math.abs(d) >= rule.threshold) break;
    streak++;
  }
  return {
    ...rule,
    state: streak >= rule.patience ? "plateaued" : "improving",
    previousF1: previous.f1,
    delta: deltaOf(previous.f1, last.f1),
    streak,
  };
}

/** An order that depends on the path alone, not on its name's place in the alphabet. */
const shuffled = <R extends { readonly path: string }>(rows: readonly R[]) =>
  rows
    .map((row) => ({
      row,
      key: createHash("sha256").update(row.path).digest("hex"),
    }))
    .sort(
      (a, b) => byCodeUnit(a.key, b.key) || byCodeUnit(a.row.path, b.row.path),
    )
    .map(({ row }) => row);

/**
 * The files to sweep next: every orphaned file first, then for each feature a slice of
 * `⌊size / features⌋` (at least one) of its files, stale ones before current ones, each group in
 * path-hash order. Only paths `sweep --files` accepts are listed.
 */
function stratifiedSample(
  vocabulary: Vocabulary,
  rows: readonly RefineRow[],
  size: number,
  sweepable: (path: string) => boolean,
): { readonly files: string[]; readonly sample: Sample } {
  const listable = rows.filter((r) => sweepable(r.path));
  const standing = (s: Standing) =>
    listable.filter((r) => standingOf(vocabulary, r) === s);
  const keys = featureKeys(vocabulary);
  const perFeature = Math.max(1, Math.floor(size / keys.length));
  const orphaned = shuffled(standing("orphaned"));
  const slices = keys.map((feature) => {
    const of = (s: Standing) =>
      shuffled(standing(s).filter((r) => r.answers.feature.choice === feature));
    return [...of("stale"), ...of("current")].slice(0, perFeature);
  });
  const picked = [...orphaned, ...slices.flat()];
  return {
    files: picked.map((r) => r.path),
    sample: {
      files: picked.length,
      perFeature,
      orphaned: orphaned.length,
      stale: slices.flat().filter((r) => standingOf(vocabulary, r) === "stale")
        .length,
      unsweepable: rows.length - listable.length,
    },
  };
}

function cohesionOf(
  vocabulary: Vocabulary,
  score: ScoreReport,
): FeatureCohesion[] {
  const scored = new Map(score.features.map((f) => [f.feature, f]));
  return featureKeys(vocabulary).map((feature): FeatureCohesion => {
    const f = scored.get(feature);
    return f === undefined
      ? {
          feature,
          files: 0,
          precision: null,
          recall: null,
          f1: null,
          confidence: confidenceShare([]),
        }
      : {
          feature,
          files: f.confidence.rows,
          precision: f.precision,
          recall: f.recall,
          f1: f.f1,
          confidence: f.confidence,
        };
  });
}

/**
 * One refine step over a drafted vocabulary: score its assignment, diagnose what to merge and what
 * to split, record the run and read the plateau, and pick the files to sweep next. Pure — history,
 * change sets and the sweepable test come in; the report, history and sample list go out.
 */
export function refine(input: RefineInput): RefineRun {
  const { vocabulary } = input;
  const rows = overlay(input.verdicts, input.swept ?? []);
  const of = (s: Standing) =>
    rows.filter((r) => standingOf(vocabulary, r) === s);
  const scored = rows.filter((r) => standingOf(vocabulary, r) !== "orphaned");
  const options = { maxFiles: input.maxFiles };
  const scoreReport = scoreCoChange(scored, input.changeSets, options);
  const { features: _perFeature, ...score } = scoreReport;
  const features = cohesionOf(vocabulary, scoreReport);
  const history = recordRun(input.history, {
    vocabulary: vocabulary.fingerprint,
    f1: score.f1,
  });
  const { files, sample } = stratifiedSample(
    vocabulary,
    rows,
    input.sampleSize,
    input.sweepable,
  );
  const staleFiles = of("stale").map((r) => r.path);
  const orphanedFiles = of("orphaned").map((r) => r.path);
  return {
    report: {
      vocabulary: vocabulary.fingerprint,
      rows: {
        total: rows.length,
        scored: scored.length,
        stale: staleFiles.length,
        orphaned: orphanedFiles.length,
      },
      score,
      features,
      merge: mergeCandidates(
        scored,
        coChangedPairs(scored, input.changeSets, options).pairs,
      ),
      split: splitCandidates(features),
      signals:
        input.swept === undefined
          ? { basis: "co-change" }
          : {
              basis: "co-change and jev",
              jev: jevSignals(vocabulary, input.swept),
            },
      plateau: plateauOf(history, {
        threshold: input.threshold,
        patience: input.patience,
      }),
      sample,
      staleFiles,
      orphanedFiles,
    },
    history,
    sample: files,
  };
}
