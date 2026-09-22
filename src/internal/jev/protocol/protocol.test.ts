// Runtime tests for the Jev protocol's two pure functions (#216).
//
// The type-level half of the contract lives in `protocol.test-d.ts`; this file
// is about the half the compiler cannot see — what `parseAnswers` does with a
// body the network actually produced, including bodies the types promised
// could not exist.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyStatus, jevQuestions, parseAnswers } from "./index";

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

/**
 * A response recorded off the reference page's own examples, with one answer
 * per question type. Every negative case below is this body with one field
 * broken, so a failure names the break rather than the fixture.
 */
const recorded = {
  model: "jev-1.13.0",
  answers: {
    category: {
      type: "choice",
      choice: "groceries",
      probabilities: { groceries: 0.88, dining: 0.12 },
      confidence: 0.81,
    },
    frustration: {
      type: "score",
      score: 1.05,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0.0, "1": 0.95, "2": 0.05 },
      confidence: 0.92,
    },
    is_urgent: { type: "noul", noul: 0.95 },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};

/** `recorded` with one answer replaced. */
const withAnswer = (id: string, answer: unknown): unknown => ({
  ...recorded,
  answers: { ...recorded.answers, [id]: answer },
});

describe("parseAnswers — the happy path", () => {
  it("returns typed answers for a body covering one choice, one score and one noul", () => {
    const parsed = parseAnswers(questions, recorded);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.model).toBe("jev-1.13.0");
    expect(parsed.usage).toEqual({ input_tokens: 318, output_tokens: 34 });

    // The narrowing the module exists for, checked at runtime too.
    const choice: "groceries" | "dining" = parsed.answers.category.choice;
    expect(choice).toBe("groceries");
    expect(parsed.answers.category.probabilities.dining).toBe(0.12);
    expect(parsed.answers.frustration.score).toBe(1.05);
    expect(parsed.answers.is_urgent.noul).toBe(0.95);
  });

  it("ignores an answer under an id nobody asked about", () => {
    const wider = withAnswer("unasked", { type: "noul", noul: 0.1 });
    const parsed = parseAnswers(questions, wider);
    expect(parsed.ok).toBe(true);
  });

  it("accepts a choice answer for a criterion described as `null`", () => {
    const qs = jevQuestions({
      pick: {
        type: "choice",
        instructions: "Pick one.",
        criteria: { a: null, b: "the other one" },
      },
    });
    const parsed = parseAnswers(qs, {
      model: "jev-1.13.0",
      answers: {
        pick: {
          type: "choice",
          choice: "a",
          probabilities: { a: 1, b: 0 },
          confidence: 1,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.answers.pick.choice).toBe("a");
  });
});

describe("parseAnswers — every failure is one `JevErr`", () => {
  it("malformed body: the envelope is not a Jev response", () => {
    for (const body of [
      null,
      42,
      "ok",
      [],
      {},
      { ...recorded, model: 7 },
      { ...recorded, answers: "none" },
      { ...recorded, usage: { input_tokens: 1 } },
    ]) {
      const parsed = parseAnswers(questions, body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error._tag).toBe("malformed_body");
    }
  });

  it("missing answer: a question id has no answer under it", () => {
    const { category: _dropped, ...rest } = recorded.answers;
    const parsed = parseAnswers(questions, { ...recorded, answers: rest });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toEqual({ _tag: "missing_answer", id: "category" });
  });

  it("type mismatch: an answer's `type` disagrees with its question", () => {
    const parsed = parseAnswers(
      questions,
      withAnswer("category", { type: "noul", noul: 0.4 }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toEqual({
      _tag: "answer_type_mismatch",
      id: "category",
      expected: "choice",
      received: "noul",
    });
  });

  it("off-criteria choice: the pick is not one of the criteria keys", () => {
    const parsed = parseAnswers(
      questions,
      withAnswer("category", {
        type: "choice",
        choice: "other",
        probabilities: { other: 1 },
        confidence: 0.5,
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toEqual({
      _tag: "off_criteria_choice",
      id: "category",
      choice: "other",
      options: ["groceries", "dining"],
    });
  });

  it("malformed answer: the `type` is right and the payload is not", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      [
        "category",
        { type: "choice", choice: 7, probabilities: {}, confidence: 1 },
      ],
      [
        "category",
        {
          type: "choice",
          choice: "groceries",
          probabilities: { groceries: "a lot" },
          confidence: 1,
        },
      ],
      ["category", { type: "choice", choice: "groceries", probabilities: {} }],
      [
        "frustration",
        { type: "score", legend: {}, probabilities: {}, confidence: 1 },
      ],
      [
        "frustration",
        {
          type: "score",
          score: 1,
          legend: { "0": 0 },
          probabilities: {},
          confidence: 1,
        },
      ],
      ["is_urgent", { type: "noul" }],
      ["is_urgent", { type: "noul", noul: Number.NaN }],
      ["is_urgent", "not an object"],
      ["is_urgent", { noul: 0.5 }],
    ];

    for (const [id, answer] of cases) {
      const parsed = parseAnswers(questions, withAnswer(id, answer));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error._tag).toBe("malformed_answer");
    }
  });
});

describe("parseAnswers — totality", () => {
  it("never throws on arbitrary `unknown` input", () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        const parsed = parseAnswers(questions, body);
        // No `expect().not.toThrow()` wrapper: reaching this line at all is the
        // assertion, because a throw fails the property outright.
        expect(typeof parsed.ok).toBe("boolean");
      }),
      { numRuns: 500 },
    );
  });

  it("never throws on a well-shaped envelope carrying arbitrary answers", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (answers) => {
        const parsed = parseAnswers(questions, {
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        expect(typeof parsed.ok).toBe("boolean");
      }),
      { numRuns: 500 },
    );
  });
});

describe("classifyStatus", () => {
  it("backs off on the two statuses the reference page says to back off on", () => {
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(529)).toBe("retry");
  });

  it("gives up on a bad key, a rejected body, and any other non-2xx", () => {
    expect(classifyStatus(401)).toBe("terminal");
    expect(classifyStatus(422)).toBe("terminal");
    expect(classifyStatus(500)).toBe("terminal");
    for (const status of [400, 403, 404, 409, 418, 502, 503, 504]) {
      expect(classifyStatus(status)).toBe("terminal");
    }
  });

  it("calls 2xx `ok`, so the caller switches instead of pre-testing", () => {
    for (const status of [200, 201, 204, 299]) {
      expect(classifyStatus(status)).toBe("ok");
    }
  });

  it("is total: every status is exactly one of the three", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 599 }), (status) => {
        expect(["ok", "retry", "terminal"]).toContain(classifyStatus(status));
      }),
    );
  });
});
