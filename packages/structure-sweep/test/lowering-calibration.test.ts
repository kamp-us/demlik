import { describe, expect, it } from "vitest";
import { askVerdict, labelsOf } from "../src/lowering/ask.js";
import {
  calibrate,
  confidenceBands,
  type DerivedFloor,
  expectedCalibrationError,
  type Scored,
} from "../src/lowering/calibration.js";
import { sourceSpan } from "../src/lowering/fact.js";
import { gate, gatePolicy } from "../src/lowering/gate.js";
import { evaluate, loadGoldSet } from "../src/lowering/harness.js";
import {
  branchQuestion,
  idOf,
  stubBranchJev,
  verdict,
} from "./lowering-fixture.js";

const gold = loadGoldSet(
  `${import.meta.dirname}/fixtures/lowering/branch-label.gold.json`,
  labelsOf(branchQuestion),
);
const goldOf = new Map(gold.items.map((item) => [item.id, item.gold]));

const answers = (
  ...rows: readonly (readonly [number, number, number])[]
): Scored[] =>
  rows.flatMap(([confidence, right, wrong]) => [
    ...Array.from({ length: right }, () => ({ confidence, correct: true })),
    ...Array.from({ length: wrong }, () => ({ confidence, correct: false })),
  ]);

function derivedFloor(scored: readonly Scored[], target: number) {
  const calibration = calibrate(scored, { target });
  if (calibration._tag !== "derived")
    throw new Error("expected a derived floor");
  return calibration;
}

describe("confidenceBands", () => {
  it("reports each non-empty band's size, mean confidence and accuracy, lowest first", () => {
    expect(confidenceBands(answers([0.75, 3, 1], [0.5, 1, 1]))).toEqual([
      { lower: 0.5, upper: 0.6, n: 2, confidence: 0.5, accuracy: 0.5 },
      { lower: 0.7, upper: 0.8, n: 4, confidence: 0.75, accuracy: 0.75 },
    ]);
  });
});

describe("calibrate", () => {
  it("derives the lowest floor whose band and every band above it meet the target", () => {
    // [0.9, 1.0) 10/10, [0.8, 0.9) 9/10, [0.7, 0.8) 7/10, [0.5, 0.6) 10/10.
    // Down from the top: 1.0 and 0.9 meet 0.9; 0.7 does not, so the floor stops at 0.8 even though
    // the band under it is accurate again.
    const calibration = calibrate(
      answers([0.95, 10, 0], [0.85, 9, 1], [0.75, 7, 3], [0.55, 10, 0]),
      { target: 0.9 },
    );
    expect(calibration).toMatchObject({
      _tag: "derived",
      target: 0.9,
      floor: 0.8,
    });
  });

  it("skips an empty band rather than stopping at it", () => {
    const calibration = calibrate(answers([0.95, 5, 0], [0.65, 5, 0]), {
      target: 0.9,
    });
    expect(calibration).toMatchObject({ _tag: "derived", floor: 0.6 });
  });

  it("is unreachable when even the top band misses the target", () => {
    const calibration = calibrate(answers([0.95, 8, 2], [0.55, 10, 0]), {
      target: 0.9,
    });
    expect(calibration._tag).toBe("unreachable");
  });

  it("refuses a target outside [0, 1]", () => {
    for (const target of [1.1, -0.1, Number.NaN])
      expect(() => calibrate(answers([0.9, 1, 0]), { target })).toThrow(
        RangeError,
      );
  });

  it("is the only way to a gate floor: a hand-typed one does not type-check", () => {
    const forged = {
      _tag: "derived" as const,
      target: 0.9,
      floor: 0.8,
      bands: [],
    };
    // @ts-expect-error a floor must come from `calibrate`, not an object literal
    const forgedFloor: DerivedFloor = forged;
    expect(forgedFloor.floor).toBe(0.8);
  });
});

describe("expectedCalibrationError refuses what it cannot bin", () => {
  const scored = answers([0.9, 1, 1]);

  it("refuses a bin count that is not a positive whole number", () => {
    for (const bins of [0, -3, 2.5, Number.NaN])
      expect(() => expectedCalibrationError(scored, bins)).toThrow(
        /bins is a positive whole number/,
      );
  });

  it("refuses a confidence outside [0, 1] or NaN, rather than dropping it", () => {
    for (const confidence of [1.5, -0.2, Number.NaN])
      expect(() =>
        expectedCalibrationError([...scored, { confidence, correct: true }]),
      ).toThrow(/a confidence is in \[0, 1\]/);
  });
});

describe("a per-stage floor", () => {
  // Both stages are right at 0.95 on a and b. At 0.75 on c and d, stage A is right and stage B is
  // wrong. Target 0.9: A's [0.7, 0.8) band is 4/4 so its floor is 0.7; B's is 0/4 so its floor is 0.9.
  const stage = (rightWhenUnsure: boolean) =>
    stubBranchJev((state) => {
      const id = idOf(state);
      const label = goldOf.get(id) ?? "gate";
      if (id === "a" || id === "b") return verdict(label, 0.95);
      const wrong = label === "gate" ? "plumbing" : "gate";
      return verdict(rightWhenUnsure ? label : wrong, 0.75);
    });
  const calibrated = async (rightWhenUnsure: boolean) => {
    const result = await evaluate({
      question: branchQuestion,
      gold,
      thresholds: { ece: 1, flipRate: 1 },
      target: 0.9,
      connect: () => stage(rightWhenUnsure),
    });
    if (result.calibration._tag !== "derived")
      throw new Error("expected a derived floor");
    return result.calibration;
  };

  it("differs between two stages with different accuracy curves, and the gate reads it", async () => {
    const a = await calibrated(true);
    const b = await calibrated(false);
    expect(a.floor).toBe(0.7);
    expect(b.floor).toBe(0.9);

    // One 0.75 answer, gated under each stage's own policy: A promotes it, B abstains it.
    const item = {
      id: "x",
      span: sourceSpan("src/x.ts", 1),
      state: { id: "x" },
    };
    const ask = askVerdict(stubBranchJev(() => verdict("gate", 0.75)));
    const enrich = async () => item.state;
    const underA = await gate(item, {
      policy: gatePolicy({ calibration: a, maxRounds: 0 }),
      ask,
      enrich,
    });
    const underB = await gate(item, {
      policy: gatePolicy({ calibration: b, maxRounds: 0 }),
      ask,
      enrich,
    });
    expect(underA._tag).toBe("promoted");
    expect(underB._tag).toBe("abstained");
  });

  it("is what gatePolicy carries, with no default of its own", () => {
    const floor = derivedFloor(answers([0.85, 1, 0], [0.75, 0, 1]), 0.9);
    expect(gatePolicy({ calibration: floor, maxRounds: 1 }).floor).toBe(0.8);
  });
});
