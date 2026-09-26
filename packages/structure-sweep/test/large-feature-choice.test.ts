import type { JevHttpReply, JevRequest } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import { httpJevClient } from "../src/jev.js";
import { sweepQuestions } from "../src/sweep/questions.js";
import { isFeature, parseVocabulary } from "../src/vocabulary.js";

const FEATURES = 99;

const features = Object.fromEntries(
  Array.from({ length: FEATURES }, (_, n) => [
    `feature_${String(n + 1).padStart(2, "0")}`,
    `Everything about concern number ${n + 1} and nothing about its neighbours.`,
  ]),
);

const vocabulary = parseVocabulary({
  product: "a large product",
  features,
  roles: {
    rule: { description: "Decides.", dir: "rules" },
    glue: { description: "Plumbing.", dir: "lib", shared: true },
  },
});

describe(`a ${FEATURES}-option feature choice`, () => {
  it("carries every feature into the question and decodes a scripted reply over all of them", async () => {
    const questions = sweepQuestions(vocabulary);
    expect(questions.feature.type).toBe("choice");
    expect(questions.feature.criteria).toEqual(features);
    expect(Object.keys(questions.feature.criteria)).toHaveLength(FEATURES);

    const keys = Object.keys(features);
    const picked = "feature_73";
    const probabilities = Object.fromEntries(
      keys.map((k) => [k, k === picked ? 0.5 : 0.5 / (FEATURES - 1)]),
    );
    const reply: JevHttpReply = {
      status: 200,
      body: {
        model: "jev-stub",
        answers: {
          feature: {
            type: "choice",
            choice: picked,
            confidence: 0.5,
            probabilities,
          },
          role: {
            type: "choice",
            choice: "rule",
            confidence: 0.9,
            probabilities: { rule: 0.9, glue: 0.1 },
          },
          rule_inside_surface: { type: "noul", noul: 0.1 },
        },
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    };
    const seen: JevRequest[] = [];
    const ask = httpJevClient({
      questions,
      model: "jev-stub",
      post: async (request) => {
        seen.push(request);
        return reply;
      },
      sleep: async () => {},
    });

    const { answers } = await ask({ file: { path: "a.ts" } });

    expect(seen).toHaveLength(1);
    expect(answers.feature.choice).toBe(picked);
    expect(isFeature(vocabulary, answers.feature.choice)).toBe(true);
    expect(Object.keys(answers.feature.probabilities).sort()).toEqual(keys);
    expect(answers.feature.probabilities).toEqual(probabilities);
  });
});
