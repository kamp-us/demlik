// Type-level test for the Jev protocol's one compile-time claim (#216):
// a choice question's `criteria` keys ARE its answer's `choice` domain.
// Compiled by `pnpm typecheck` (tsc over `src/**` INCLUDES `*.test-d.ts`) and
// again by `pnpm typecheck:test`. Every `@ts-expect-error` MUST sit on a line
// that genuinely fails to type-check; every undirected line must compile.

import {
  type JevAnswers,
  type JevChoiceAnswer,
  type JevNoulAnswer,
  type JevScoreAnswer,
  jevQuestions,
  parseAnswers,
} from "./index";

const questions = jevQuestions({
  category: {
    type: "choice",
    instructions: "Which budget line is this transaction?",
    criteria: {
      groceries: "Supermarkets, corner shops, food delivery",
      dining: "Restaurants, cafes, bars",
    },
  },
  frustration: {
    type: "score",
    instructions: "How frustrated is the customer?",
    criteria: ["Calm", "Frustrated", "Very angry"],
  },
  is_urgent: {
    type: "noul",
    instructions: "Does this convey urgency?",
  },
});

type Qs = typeof questions;
type As = JevAnswers<Qs>;

// ── 1. the choice union arrives at the call site ───────────────────────────

const category: JevChoiceAnswer<"groceries" | "dining"> = {
  type: "choice",
  choice: "groceries",
  probabilities: { groceries: 0.9, dining: 0.1 },
  confidence: 0.82,
};

// `JevAnswers` maps the question to exactly that answer.
const fromMap: As["category"] = category;

// `"dining"` is in the union.
const dining: As["category"]["choice"] = "dining";

// @ts-expect-error — `"other"` is not one of the criteria keys.
const other: As["category"]["choice"] = "other";

// `probabilities` is total over the criteria keys, not a bare string map.
const widened: As["category"]["probabilities"] = {
  groceries: 0.9,
  dining: 0.05,
  // @ts-expect-error — `other` is not an option, so it cannot carry a probability.
  other: 0.05,
};

// ── 2. the other two question types map to their own answers ───────────────

const frustration: JevScoreAnswer = {
  type: "score",
  score: 1.05,
  legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
  probabilities: { "0": 0.0, "1": 0.95, "2": 0.05 },
  confidence: 0.92,
};
const scored: As["frustration"] = frustration;

const urgent: JevNoulAnswer = { type: "noul", noul: 0.95 };
const nouled: As["is_urgent"] = urgent;

// A score answer is not a choice answer.
// @ts-expect-error — the discriminant disagrees.
const crossed: As["frustration"] = urgent;

// ── 3. the union survives `parseAnswers` ───────────────────────────────────

const parsed = parseAnswers(questions, {} as unknown);
if (parsed.ok) {
  const narrowed: "groceries" | "dining" = parsed.answers.category.choice;
  const confidence: number = parsed.answers.frustration.confidence;
  const yes: number = parsed.answers.is_urgent.noul;
  void narrowed;
  void confidence;
  void yes;
} else {
  // `JevErr` is closed and `_tag`-discriminated.
  const tag: string = parsed.error._tag;
  void tag;
}

// ── 4. a Score needs at least two levels ───────────────────────────────────

jevQuestions({
  // @ts-expect-error — one level is not a Score rubric.
  lonely: { type: "score", instructions: "?", criteria: ["Only"] },
});

void fromMap;
void dining;
void other;
void widened;
void scored;
void nouled;
void crossed;
