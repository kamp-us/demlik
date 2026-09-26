import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { labelsOf } from "../src/lowering/ask.js";
import {
  evaluate,
  expectedCalibrationError,
  flipRate,
  GoldSetError,
  loadGoldSet,
  parseGoldSet,
  shipVerdict,
} from "../src/lowering/harness.js";
import {
  type Branch,
  branchQuestion,
  idOf,
  stubBranchJev,
  verdict,
} from "./lowering-fixture.js";

const goldFile = join(
  import.meta.dirname,
  "fixtures/lowering/branch-label.gold.json",
);
const labels = labelsOf(branchQuestion);
const gold = loadGoldSet(goldFile, labels);
const goldOf = new Map(gold.items.map((item) => [item.id, item.gold]));
const other = (label: Branch): Branch =>
  label === "gate" ? "plumbing" : "gate";

describe("the gold-set format", () => {
  it("reads items with their spans, states and gold labels, plus the rewordings", () => {
    expect(gold.stage).toBe("branch-label");
    expect(gold.rewordings).toHaveLength(1);
    expect(gold.items.map((i) => [i.id, i.gold])).toEqual([
      ["a", "gate"],
      ["b", "gate"],
      ["c", "plumbing"],
      ["d", "plumbing"],
    ]);
    expect(gold.items[3]?.span).toEqual({
      file: "src/http/retry.ts",
      startLine: 7,
      endLine: 7,
    });
    expect(gold.items[0]?.state).toMatchObject({ id: "a" });
  });

  const valid = {
    stage: "s",
    rewordings: ["again"],
    items: [
      {
        id: "a",
        span: { file: "a.ts", startLine: 1, endLine: 1 },
        state: "x",
        gold: "gate",
      },
    ],
  };

  it("refuses a gold label the question cannot answer", () => {
    const raw = { ...valid, items: [{ ...valid.items[0], gold: "maybe" }] };
    expect(() => parseGoldSet(raw, labels)).toThrow(
      /items\.0\.gold: "maybe" is not one of gate, plumbing/,
    );
  });

  it("refuses a repeated item id", () => {
    const raw = { ...valid, items: [valid.items[0], valid.items[0]] };
    expect(() => parseGoldSet(raw, labels)).toThrow(/"a" appears twice/);
  });

  it("refuses a gold set with no rewording, since one wording cannot flip", () => {
    expect(() => parseGoldSet({ ...valid, rewordings: [] }, labels)).toThrow(
      GoldSetError,
    );
  });
});

describe("the metrics", () => {
  it("flip rate is the share of items whose label differs across wordings", () => {
    // Two of four items change label under some wording: 2 / 4.
    expect(
      flipRate([
        ["gate", "gate"],
        ["gate", "plumbing"],
        ["plumbing", "plumbing"],
        ["gate", "gate", "plumbing"],
      ]),
    ).toBe(0.5);
  });

  it("ECE weights each confidence bin's gap between confidence and accuracy", () => {
    // Bin [0.9, 1.0): 4 answers, mean confidence 0.95, accuracy 3/4 → gap 0.20.
    // Bin [0.3, 0.4): 2 answers, mean confidence 0.35, accuracy 1/2 → gap 0.15.
    // ECE = 4/6 × 0.20 + 2/6 × 0.15 = 0.1333… + 0.05 = 0.18333…
    const ece = expectedCalibrationError([
      { confidence: 0.95, correct: true },
      { confidence: 0.95, correct: true },
      { confidence: 0.95, correct: false },
      { confidence: 0.95, correct: true },
      { confidence: 0.35, correct: true },
      { confidence: 0.35, correct: false },
    ]);
    expect(ece).toBeCloseTo(0.183333, 6);
  });

  it("counts a confidence of exactly 1 in the top bin", () => {
    expect(
      expectedCalibrationError([
        { confidence: 1, correct: true },
        { confidence: 1, correct: false },
      ]),
    ).toBeCloseTo(0.5, 10);
  });

  it("is shippable only when both metrics are under their thresholds", () => {
    const thresholds = { ece: 0.1, flipRate: 0.2 };
    expect(shipVerdict({ ece: 0.05, flipRate: 0.1 }, thresholds)).toEqual({
      _tag: "shippable",
    });
    expect(shipVerdict({ ece: 0.1, flipRate: 0.1 }, thresholds)).toEqual({
      _tag: "not-shippable",
      exceeded: [{ metric: "ece", value: 0.1, threshold: 0.1 }],
    });
    expect(shipVerdict({ ece: 0.3, flipRate: 0.5 }, thresholds)).toMatchObject({
      _tag: "not-shippable",
      exceeded: [{ metric: "ece" }, { metric: "flipRate" }],
    });
  });
});

describe("evaluate", () => {
  it("asks every item under the question's own wording and each rewording, and scores them", async () => {
    // Wording 0 answers every item's gold label at 0.9. The rewording flips item d, also at 0.9.
    // 8 answers, all in bin [0.9, 1.0): accuracy 7/8 = 0.875, ECE = |0.875 − 0.9| = 0.025.
    // One of four items flipped: flip rate 0.25.
    const asked: string[] = [];
    const result = await evaluate({
      question: branchQuestion,
      gold,
      thresholds: { ece: 0.05, flipRate: 0.3 },
      connect: (questions) => {
        const wording = questions.verdict.instructions as string;
        asked.push(wording);
        const reworded = wording !== branchQuestion.instructions;
        return stubBranchJev((state) => {
          const id = idOf(state);
          const label = goldOf.get(id) ?? "gate";
          return verdict(reworded && id === "d" ? other(label) : label, 0.9);
        });
      },
    });
    expect(asked).toEqual([branchQuestion.instructions, ...gold.rewordings]);
    expect(result.items.map((i) => [i.id, i.flipped])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", true],
    ]);
    expect(result.accuracy).toBe(0.875);
    expect(result.flipRate).toBe(0.25);
    expect(result.ece).toBeCloseTo(0.025, 10);
    expect(result.verdict).toEqual({ _tag: "shippable" });
  });

  it("comes back not shippable for a stage that is confident and stable but miscalibrated", async () => {
    // Always "gate" at 0.99: it never flips, and it is right on half the items.
    // ECE = |0.5 − 0.99| = 0.49.
    const result = await evaluate({
      question: branchQuestion,
      gold,
      thresholds: { ece: 0.1, flipRate: 0.1 },
      connect: () => stubBranchJev(() => verdict("gate", 0.99)),
    });
    expect(result.flipRate).toBe(0);
    expect(result.ece).toBeCloseTo(0.49, 10);
    expect(result.verdict).toMatchObject({
      _tag: "not-shippable",
      exceeded: [{ metric: "ece", threshold: 0.1 }],
    });
  });
});
