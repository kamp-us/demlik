import type { JevChoiceQuestion, JevState, JevText } from "@demlik/tea/jev";
import type { JevClient } from "../jev.js";

/** The one question a Jev stage is judged on, asked under the id `verdict`. */
export type ChoiceQuestion<K extends string> = JevChoiceQuestion<
  Readonly<Record<K, JevText | null>>
>;

export type ChoiceQuestions<K extends string> = {
  readonly verdict: ChoiceQuestion<K>;
};

/** One answer, reduced to what the harness and the gate read: the label and Jev's confidence in it. */
export interface Judgement<K extends string> {
  readonly label: K;
  readonly confidence: number;
}

/** Ask one item's state; every Jev stage the harness scores or the gate filters is one of these. */
export type Asker<K extends string> = (
  state: JevState,
) => Promise<Judgement<K>>;

export const askVerdict =
  <K extends string>(client: JevClient<ChoiceQuestions<K>>): Asker<K> =>
  async (state) => {
    const { verdict } = (await client(state)).answers;
    return { label: verdict.choice, confidence: verdict.confidence };
  };

export const labelsOf = <K extends string>(
  question: ChoiceQuestion<K>,
): readonly K[] => Object.keys(question.criteria) as K[];
