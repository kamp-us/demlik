import { join } from "node:path";
import type { JevChoiceAnswer, JevState } from "@demlik/tea/jev";
import type { ChoiceQuestions } from "../src/lowering/ask.js";
import { gatePolicy } from "../src/lowering/gate.js";
import {
  type ClusterQuestionState,
  GROUP_VERDICTS,
  type GroupVerdict,
  groupConfirmQuestion,
} from "../src/lowering/group.js";
import { evaluate, loadGoldSet } from "../src/lowering/harness.js";
import { stubJev } from "./helpers.js";

// Every gold item and state here is synthetic, written for these tests.

export const groupGoldFile = join(
  import.meta.dirname,
  "fixtures/lowering/group-confirm.gold.json",
);

export const groupGold = loadGoldSet(groupGoldFile, GROUP_VERDICTS);

export function groupAnswer(
  label: GroupVerdict,
  confidence: number,
): JevChoiceAnswer<GroupVerdict> {
  const rest = (1 - confidence) / (GROUP_VERDICTS.length - 1);
  return {
    type: "choice",
    choice: label,
    confidence,
    probabilities: Object.fromEntries(
      GROUP_VERDICTS.map((v) => [v, v === label ? confidence : rest]),
    ) as Record<GroupVerdict, number>,
  };
}

/** A stub Jev over the stage-6 question: `answer` sees the cluster state and says what Jev says. */
export const stubGroupJev = (
  answer: (state: ClusterQuestionState) => JevChoiceAnswer<GroupVerdict>,
) =>
  stubJev<ChoiceQuestions<GroupVerdict>>((state: JevState) => ({
    verdict: answer(state as ClusterQuestionState),
  }));

const goldOf = new Map(
  groupGold.items.map((item) => [
    (item.state as ClusterQuestionState).cluster,
    item.gold,
  ]),
);

/** Knows every gold cluster's verdict at 0.95. */
export const goldGroupJev = () =>
  stubGroupJev((state) =>
    groupAnswer(goldOf.get(state.cluster) ?? "unrelated", 0.95),
  );

export const groupThresholds = { ece: 0.2, flipRate: 0.1 };

/** Stage 6's policy, built from `calibrate` over the stage-6 gold set (through `evaluate`). */
export async function stage6Policy() {
  const evaluation = await evaluate({
    question: groupConfirmQuestion(),
    gold: groupGold,
    connect: () => goldGroupJev(),
    thresholds: groupThresholds,
    target: 0.9,
  });
  if (evaluation.calibration._tag !== "derived")
    throw new Error("expected a derived stage-6 floor");
  return gatePolicy({ calibration: evaluation.calibration, maxRounds: 1 });
}
