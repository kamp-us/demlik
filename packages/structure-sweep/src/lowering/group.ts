import type { JevState, JevText } from "@demlik/tea/jev";
import type { JevClient } from "../jev.js";
import type {
  Asker,
  ChoiceQuestion,
  ChoiceQuestions,
  Judgement,
} from "./ask.js";

// ── the confirm question ──────────────────────────────────────────────────

/**
 * What stage 6 says about one candidate cluster. Only `same-rule` makes a rule group; the other two
 * send the cluster to the human queue.
 */
export const GROUP_VERDICTS = [
  "same-rule",
  "related-different",
  "unrelated",
] as const;

export type GroupVerdict = (typeof GROUP_VERDICTS)[number];

/** One worked, synthetic example of a verdict: the members as stage 6 shows them, and why. */
export interface GroupAnchor {
  readonly members: string;
  readonly why: string;
}

export interface GroupCriterion {
  readonly definition: string;
  readonly examples: readonly [GroupAnchor, ...GroupAnchor[]];
}

/**
 * The criteria separate "one rule, different surface" from "related but different" by naming what
 * counts as a surface. The prototype's question did not, and answered "related but different" on
 * every known duplicate.
 */
export const GROUP_VERDICT_CRITERIA: Readonly<
  Record<GroupVerdict, GroupCriterion>
> = {
  "same-rule": {
    definition:
      "The members make one decision about one subject with one consequence for the caller, written on different surfaces: a thrown error where another returns false, a different error type or message, different function or local names, or a value supplied through a parameter default. Changing the rule would mean changing every member the same way.",
    examples: [
      {
        members:
          "guardEdit: ¬(v0.isAdmin) ⇒ throw new Forbidden(); canEdit: ¬(v0.isAdmin) ⇒ return false",
        why: "One admin-only rule: one side throws on the denied case and the other returns false.",
      },
    ],
  },
  "related-different": {
    definition:
      "The members test the same data or the same kind of condition but decide different things: a different permission, subject, threshold or consequence, a read against a write, or one condition guarding two product rules that only coincide today. Changing one would not mean changing the others.",
    examples: [
      {
        members:
          'canDeleteProject: ¬(v0.role === "owner") ⇒ return false; canTransferBilling: ¬(v0.role === "owner") ⇒ return false',
        why: "Two owner-only permissions that coincide today; either can change alone.",
      },
    ],
  },
  unrelated: {
    definition:
      "The members only look alike: a generic check, such as an emptiness, null or length test, on different things, with no decision or subject in common.",
    examples: [
      {
        members:
          "hasItems: ¬(v0) ⇒ return false; isSignedIn: ¬(v0) ⇒ return false",
        why: "Both test a value is present, but one is a list and the other a session.",
      },
    ],
  },
};

export const GROUP_CONFIRM_INSTRUCTIONS =
  "state.members are branches from different functions that a deterministic pass put in one candidate cluster because they share state.shared. state.differences lists, per member, what not every member has. Decide whether the members are one rule written on different surfaces, related but different rules, or unrelated. A different surface — a thrown error against a returned false, the error type, the names, a default parameter value — does not make two rules; a different subject, threshold, permission, consequence, or a read against a write does.";

export function groupConfirmQuestion(): ChoiceQuestion<GroupVerdict> {
  const text = (verdict: GroupVerdict): JevText => {
    const { definition, examples } = GROUP_VERDICT_CRITERIA[verdict];
    return { definition, examples };
  };
  return {
    type: "choice",
    instructions: GROUP_CONFIRM_INSTRUCTIONS,
    criteria: {
      "same-rule": text("same-rule"),
      "related-different": text("related-different"),
      unrelated: text("unrelated"),
    },
  };
}

/** What Jev is shown about one candidate cluster: its members' lowered branches, never raw source. */
export type ClusterQuestionState = {
  readonly cluster: string;
  /** Why the members are one candidate: the condition key they share, or the binding they touch. */
  readonly shared:
    | {
        readonly signal: "condition";
        readonly atoms: readonly string[];
        readonly outcome: string;
      }
    | { readonly signal: "data"; readonly binding: string };
  readonly members: readonly {
    readonly ref: string;
    readonly function: string;
    readonly atoms: readonly string[];
    readonly outcome: string;
    readonly bindings: readonly string[];
  }[];
  /** Per member, the atoms not every member has, and its outcome when the members' outcomes differ. */
  readonly differences: readonly ClusterDifference[];
};

export interface ClusterDifference {
  readonly ref: string;
  readonly atoms: readonly string[];
  readonly outcome: string | null;
}

/** A stage-6 answer: the verdict and its confidence, with Jev's whole distribution kept as evidence. */
export interface GroupJudgement extends Judgement<GroupVerdict> {
  readonly probabilities: Readonly<Record<GroupVerdict, number>>;
}

/** The stage-6 asker over a client for `groupConfirmQuestion()` (or a rewording of it). */
export const askGroupVerdict =
  (
    client: JevClient<ChoiceQuestions<GroupVerdict>>,
  ): Asker<GroupVerdict, GroupJudgement> =>
  async (state: JevState) => {
    const { verdict } = (await client(state)).answers;
    return {
      label: verdict.choice,
      confidence: verdict.confidence,
      probabilities: verdict.probabilities,
    };
  };
