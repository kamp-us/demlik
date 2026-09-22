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
  /** The answer's `type` is right and its payload is not — a missing
   *  `confidence`, a `probabilities` that is not a number map, and so on. */
  | {
      readonly _tag: "malformed_answer";
      readonly id: string;
      readonly reason: string;
    };

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

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Every value of `v` is a finite number. `v` itself must already be an object. */
const isNumMap = (v: unknown): v is Readonly<Record<string, number>> =>
  isObj(v) && Object.values(v).every(isNum);

const isStrMap = (v: unknown): v is Readonly<Record<string, string>> =>
  isObj(v) && Object.values(v).every((x) => typeof x === "string");

const err = (
  error: JevErr,
): { readonly ok: false; readonly error: JevErr } => ({
  ok: false,
  error,
});

/**
 * Check one answer against the question that asked for it.
 *
 * Returns `undefined` on a match — the answer is then structurally the shape
 * `JevAnswerFor<Q>` names, and the cast at the end of `parseAnswers` is that
 * fact rather than a hope. Returning the error instead of throwing keeps the
 * whole walk branch-free of `try`.
 */
const checkAnswer = (
  id: string,
  question: JevQuestion,
  answer: unknown,
): JevErr | undefined => {
  if (!isObj(answer)) {
    return { _tag: "malformed_answer", id, reason: "answer is not an object" };
  }
  const received = answer["type"];
  if (typeof received !== "string") {
    return { _tag: "malformed_answer", id, reason: "answer has no `type`" };
  }
  if (received !== question.type) {
    return {
      _tag: "answer_type_mismatch",
      id,
      expected: question.type,
      received,
    };
  }

  if (question.type === "noul") {
    return isNum(answer["noul"])
      ? undefined
      : { _tag: "malformed_answer", id, reason: "`noul` is not a number" };
  }

  if (!isNum(answer["confidence"])) {
    return {
      _tag: "malformed_answer",
      id,
      reason: "`confidence` is not a number",
    };
  }
  if (!isNumMap(answer["probabilities"])) {
    return {
      _tag: "malformed_answer",
      id,
      reason: "`probabilities` is not a map of numbers",
    };
  }

  if (question.type === "score") {
    if (!isNum(answer["score"])) {
      return {
        _tag: "malformed_answer",
        id,
        reason: "`score` is not a number",
      };
    }
    return isStrMap(answer["legend"])
      ? undefined
      : {
          _tag: "malformed_answer",
          id,
          reason: "`legend` is not a map of strings",
        };
  }

  // choice — the one check the type-level contract rests on.
  const choice = answer["choice"];
  if (typeof choice !== "string") {
    return { _tag: "malformed_answer", id, reason: "`choice` is not a string" };
  }
  const options = Object.keys(question.criteria);
  return options.includes(choice)
    ? undefined
    : { _tag: "off_criteria_choice", id, choice, options };
};

/**
 * Turn an `unknown` response body into the typed answers for `questions`, or
 * into one `JevErr`. Pure, total, and never throwing on any input.
 *
 * The walk is question-driven, not body-driven: every id the request asked
 * about must be answered, and each answer is checked against ITS question's
 * type and — for a choice — against that question's own criteria keys. An
 * answer under an id nobody asked about is ignored rather than refused; the
 * questions are the contract, and a wider response still satisfies it.
 */
export const parseAnswers = <Q extends JevQuestionMap>(
  questions: Q,
  body: unknown,
): JevParse<Q> => {
  if (!isObj(body))
    return err({ _tag: "malformed_body", reason: "body is not an object" });

  const model = body["model"];
  if (typeof model !== "string") {
    return err({ _tag: "malformed_body", reason: "`model` is not a string" });
  }

  const usage = body["usage"];
  if (
    !isObj(usage) ||
    !isNum(usage["input_tokens"]) ||
    !isNum(usage["output_tokens"])
  ) {
    return err({
      _tag: "malformed_body",
      reason: "`usage` is not `{ input_tokens, output_tokens }`",
    });
  }

  const answers = body["answers"];
  if (!isObj(answers)) {
    return err({
      _tag: "malformed_body",
      reason: "`answers` is not an object",
    });
  }

  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(answers, id)) {
      return err({ _tag: "missing_answer", id });
    }
    const bad = checkAnswer(id, question, answers[id]);
    if (bad !== undefined) return err(bad);
  }

  return {
    ok: true,
    // Every id of `questions` passed `checkAnswer`, which is exactly the set of
    // obligations `JevAnswers<Q>` states. `unknown` is the bridge because the
    // per-id narrowing happened in a loop, where the compiler cannot carry it.
    answers: answers as unknown as JevAnswers<Q>,
    model,
    usage: {
      input_tokens: usage["input_tokens"],
      output_tokens: usage["output_tokens"],
    },
  };
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
