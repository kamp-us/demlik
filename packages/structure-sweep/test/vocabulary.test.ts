import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepQuestions } from "../src/sweep/questions.js";
import {
  loadVocabulary,
  parseVocabulary,
  VocabularyError,
} from "../src/vocabulary.js";
import { fixtureVocabulary } from "./helpers.js";

const file = (text: string) => {
  const path = join(
    mkdtempSync(join(tmpdir(), "vocab-")),
    "structure-sweep.config.json",
  );
  writeFileSync(path, text);
  return path;
};

const roles = {
  rule: { description: "decides", dir: "rules" },
  glue: { description: "helps", dir: "lib", shared: true },
};

describe("loadVocabulary", () => {
  it("reads features and roles from the repo's file, and the questions carry them", () => {
    const vocabulary = fixtureVocabulary();
    const questions = sweepQuestions(vocabulary);
    expect(Object.keys(questions.feature.criteria)).toEqual(
      Object.keys(vocabulary.features),
    );
    expect(questions.role.criteria).toMatchObject({
      plumbing: vocabulary.roles.plumbing?.description,
    });
    expect(questions.feature.instructions).toContain(
      "a SaaS accessibility-audit product",
    );
  });

  it("defaults shared to false", () => {
    const v = parseVocabulary({ features: { a: "x", b: "y" }, roles });
    expect(v.roles.rule).toEqual({
      description: "decides",
      dir: "rules",
      shared: false,
    });
  });

  it("names every problem in an invalid file instead of crashing on the first", () => {
    const path = file(
      JSON.stringify({
        features: { Billing: "" },
        roles: { rule: { description: "x" } },
      }),
    );
    expect(() => loadVocabulary(path)).toThrow(VocabularyError);
    let message = "";
    try {
      loadVocabulary(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`${path} is not a valid vocabulary`);
    expect(message).toMatch(/features/);
    expect(message).toMatch(/roles\.rule\.dir/);
  });

  it("refuses a file that is not JSON, and a missing one, with the path in the message", () => {
    expect(() => loadVocabulary(file("{ nope"))).toThrow(/is not JSON/);
    expect(() =>
      loadVocabulary("/nowhere/structure-sweep.config.json"),
    ).toThrow(/no vocabulary at \/nowhere/);
  });

  it("refuses a single-option vocabulary", () => {
    expect(() => parseVocabulary({ features: { only: "x" }, roles })).toThrow(
      /at least two features/,
    );
  });

  it("fingerprints the vocabulary so a changed rubric is a changed cache key", () => {
    const a = parseVocabulary({ features: { a: "x", b: "y" }, roles });
    const b = parseVocabulary({
      features: { a: "x", b: "y, reworded" },
      roles,
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(
      parseVocabulary({ features: { a: "x", b: "y" }, roles }).fingerprint,
    ).toBe(a.fingerprint);
  });
});
