import type { JevChoiceAnswer, JevState } from "@demlik/tea/jev";
import type { ChoiceQuestion, ChoiceQuestions } from "../src/lowering/ask.js";
import { stubJev } from "./helpers.js";

export type Branch = "gate" | "plumbing";

export const branchQuestion: ChoiceQuestion<Branch> = {
  type: "choice",
  instructions:
    "state.source is one branch of a function. Say whether it encodes an access or limit rule, or is plumbing.",
  criteria: {
    gate: "It decides who may do what, a limit, or eligibility.",
    plumbing: "It only moves, fetches, shapes or retries data.",
  },
};

export function verdict(
  label: Branch,
  confidence: number,
): JevChoiceAnswer<Branch> {
  const other: Branch = label === "gate" ? "plumbing" : "gate";
  return {
    type: "choice",
    choice: label,
    confidence,
    probabilities: { [label]: confidence, [other]: 1 - confidence } as Record<
      Branch,
      number
    >,
  };
}

/** A stubbed Jev client over the branch question: `answer` sees the state and says what Jev says. */
export const stubBranchJev = (
  answer: (state: JevState) => JevChoiceAnswer<Branch>,
) => stubJev<ChoiceQuestions<Branch>>((state) => ({ verdict: answer(state) }));

export const idOf = (state: JevState): string =>
  (state as { readonly id: string }).id;
