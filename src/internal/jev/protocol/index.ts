/**
 * @packageDocumentation
 * internal/jev/protocol — the wire contract of TypeSafe **Jev** (System One)
 * as types plus two pure functions, and nothing that performs I/O. Internal
 * since #216 — not published on any subpath; the `ask` child that opens the
 * socket imports it from here.
 *
 * The contract is transcribed from `https://docs.typesafe.ai/api`, re-verified
 * 2026-09-21: `POST https://api.typesafe.ai/v1/systemone`, `Authorization:
 * Bearer <API_KEY>`, request `{ state, model, questions }`, response
 * `{ model, answers, usage }`. Where this module and that page disagree, the
 * page is right and this module is a bug.
 *
 * ## What this module is for
 *
 * A Jev call is a map of questions you name, and an answer comes back under
 * each name. That is a shape TypeScript can hold onto, and the whole point of
 * typing it here is that a **choice** question's `criteria` keys ARE its
 * answer's `choice` domain — write the rubric once and the narrowing is free
 * at the call site:
 *
 * ```ts
 * const qs = jevQuestions({
 *   category: {
 *     type: "choice",
 *     instructions: "Which budget line is this?",
 *     criteria: { groceries: "Supermarkets", dining: "Restaurants" },
 *   },
 * });
 * // parsed.answers.category.choice : "groceries" | "dining"
 * ```
 *
 * `jevQuestions` is an identity function with a `const` type parameter; it
 * exists so the literal keys survive inference without every call site
 * spelling `as const`. `JevAnswers<Q>` is the mapped type that turns such a
 * questions map into its answers map.
 *
 * ## Why parsing is a pure function returning data
 *
 * `parseAnswers` never throws — a response that disagrees with the questions
 * that produced it is a recoverable failure with an obvious next move (retry,
 * re-prompt, give up on this one item), so it is DATA: a closed `JevErr`
 * union of `{ _tag }` values that survives a JSON round-trip into Model
 * (ADR 0011). The type-level guarantee above is a *claim about the wire*, and
 * `parseAnswers` is the one place that claim is checked against a body the
 * network actually produced. Every `unknown` reaches a `JevErr`; nothing
 * reaches a `throw`.
 *
 * The check itself is a `zod` schema DERIVED from the questions map, so the
 * typed value is what `safeParse` returns rather than something asserted after
 * a hand-walk. Both halves of a choice question's claim are structural in that
 * schema: `choice` is a `z.enum` over the criteria keys, and `probabilities`
 * is a strict `z.object` whose shape IS those keys — so a distribution missing
 * one or carrying an extra fails the schema rather than a separate arm a later
 * reader has to remember. A partial distribution typed `Record<K, number>` is
 * the representable-invalid state this module exists to refuse, and it arrives
 * through this gate or not at all. The envelope is checked by the same schema:
 * `model` is a string and `usage` carries two finite numbers.
 *
 * `safeParse`, never `parse`: a zod failure is turned into a `JevErr` value by
 * mapping its first issue's path onto the arm that names it.
 *
 * ## Why status classification lives here and not in `ask`
 *
 * "429 and 529 back off, everything else non-2xx is terminal" is a fact about
 * the protocol, published in the same reference page as the body shapes, and
 * `ask` re-deriving it is how the retry policy and the wire contract drift
 * apart. `classifyStatus` is the single reading.
 *
 * ## Bounds the API enforces and this module does not
 *
 * A Choice takes at most 255 options and a Score takes at most 10 levels.
 * `JevScoreQuestion` encodes the *lower* bound — a Score with fewer than two
 * levels does not compile — because a two-element minimum is a tuple, which
 * costs nothing. The upper bounds are not encoded: spelling them as a union
 * of nine tuple arities (or 255 of them) buys a compile error in place of a
 * `422`, at the price of unreadable diagnostics on every ordinary Score. They
 * are the API's `422`, which `classifyStatus` already calls terminal.
 */

import { z } from "zod";

// ── the shared instruction / description slot ──────────────────────────────

/**
 * What every `instructions` and every criterion description accepts.
 *
 * The reference page allows a string, an object, or an array in all three
 * slots: a long question carrying data it refers to is written as an object
 * with the question in one field and the data in the others. Typing it as
 * `string` alone would reject the documented structured form.
 */
export type JevText =
  | string
  | Readonly<Record<string, unknown>>
  | readonly unknown[];

// ── questions ──────────────────────────────────────────────────────────────

/** The three question types, as the `type` discriminant spells them. */
export type JevQuestionType = "choice" | "score" | "noul";

/**
 * A choice question's rubric: option key → description, or `null` where an
 * option needs no extra detail. The keys are the answer's `choice` domain.
 */
export type JevChoiceCriteria = Readonly<Record<string, JevText | null>>;

/** Pick one option from a set you define. */
export interface JevChoiceQuestion<
  C extends JevChoiceCriteria = JevChoiceCriteria,
> {
  readonly type: "choice";
  readonly instructions: JevText;
  readonly criteria: C;
}

/**
 * A score question's rubric: an ORDERED list of level descriptions, at least
 * two of them. The API accepts up to ten.
 */
export type JevScoreCriteria = readonly [JevText, JevText, ...JevText[]];

/** Rate the state along an ordered rubric. */
export interface JevScoreQuestion {
  readonly type: "score";
  readonly instructions: JevText;
  readonly criteria: JevScoreCriteria;
}

/** A yes/no question. `criteria` is optional; both arms are required when it is present. */
export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions: JevText;
  readonly criteria?: {
    readonly true: JevText;
    readonly false: JevText;
  };
}

/** One typed question. */
export type JevQuestion =
  | JevChoiceQuestion
  | JevScoreQuestion
  | JevNoulQuestion;

/** The `questions` map: an id you choose → the question asked under it. */
export type JevQuestionMap = Readonly<Record<string, JevQuestion>>;

/**
 * Identity, with the literal keys kept.
 *
 * The `const` type parameter is the whole function: it preserves each choice
 * question's `criteria` keys as literals, so `JevAnswers<typeof qs>` can name
 * them. Without it the inferred type is `Record<string, string>` and the
 * narrowing this module exists for is gone before `parseAnswers` is reached.
 */
export const jevQuestions = <const Q extends JevQuestionMap>(questions: Q): Q =>
  questions;

// ── the request ────────────────────────────────────────────────────────────

/** The evaluation endpoint. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone" as const;

/** The content to evaluate: text, or structured data. */
export type JevState =
  | string
  | Readonly<Record<string, unknown>>
  | readonly unknown[];

/** The request body of `POST /v1/systemone`. */
export interface JevRequest<Q extends JevQuestionMap = JevQuestionMap> {
  readonly state: JevState;
  readonly model: string;
  readonly questions: Q;
}

// ── answers ────────────────────────────────────────────────────────────────

/** The yes/no answer, on a scale from 0 (no) to 1 (yes). */
export interface JevNoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

/**
 * The chosen option and the full distribution over the options.
 *
 * `K` is the choice question's own criteria keys, which is why `choice` is a
 * union rather than a `string` and `probabilities` is total over the options.
 */
export interface JevChoiceAnswer<K extends string = string> {
  readonly type: "choice";
  readonly choice: K;
  readonly probabilities: Readonly<Record<K, number>>;
  readonly confidence: number;
}

/**
 * The probability-weighted value across the levels — it can land BETWEEN
 * levels, which is why `score` is a `number` and not an index. `legend` and
 * `probabilities` are keyed by the level index as a string.
 */
export interface JevScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

/** One typed answer. */
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

/** The answer a given question type yields, with the choice union carried through. */
export type JevAnswerFor<Q> = Q extends {
  readonly type: "choice";
  readonly criteria: infer C;
}
  ? JevChoiceAnswer<Extract<keyof C, string>>
  : Q extends { readonly type: "score" }
    ? JevScoreAnswer
    : Q extends { readonly type: "noul" }
      ? JevNoulAnswer
      : never;

/** A questions map turned into its answers map, id for id. */
export type JevAnswers<Q extends JevQuestionMap> = {
  readonly [K in keyof Q]: JevAnswerFor<Q[K]>;
};

/** Token usage for the request. */
export interface JevUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** The response body of `POST /v1/systemone`. */
export interface JevResponse<Q extends JevQuestionMap = JevQuestionMap> {
  readonly model: string;
  readonly answers: JevAnswers<Q>;
  readonly usage: JevUsage;
}

// ── failures are data ──────────────────────────────────────────────────────

/**
 * Every way a response can fail to be the answers to the questions asked.
 *
 * Closed, `{ _tag }`-discriminated, JSON-round-trippable: a consumer folds one
 * of these into Model and routes on `_tag` (ADR 0011). `path` and `id` say
 * WHERE, so a failure names the question it is about rather than the whole
 * call.
 */
export type JevErr =
  /** The envelope is not a Jev response at all — not an object, or `model` /
   *  `answers` / `usage` missing or of the wrong shape. */
  | { readonly _tag: "malformed_body"; readonly reason: string }
  /** A question id in the request has no answer under it in the response. */
  | { readonly _tag: "missing_answer"; readonly id: string }
  /** An answer arrived, but its `type` is not its question's. */
  | {
      readonly _tag: "answer_type_mismatch";
      readonly id: string;
      readonly expected: JevQuestionType;
      readonly received: string;
    }
  /** A choice answer picked something that is not one of its criteria keys. */
  | {
      readonly _tag: "off_criteria_choice";
      readonly id: string;
      readonly choice: string;
      readonly options: readonly string[];
    }
  /** A choice answer's `probabilities` keys are not exactly its question's
   *  criteria keys. `JevChoiceAnswer<K>` types that map as TOTAL over `K`, so
   *  a partial or off-criteria one is the representable-invalid state this
   *  module exists to refuse. `missing` and `extra` say which way it failed. */
  | {
      readonly _tag: "off_criteria_probabilities";
      readonly id: string;
      readonly missing: readonly string[];
      readonly extra: readonly string[];
      readonly options: readonly string[];
    }
  /** The answer's `type` is right and its payload is not — a missing
   *  `confidence`, a `probabilities` that is not a number map, and so on. */
  | {
      readonly _tag: "malformed_answer";
      readonly id: string;
      readonly reason: string;
    };

/**
 * The tags {@link JevErr} is closed over, witnessed against the union.
 *
 * The `satisfies` is the point: it is the compiler checking this record's keys
 * against `JevErr["_tag"]` in BOTH directions — a union arm with no entry here
 * fails totality, and an entry naming no arm fails the excess-property check
 * on the literal. Before it, the set was `ReadonlySet<string>` and a new arm
 * was tied to its runtime guard by reviewer attention alone: omit the entry
 * and {@link isJevErr} silently answers `false` for that arm forever.
 */
const JEV_ERR_TAG_WITNESS = {
  malformed_body: true,
  missing_answer: true,
  answer_type_mismatch: true,
  off_criteria_choice: true,
  off_criteria_probabilities: true,
  malformed_answer: true,
} as const satisfies Record<JevErr["_tag"], true>;

/**
 * The membership set {@link isJevErr} tests against — the single reading of
 * the union's tags, so nothing downstream re-derives it from a `"_tag" in x`
 * test.
 */
const JEV_ERR_TAGS: ReadonlySet<JevErr["_tag"]> = new Set(
  Object.keys(JEV_ERR_TAG_WITNESS) as readonly JevErr["_tag"][],
);

/**
 * Is `value` a {@link JevErr}?
 *
 * The discriminant is the `_tag` VALUE against the closed set above, never the
 * bare presence of the key. A `JevAnswers` map is keyed by the caller's own
 * question ids, so a caller may legally name a question `_tag` — and then
 * `"_tag" in answers` is `true`. The value under it is an ANSWER, which is
 * always an object and never one of these string literals, so reading the
 * value is the one test a caller's id space cannot reach.
 */
export function isJevErr(value: object): value is JevErr {
  if (!("_tag" in value)) return false;
  const tag: unknown = (value as { readonly _tag: unknown })._tag;
  // The set is keyed over the union's tags, and the question being asked is
  // whether an arbitrary string is one of them — a read-only widening, sound
  // because `has` only ever reads.
  const tags: ReadonlySet<string> = JEV_ERR_TAGS;
  return typeof tag === "string" && tags.has(tag);
}

/** What `parseAnswers` returns: typed answers, or one `JevErr`. Never a throw. */
export type JevParse<Q extends JevQuestionMap> =
  | {
      readonly ok: true;
      readonly answers: JevAnswers<Q>;
      readonly model: string;
      readonly usage: JevUsage;
    }
  | { readonly ok: false; readonly error: JevErr };

// ── parsing ────────────────────────────────────────────────────────────────

type Obj = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The value under `key`, or `undefined` where there is no object to read. */
const at = (value: unknown, key: string): unknown =>
  isObj(value) ? value[key] : undefined;

const err = (
  error: JevErr,
): { readonly ok: false; readonly error: JevErr } => ({
  ok: false,
  error,
});

// ── the schema the questions derive ────────────────────────────────

/** A finite number: the wire carries no `NaN` and no infinity. */
const finite = z.number().finite();

/**
 * The schema of one answer, built from the question that asked for it.
 *
 * Key order is load-bearing — zod reports issues in shape order and
 * {@link toJevErr} maps the FIRST one, so this order is the precedence between
 * two arms that could both fire on one answer.
 */
const answerSchema = (question: JevQuestion): z.ZodType => {
  switch (question.type) {
    case "noul":
      return z.object({ type: z.literal("noul"), noul: finite });
    case "score":
      return z.object({
        type: z.literal("score"),
        confidence: finite,
        score: finite,
        legend: z.record(z.string(), z.string()),
        probabilities: z.record(z.string(), finite),
      });
    case "choice": {
      const options = Object.keys(question.criteria);
      return z.object({
        type: z.literal("choice"),
        choice: z.enum(options),
        confidence: finite,
        // `JevChoiceAnswer<K>` types `probabilities` as TOTAL over the criteria
        // keys. A strict object whose shape is those keys IS that claim: a
        // missing key fails the shape, an extra one is unrecognized.
        probabilities: z.strictObject(
          Object.fromEntries(options.map((k) => [k, finite])),
        ),
      });
    }
  }
};

/**
 * The answers map's schema, keyed by the ids the request asked about.
 *
 * Unknown ids are dropped rather than refused — `z.object` strips them — which
 * is the question-driven reading: the questions are the contract, and a wider
 * response still satisfies it.
 *
 * The one assertion in this module lives here, and it is about the SHAPE, not
 * about a body: `Object.entries` loses the literal key types, so the object
 * built id-for-id out of `questions` types as `Record<string, unknown>`. Every
 * per-id obligation `JevAnswers<Q>` states is the schema this line names, and
 * `parseAnswers` needs no assertion of its own because of it.
 */
const jevAnswersSchema = <Q extends JevQuestionMap>(
  questions: Q,
): z.ZodType<JevAnswers<Q>> =>
  z.object(
    Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        answerSchema(question),
      ]),
    ),
  ) as unknown as z.ZodType<JevAnswers<Q>>;

/** The whole response body: the envelope, with the answers map inside it. */
const responseSchema = <Q extends JevQuestionMap>(questions: Q) =>
  z.object({
    model: z.string(),
    usage: z.object({ input_tokens: finite, output_tokens: finite }),
    answers: jevAnswersSchema(questions),
  });

// ── the failure the schema produces, as data ───────────────────────

/** What a failed field of an answer says, where the path alone names it. */
const ANSWER_FIELD_REASON: Readonly<Record<string, string>> = {
  confidence: "`confidence` is not a number",
  score: "`score` is not a number",
  legend: "`legend` is not a map of strings",
  probabilities: "`probabilities` is not a map of numbers",
  choice: "`choice` is not a string",
  noul: "`noul` is not a number",
};

/**
 * Map one zod issue onto the `JevErr` arm that names it.
 *
 * The issue's path says where, and `body` says what was actually there — which
 * is the difference between "this answer picked an option nobody offered" and
 * "this answer's `choice` is not even a string", two arms one failed `z.enum`
 * covers.
 */
const toJevErr = (
  questions: JevQuestionMap,
  body: unknown,
  issue: z.core.$ZodIssue | undefined,
): JevErr => {
  const [head, id, field] = issue?.path ?? [];

  if (head === "model") {
    return { _tag: "malformed_body", reason: "`model` is not a string" };
  }
  if (head === "usage") {
    return {
      _tag: "malformed_body",
      reason: "`usage` is not `{ input_tokens, output_tokens }`",
    };
  }
  if (head !== "answers") {
    return { _tag: "malformed_body", reason: "body is not an object" };
  }

  const answers = at(body, "answers");
  if (!isObj(answers) || typeof id !== "string") {
    return { _tag: "malformed_body", reason: "`answers` is not an object" };
  }
  if (!Object.hasOwn(answers, id)) return { _tag: "missing_answer", id };

  const answer = answers[id];
  const question = questions[id];
  if (question === undefined || field === undefined) {
    return { _tag: "malformed_answer", id, reason: "answer is not an object" };
  }

  if (field === "type") {
    const received = at(answer, "type");
    return typeof received === "string"
      ? { _tag: "answer_type_mismatch", id, expected: question.type, received }
      : { _tag: "malformed_answer", id, reason: "answer has no `type`" };
  }

  if (question.type === "choice") {
    const options = Object.keys(question.criteria);

    if (field === "choice") {
      const choice = at(answer, "choice");
      if (typeof choice === "string") {
        return { _tag: "off_criteria_choice", id, choice, options };
      }
    }

    if (field === "probabilities") {
      const probabilities = at(answer, "probabilities");
      // A key the shape names and the body carries is a BAD VALUE; one the body
      // does not carry, or one the criteria do not name, is a totality failure.
      const key = issue?.path[3];
      const badValue =
        isObj(probabilities) &&
        typeof key === "string" &&
        Object.hasOwn(probabilities, key);
      if (isObj(probabilities) && !badValue) {
        return {
          _tag: "off_criteria_probabilities",
          id,
          missing: options.filter((k) => !Object.hasOwn(probabilities, k)),
          extra: Object.keys(probabilities).filter((k) => !options.includes(k)),
          options,
        };
      }
    }
  }

  const named =
    typeof field === "string" ? ANSWER_FIELD_REASON[field] : undefined;
  return {
    _tag: "malformed_answer",
    id,
    reason: named ?? issue?.message ?? "answer is malformed",
  };
};

// ── parsing ──────────────────────────────────────────────

/**
 * Turn an `unknown` response body into the typed answers for `questions`, or
 * into one `JevErr`. Pure, total, and never throwing on any input.
 *
 * The schema is question-driven: every id the request asked about must be
 * answered, each answer is checked against ITS question's type and — for a
 * choice — against that question's own criteria keys, both as the `choice`
 * picked and as the exact key set of `probabilities`. An answer under an id
 * nobody asked about is dropped rather than refused.
 */
export const parseAnswers = <Q extends JevQuestionMap>(
  questions: Q,
  body: unknown,
): JevParse<Q> => {
  const parsed = responseSchema(questions).safeParse(body);
  if (!parsed.success) {
    return err(toJevErr(questions, body, parsed.error.issues[0]));
  }
  const { answers, model, usage } = parsed.data;
  return { ok: true, answers, model, usage };
};

// ── status classification ──────────────────────────────────────────────────

/**
 * What a caller does next with an HTTP status.
 *
 * `retry` means back off and send it again; `terminal` means this request will
 * never succeed as written. `ok` is the 2xx arm — naming it keeps the function
 * total, so `ask` switches on three cases instead of testing 2xx itself and
 * then asking here.
 */
export type JevHttpStatus = "ok" | "retry" | "terminal";

/**
 * Classify one HTTP status, per the reference page's error table.
 *
 * 429 (rate limited) and 529 (overloaded) are the two the page tells you to
 * back off on. 401 (bad key) and 422 (the body failed validation) will fail
 * identically forever. Every other non-2xx is terminal by default: an
 * unrecognized failure is not evidence that retrying helps, and a retry loop
 * over one is the expensive way to find that out.
 */
export const classifyStatus = (status: number): JevHttpStatus => {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status === 529) return "retry";
  return "terminal";
};
