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
import { SourceSpan } from "./fact.js";

const JevStateSchema = z.union([
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const GoldFile = z.strictObject({
  /** The stage this gold set scores. */
  stage: z.string().min(1),
  /** Other wordings of the stage question's `instructions`; each is asked beside the original. */
  rewordings: z
    .array(z.string().trim().min(1))
    .min(1, "name at least one rewording; flip rate needs two wordings"),
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        span: SourceSpan,
        state: JevStateSchema,
        /** The hand-labelled answer: one of the question's criteria keys. */
        gold: z.string(),
      }),
    )
    .min(1, "a gold set holds at least one item"),
});

export interface GoldItem<K extends string> {
  readonly id: string;
  readonly span: SourceSpan;
  readonly state: JevState;
  readonly gold: K;
}

export interface GoldSet<K extends string> {
  readonly stage: string;
  readonly rewordings: readonly string[];
  readonly items: readonly GoldItem<K>[];
}

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
  return {
    stage: parsed.data.stage,
    rewordings: parsed.data.rewordings,
    items,
  };
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

export interface Scored {
  readonly confidence: number;
  readonly correct: boolean;
}

/**
 * Expected calibration error: answers bucketed into `bins` equal-width confidence bins, then the
 * gap between each bin's mean confidence and its accuracy, weighted by the bin's share of answers.
 */
export function expectedCalibrationError(
  answers: readonly Scored[],
  bins = 10,
): number {
  if (answers.length === 0) return 0;
  const buckets = Array.from({ length: bins }, () => ({
    n: 0,
    confidence: 0,
    correct: 0,
  }));
  for (const { confidence, correct } of answers) {
    const bucket =
      buckets[Math.min(bins - 1, Math.max(0, Math.floor(confidence * bins)))];
    if (bucket === undefined) continue;
    bucket.n += 1;
    bucket.confidence += confidence;
    bucket.correct += correct ? 1 : 0;
  }
  return buckets.reduce(
    (ece, b) =>
      b.n === 0
        ? ece
        : ece +
          (b.n / answers.length) *
            Math.abs(b.correct / b.n - b.confidence / b.n),
    0,
  );
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
  readonly accuracy: number;
  readonly flipRate: number;
  readonly ece: number;
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
  readonly bins?: number;
}

/** Ask every gold item under every wording, then score flip rate and ECE against the gold labels. */
export async function evaluate<K extends string>(
  options: EvaluateOptions<K>,
): Promise<Evaluation<K>> {
  const { question, gold } = options;
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
    for (const ask of askers) answers.push(await ask(item.state));
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
    ece: expectedCalibrationError(scored, options.bins),
    flipRate: flipRate(items.map((i) => i.answers.map((a) => a.label))),
  };
  return {
    stage: gold.stage,
    items,
    accuracy: scored.filter((s) => s.correct).length / scored.length,
    ...measured,
    verdict: shipVerdict(measured, options.thresholds),
  };
}
