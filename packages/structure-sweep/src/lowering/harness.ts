import { readFileSync } from "node:fs";
import type { JevState } from "@demlik/tea/jev";
import { z } from "zod";
import type { JevClient } from "../jev.js";
import {
  askVerdict,
  type ChoiceQuestion,
  type ChoiceQuestions,
  type Judgement,
  labelsOf,
} from "./ask.js";
import {
  assertBins,
  assertConfidence,
  type Calibration,
  calibrate,
  expectedCalibrationError,
} from "./calibration.js";
import { SourceSpan } from "./fact.js";
import { decide, gatePolicy } from "./gate.js";

const JevStateSchema = z.union([
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const GoldFile = z.strictObject({
  /** The stage this gold set scores. */
  stage: z.string().min(1),
  /** Other wordings of the stage question's `instructions`; each is asked beside the original. */
  rewordings: z.array(z.string().trim().min(1)),
  items: z.array(
    z.strictObject({
      id: z.string().min(1),
      span: SourceSpan,
      state: JevStateSchema,
      /** The hand-labelled answer: one of the question's criteria keys. */
      gold: z.string(),
    }),
  ),
});

export interface GoldItem<K extends string> {
  readonly id: string;
  readonly span: SourceSpan;
  readonly state: JevState;
  readonly gold: K;
}

type NonEmpty<T> = readonly [T, ...T[]];

/** At least one item, and at least one rewording beside the question's own wording: a flip needs two. */
export interface GoldSet<K extends string> {
  readonly stage: string;
  readonly rewordings: NonEmpty<string>;
  readonly items: NonEmpty<GoldItem<K>>;
}

const nonEmpty = <T>(xs: readonly T[]): NonEmpty<T> | undefined => {
  const [first, ...rest] = xs;
  return first === undefined ? undefined : [first, ...rest];
};

export class GoldSetError extends Error {}

/** Parse a gold file, refusing a label outside `labels` and a repeated item id. */
export function parseGoldSet<K extends string>(
  raw: unknown,
  labels: readonly K[],
  source = "gold set",
): GoldSet<K> {
  const parsed = GoldFile.safeParse(raw);
  if (!parsed.success)
    throw goldSetError(
      source,
      parsed.error.issues.map(
        (i) =>
          `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`,
      ),
    );
  const isLabel = (label: string): label is K =>
    (labels as readonly string[]).includes(label);
  const problems: string[] = [];
  const items: GoldItem<K>[] = [];
  const seen = new Set<string>();
  parsed.data.items.forEach((item, n) => {
    if (seen.has(item.id))
      problems.push(`items.${n}.id: "${item.id}" appears twice`);
    seen.add(item.id);
    const { gold } = item;
    if (isLabel(gold)) items.push({ ...item, gold });
    else
      problems.push(
        `items.${n}.gold: "${gold}" is not one of ${labels.join(", ")}`,
      );
  });
  if (problems.length > 0) throw goldSetError(source, problems);
  return goldSet(parsed.data.stage, parsed.data.rewordings, items, source);
}

/**
 * The one runtime check behind `GoldSet`'s non-empty types, for a set built by a caller the type
 * system does not reach. An empty set scores ECE 0 and flip rate 0 on no answers, and a set with no
 * rewording can never flip, so either would read `shippable` on no evidence.
 */
function goldSet<K extends string>(
  stage: string,
  rewordings: readonly string[],
  items: readonly GoldItem<K>[],
  source: string,
): GoldSet<K> {
  const wordings = nonEmpty(rewordings);
  const labelled = nonEmpty(items);
  if (wordings !== undefined && labelled !== undefined)
    return { stage, rewordings: wordings, items: labelled };
  throw goldSetError(source, [
    ...(wordings === undefined
      ? [
          "rewordings: name at least one rewording; flip rate needs two wordings",
        ]
      : []),
    ...(labelled === undefined
      ? ["items: a gold set holds at least one item"]
      : []),
  ]);
}

const goldSetError = (source: string, problems: readonly string[]) =>
  new GoldSetError(
    `${source} is not a valid gold set:\n${problems.map((p) => `  ${p}`).join("\n")}`,
  );

export function loadGoldSet<K extends string>(
  file: string,
  labels: readonly K[],
): GoldSet<K> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new GoldSetError(
      `${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return parseGoldSet(raw, labels, file);
}

/** The share of items whose label is not the same under every wording. Each row is one item's labels. */
export function flipRate(
  labelsPerItem: readonly (readonly string[])[],
): number {
  if (labelsPerItem.length === 0) return 0;
  const flipped = labelsPerItem.filter((labels) =>
    labels.some((label) => label !== labels[0]),
  ).length;
  return flipped / labelsPerItem.length;
}

export interface Thresholds {
  readonly ece: number;
  readonly flipRate: number;
}

export interface Exceeded {
  readonly metric: keyof Thresholds;
  readonly value: number;
  readonly threshold: number;
}

/** A stage ships only when it is calibrated and stable, never merely confident. */
export type ShipVerdict =
  | { readonly _tag: "shippable" }
  | {
      readonly _tag: "not-shippable";
      readonly exceeded: readonly [Exceeded, ...Exceeded[]];
    };

export function shipVerdict(
  measured: Thresholds,
  thresholds: Thresholds,
): ShipVerdict {
  const exceeded = (["ece", "flipRate"] as const)
    .filter((metric) => !(measured[metric] < thresholds[metric]))
    .map((metric) => ({
      metric,
      value: measured[metric],
      threshold: thresholds[metric],
    }));
  const [first, ...rest] = exceeded;
  return first === undefined
    ? { _tag: "shippable" }
    : { _tag: "not-shippable", exceeded: [first, ...rest] };
}

export interface ItemScore<K extends string> {
  readonly id: string;
  readonly gold: K;
  /** One answer per wording: the question's own `instructions` first, then each rewording in order. */
  readonly answers: readonly Judgement<K>[];
  readonly flipped: boolean;
}

export interface Evaluation<K extends string> {
  readonly stage: string;
  readonly items: readonly ItemScore<K>[];
  /** Share of all answers, under every wording, that matched the gold label. */
  readonly accuracy: number;
  readonly flipRate: number;
  readonly ece: number;
  /** Accuracy by confidence band, and the floor derived from it against the stated target. */
  readonly calibration: Calibration;
  /** Share of items the gate would promote on the first ask: the question's own wording at the floor. */
  readonly coverage: number;
  /** Share of items that answer falls below the floor for, so the gate would not promote them. */
  readonly abstainRate: number;
  readonly verdict: ShipVerdict;
}

export interface EvaluateOptions<K extends string> {
  readonly question: ChoiceQuestion<K>;
  readonly gold: GoldSet<K>;
  /** A client for one wording of the question; a test hands back a stub, a run an `httpJevClient`. */
  readonly connect: (
    questions: ChoiceQuestions<K>,
  ) => JevClient<ChoiceQuestions<K>>;
  readonly thresholds: Thresholds;
  /** The accuracy the derived floor must guarantee in every band at or above it, in [0, 1]. */
  readonly target: number;
  readonly bins?: number;
}

/**
 * Ask every gold item under every wording, then score flip rate, ECE and accuracy against the gold
 * labels, derive the stage's floor, and report the coverage and abstain rate that floor gives.
 */
export async function evaluate<K extends string>(
  options: EvaluateOptions<K>,
): Promise<Evaluation<K>> {
  const { question, target, bins = 10 } = options;
  const gold = goldSet(
    options.gold.stage,
    options.gold.rewordings,
    options.gold.items,
    options.gold.stage,
  );
  assertBins(bins);
  if (!(target >= 0 && target <= 1))
    throw new RangeError(`a target accuracy is in [0, 1], not ${target}`);
  const labels = labelsOf(question);
  for (const item of gold.items)
    if (!labels.includes(item.gold))
      throw new GoldSetError(
        `${gold.stage}: item ${item.id}'s gold "${item.gold}" is not one of the question's labels`,
      );
  const askers = [question.instructions, ...gold.rewordings].map(
    (instructions) =>
      askVerdict(options.connect({ verdict: { ...question, instructions } })),
  );
  const items: ItemScore<K>[] = [];
  for (const item of gold.items) {
    const answers: Judgement<K>[] = [];
    for (const ask of askers) {
      const answer = await ask(item.state);
      assertConfidence(answer.confidence);
      answers.push(answer);
    }
    items.push({
      id: item.id,
      gold: item.gold,
      answers,
      flipped: answers.some((a) => a.label !== answers[0]?.label),
    });
  }
  const scored = items.flatMap((item) =>
    item.answers.map((a) => ({
      confidence: a.confidence,
      correct: a.label === item.gold,
    })),
  );
  const measured = {
    ece: expectedCalibrationError(scored, bins),
    flipRate: flipRate(items.map((i) => i.answers.map((a) => a.label))),
  };
  const calibration = calibrate(scored, { target, bins });
  const coverage = promotedShare(items, calibration);
  return {
    stage: gold.stage,
    items,
    accuracy: scored.filter((s) => s.correct).length / scored.length,
    ...measured,
    calibration,
    coverage,
    abstainRate: 1 - coverage,
    verdict: shipVerdict(measured, options.thresholds),
  };
}

/** The gate's own first-ask decision over each item's original-wording answer, at the derived floor. */
function promotedShare<K extends string>(
  items: readonly ItemScore<K>[],
  calibration: Calibration,
): number {
  if (calibration._tag === "unreachable") return 0;
  const policy = gatePolicy({ calibration, maxRounds: 0 });
  const promoted = items.filter((item) => {
    const [first] = item.answers;
    return first !== undefined && decide(policy, 0, first)._tag === "promoted";
  }).length;
  return promoted / items.length;
}
