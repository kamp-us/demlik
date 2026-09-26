import { describe, expect, it } from "vitest";
import { calibrate } from "../src/lowering/calibration.js";
import {
  askGroupVerdict,
  type ClusterQuestionState,
  GROUP_VERDICT_CRITERIA,
  GROUP_VERDICTS,
  groupConfirmQuestion,
} from "../src/lowering/group.js";
import { evaluate } from "../src/lowering/harness.js";
import {
  goldGroupJev,
  groupAnswer,
  groupGold,
  groupThresholds,
  stage6Policy,
  stubGroupJev,
} from "./lowering-group-fixture.js";

// Every source, state and gold item below is synthetic, written for these tests.

const stateOf = (id: string) =>
  groupGold.items.find((i) => i.id === id)?.state as ClusterQuestionState;

describe("the stage-6 gold set", () => {
  it("loads through loadGoldSet: at least 20 candidate groups and a rewording", () => {
    expect(groupGold.stage).toBe("group-confirm");
    expect(groupGold.items.length).toBeGreaterThanOrEqual(20);
    expect(groupGold.rewordings.length).toBeGreaterThanOrEqual(1);
    expect(new Set(groupGold.items.map((i) => i.gold))).toEqual(
      new Set(GROUP_VERDICTS),
    );
  });

  it("holds same-rule positives written on different surfaces", () => {
    const positives = groupGold.items.filter((i) => i.gold === "same-rule");
    const onDifferentSurfaces = positives.filter(
      (i) => (i.state as ClusterQuestionState).differences.length > 0,
    );
    expect(onDifferentSurfaces.length).toBeGreaterThanOrEqual(5);
    expect(stateOf("admin-edit-throw-vs-false").differences).toEqual([
      { ref: "m0", atoms: [], outcome: "throw new Forbidden()" },
      { ref: "m1", atoms: [], outcome: "return false" },
    ]);
  });

  it("holds related-but-different negatives, including one condition guarding two rules", () => {
    const negatives = groupGold.items.filter(
      (i) => i.gold === "related-different",
    );
    expect(negatives.length).toBeGreaterThanOrEqual(5);
    const coincide = stateOf("owner-delete-vs-owner-billing");
    expect(coincide.shared).toEqual({
      signal: "condition",
      atoms: ['¬(v0.role === "owner")'],
      outcome: "deny",
    });
    expect(
      negatives.some(
        (i) => (i.state as ClusterQuestionState).shared.signal === "data",
      ),
    ).toBe(true);
  });

  it("scores through evaluate with a stubbed Jev", async () => {
    const jev = goldGroupJev();
    const evaluation = await evaluate({
      question: groupConfirmQuestion(),
      gold: groupGold,
      connect: () => jev,
      thresholds: groupThresholds,
      target: 0.9,
    });
    expect(evaluation.accuracy).toBe(1);
    expect(evaluation.flipRate).toBe(0);
    expect(evaluation.verdict).toEqual({ _tag: "shippable" });
    expect(jev.asked).toHaveLength(groupGold.items.length * 2);
  });
});

describe("the stage-6 question", () => {
  it("is a ChoiceQuestion over exactly the three verdicts, each anchored", () => {
    const question = groupConfirmQuestion();
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual([...GROUP_VERDICTS]);
    for (const verdict of GROUP_VERDICTS)
      expect(
        GROUP_VERDICT_CRITERIA[verdict].examples.length,
      ).toBeGreaterThanOrEqual(1);
  });

  it("keeps Jev's whole distribution beside the verdict", async () => {
    const jev = stubGroupJev(() => groupAnswer("same-rule", 0.8));
    const answer = await askGroupVerdict(jev)(
      stateOf("admin-edit-throw-vs-false"),
    );
    expect(answer.label).toBe("same-rule");
    expect(answer.confidence).toBe(0.8);
    expect(answer.probabilities["related-different"]).toBeCloseTo(0.1);
  });

  it("derives its gate policy from calibrate over the gold set", async () => {
    const policy = await stage6Policy();
    const reference = calibrate(
      groupGold.items.flatMap(() => [
        { confidence: 0.95, correct: true },
        { confidence: 0.95, correct: true },
      ]),
      { target: 0.9 },
    );
    expect(reference._tag).toBe("derived");
    if (reference._tag === "derived")
      expect(policy.floor).toBe(reference.floor);
  });
});
