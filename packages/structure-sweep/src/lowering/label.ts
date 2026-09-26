import type {
  JevChoiceAnswer,
  JevNoulQuestion,
  JevQuestionMap,
  JevState,
} from "@demlik/tea/jev";
import type { JevClient } from "../jev.js";
import type {
  Asker,
  ChoiceQuestion,
  ChoiceQuestions,
  Judgement,
} from "./ask.js";
import type { SourceSpan } from "./fact.js";
import {
  type Enrich,
  type Gated,
  type GateItem,
  type GatePolicy,
  gateAll,
} from "./gate.js";
import {
  type EvaluateOptions,
  type Evaluation,
  evaluate,
  type GoldSet,
} from "./harness.js";
import { renderAtom, renderOutcome, renderTerm } from "./lower.js";
import {
  type Labeller,
  type LabelRecord,
  type LabelRequest,
  renderReturnFact,
} from "./summarize.js";

/** What stage 5 says one branch is. Four labels; nothing here derives a fifth. */
export const BRANCH_LABELS = [
  "rule",
  "defence",
  "plumbing",
  "could-be-data",
] as const;

export type BranchLabel = (typeof BRANCH_LABELS)[number];

/** One worked, synthetic example of a label: a lowered branch as stage 5 reads it, and why. */
export interface Anchor {
  readonly branch: string;
  readonly why: string;
}

/** A label's criterion: its definition, and at least one worked example that anchors it. */
export interface Criterion {
  readonly definition: string;
  readonly examples: readonly [Anchor, ...Anchor[]];
}

export const BRANCH_LABEL_CRITERIA: Readonly<Record<BranchLabel, Criterion>> = {
  rule: {
    definition:
      "The branch enforces a product rule: who may do what, a limit, eligibility, or a flag, plan or entitlement that switches behaviour for a customer. Changing it changes what a customer is allowed to do.",
    examples: [
      {
        branch: '¬(v0.role === "owner") ⇒ throw new Forbidden()',
        why: "It decides who may delete a project.",
      },
      {
        branch:
          'v2 === null ⇒ return true, where v2 = loadCaps(v0) and loadCaps returns null ⇐ ¬(features.isOn("caps")) [flag]',
        why: "The null check is the cap switch being off, read through the callee's summary: it lets every request through while enforcement is disabled.",
      },
    ],
  },
  defence: {
    definition:
      "The branch protects the code from bad input or impossible state: a null or type check, an invariant, a parse failure. It would be written whatever the product's rules were.",
    examples: [
      {
        branch: '¬(Array.isArray(v0)) ⇒ throw new TypeError("expected a list")',
        why: "It rejects a malformed argument; no customer rule is involved.",
      },
    ],
  },
  plumbing: {
    definition:
      "The branch moves, fetches, shapes, forwards or retries data, or passes a call through to another function, without deciding anything itself — even when a name it calls sounds like a rule.",
    examples: [
      {
        branch: "⊤ ⇒ return grants.fetch(v0.orgId), grants.fetch [entitlement]",
        why: "It forwards to a lookup; whatever is decided is decided by the caller of the result.",
      },
    ],
  },
  "could-be-data": {
    definition:
      "The branch maps a constant to a constant — a tier to a number, a code to a message — so the decision is one row of a lookup table written as code, and could live in configuration.",
    examples: [
      {
        branch: 'v0 === "team" ⇒ return 25',
        why: "It is one row of a tier-to-seat-count table.",
      },
    ],
  },
};

export const BRANCH_LABEL_INSTRUCTIONS =
  "state is one lowered branch of a function: its path condition as atoms, each with a ref and a span; its outcome; the concepts its identifiers resolved to; and summaries of the functions it calls, including which of their returns each check on a call's result selects. First say which atoms and whether the outcome the label rests on, then pick the label.";

/**
 * The stage-5 question. With `anchors` (the default) each criterion carries its definition and its
 * worked examples; without, the definition alone, so the two can be evaluated side by side.
 */
export function branchLabelQuestion(
  options: { readonly anchors?: boolean } = {},
): ChoiceQuestion<BranchLabel> {
  const anchors = options.anchors ?? true;
  const criteria = Object.fromEntries(
    BRANCH_LABELS.map((label) => {
      const { definition, examples } = BRANCH_LABEL_CRITERIA[label];
      return [label, anchors ? { definition, examples } : definition];
    }),
  ) as Record<
    BranchLabel,
    ChoiceQuestion<BranchLabel>["criteria"][BranchLabel]
  >;
  return {
    type: "choice",
    instructions: BRANCH_LABEL_INSTRUCTIONS,
    criteria,
  };
}

// ── the state stage 5 asks on ─────────────────────────────────────────────

export type StateAtom = {
  readonly ref: string;
  readonly text: string;
  readonly span: SourceSpan;
};

/**
 * What Jev is shown about one branch: the lowered branch with its resolved concepts and its callees'
 * summaries. Never the raw function source.
 */
export type BranchLabelState = {
  readonly branch: string;
  readonly atoms: readonly StateAtom[];
  readonly outcome: { readonly text: string; readonly span: SourceSpan };
  readonly bindings: readonly string[];
  readonly concepts: readonly {
    readonly identifier: string;
    readonly site: string;
    readonly concept: string;
  }[];
  readonly callees: readonly {
    readonly callee: string;
    readonly returns: readonly string[];
    /** Each of the callee's branches with its label, or `unknown` where it settled below the floor. */
    readonly labels: readonly {
      readonly branch: string;
      readonly label: string;
    }[];
  }[];
  readonly returnChecks: readonly {
    readonly atom: string;
    readonly callee: string;
    readonly selects: readonly string[];
  }[];
};

type Request = LabelRequest<BranchLabel, BranchJudgement>;

/** The state stage 5 asks on for one request. */
export function branchLabelState(request: Request): BranchLabelState {
  const { branch, resolutions } = request.branch;
  return {
    branch: request.id,
    atoms: branch.path.map((atom, i) => ({
      ref: `a${i}`,
      text: renderAtom(atom),
      span: atom.span,
    })),
    outcome: { text: renderOutcome(branch.outcome), span: request.span },
    bindings: branch.bindings.map((b) => `${b.local} = ${renderTerm(b.init)}`),
    concepts: resolutions.map((r) => ({
      identifier: r.identifier,
      site: r.site,
      concept: r._tag === "resolved" ? `${r.kind} ${r.concept}` : "unresolved",
    })),
    callees: request.callees.map(({ callee, summary }) =>
      summary._tag === "known"
        ? {
            callee,
            returns: summary.value.returns.map(renderReturnFact),
            labels: summary.value.branches.map((record) => ({
              branch: record.id,
              label: labelText(record),
            })),
          }
        : {
            callee,
            returns: [],
            labels: [{ branch: callee, label: "unknown" }],
          },
    ),
    returnChecks: request.returns.map((r) => ({
      atom: renderAtom(r.atom),
      callee: r.callee,
      selects: r.returns.map(renderReturnFact),
    })),
  };
}

function labelText(record: LabelRecord<BranchLabel, BranchJudgement>): string {
  return record._tag === "labelled" && record.label._tag === "known"
    ? record.label.value
    : "unknown";
}

// ── evidence before the verdict ───────────────────────────────────────────

/** An atom or the outcome a label rests on, as Jev named it before it gave the label. */
export interface EvidenceItem {
  readonly ref: string;
  readonly text: string;
  readonly span: SourceSpan;
  /** Jev's yes/no on "the label rests on this", from 0 to 1; an item is evidence at 0.5 or above. */
  readonly weight: number;
}

/** A stage-5 answer: the label and confidence, with the evidence it rests on beside them. */
export interface BranchJudgement extends Judgement<BranchLabel> {
  readonly evidence: readonly EvidenceItem[];
}

const EVIDENCE_PREFIX = "evidence.";

const isBranchState = (state: JevState): state is BranchLabelState =>
  typeof state === "object" &&
  state !== null &&
  !Array.isArray(state) &&
  Array.isArray((state as { atoms?: unknown }).atoms) &&
  typeof (state as { outcome?: { text?: unknown } }).outcome?.text === "string";

/** Every item Jev is asked to weigh: each atom by its ref, then the outcome. */
function evidenceCandidates(state: JevState): readonly StateAtom[] {
  if (!isBranchState(state)) return [];
  return [
    ...state.atoms,
    { ref: "outcome", text: state.outcome.text, span: state.outcome.span },
  ];
}

/**
 * The question map for one branch: a yes/no per atom and the outcome, asked before `verdict`, so the
 * evidence is named first and the label second.
 */
export function branchLabelQuestions(
  state: JevState,
  verdict: ChoiceQuestion<BranchLabel>,
): JevQuestionMap {
  const evidence = Object.fromEntries(
    evidenceCandidates(state).map((c): [string, JevNoulQuestion] => [
      `${EVIDENCE_PREFIX}${c.ref}`,
      {
        type: "noul",
        instructions: {
          question: `Does the label of this branch rest on ${c.ref === "outcome" ? "its outcome" : `atom ${c.ref}`}?`,
          item: c.text,
        },
      },
    ]),
  );
  return { ...evidence, verdict };
}

/** Builds a client for one question map; a run hands back `httpJevClient`, a test a stub. */
export type Connect = (questions: JevQuestionMap) => JevClient<JevQuestionMap>;

async function askWithEvidence(
  connect: Connect,
  verdict: ChoiceQuestion<BranchLabel>,
  state: JevState,
) {
  const ok = await connect(branchLabelQuestions(state, verdict))(state);
  const answer = ok.answers.verdict;
  if (answer?.type !== "choice")
    throw new TypeError("stage 5: Jev returned no choice under verdict");
  const choice = answer as JevChoiceAnswer<BranchLabel>;
  const evidence = evidenceCandidates(state).flatMap((c): EvidenceItem[] => {
    const weighed = ok.answers[`${EVIDENCE_PREFIX}${c.ref}`];
    return weighed?.type === "noul" && weighed.noul >= 0.5
      ? [{ ...c, weight: weighed.noul }]
      : [];
  });
  return { ok, choice, evidence };
}

/** The stage-5 asker: evidence first, then the label, recorded together. */
export const askBranchLabel =
  (
    connect: Connect,
    question: ChoiceQuestion<BranchLabel> = branchLabelQuestion(),
  ): Asker<BranchLabel, BranchJudgement> =>
  async (state) => {
    const { choice, evidence } = await askWithEvidence(
      connect,
      question,
      state,
    );
    return { label: choice.choice, confidence: choice.confidence, evidence };
  };

/**
 * `connect` for `evaluate`: every wording is asked the way a run asks it, evidence questions first,
 * and `evaluate` reads the verdict.
 */
export const evidenceFirst =
  (connect: Connect): EvaluateOptions<BranchLabel>["connect"] =>
  (questions: ChoiceQuestions<BranchLabel>) =>
  async (state) => {
    const { ok, choice } = await askWithEvidence(
      connect,
      questions.verdict,
      state,
    );
    return { ...ok, answers: { verdict: choice } };
  };

// ── gating ────────────────────────────────────────────────────────────────

export interface BranchLabelOptions {
  /** Built by `gatePolicy` from stage 5's own calibration. */
  readonly policy: GatePolicy;
  readonly ask: Asker<BranchLabel, BranchJudgement>;
  readonly enrich: Enrich<BranchLabel, BranchJudgement>;
}

export type LabelledBranch = Extract<
  LabelRecord<BranchLabel, BranchJudgement>,
  { _tag: "labelled" }
>;

export const BRANCH_LABEL_STAGE = "branch-label";

/**
 * Stage 5 over a batch of branches, through `gateAll`: a promoted answer is a known label, an
 * abstained one an `unknown` fact and a human-queue entry, and each record keeps its evidence.
 */
export async function labelBranches(
  requests: readonly Request[],
  options: BranchLabelOptions,
): Promise<{
  readonly records: readonly LabelledBranch[];
  readonly gated: Gated<BranchLabel, BranchJudgement>;
}> {
  const items: GateItem[] = requests.map((r) => ({
    id: r.id,
    span: r.span,
    state: branchLabelState(r),
  }));
  const gated = await gateAll(BRANCH_LABEL_STAGE, items, options);
  const records = gated.facts.map((fact, i): LabelledBranch => {
    const settled = gated.settled[i];
    if (settled === undefined)
      throw new Error(`stage 5: no settled answer for ${fact.id}`);
    return {
      _tag: "labelled",
      id: fact.id,
      span: fact.span,
      label: fact.value,
      answer: settled.judgement,
      rounds: settled._tag === "promoted" ? settled.round : settled.rounds,
    };
  });
  return { records, gated };
}

/** Stage 5 as the stage-4 walk runs it, per SCC. */
export function branchLabeller(
  options: BranchLabelOptions & {
    readonly question?: ChoiceQuestion<BranchLabel>;
  },
): Labeller<BranchLabel, BranchJudgement> {
  return {
    stage: BRANCH_LABEL_STAGE,
    floor: options.policy.floor,
    identity: {
      question: options.question ?? branchLabelQuestion(),
      floor: options.policy.floor,
      maxRounds: options.policy.maxRounds,
    },
    label: async (requests) => (await labelBranches(requests, options)).records,
  };
}

// ── the #410 comparison ───────────────────────────────────────────────────

export interface AnchoringOptions
  extends Omit<EvaluateOptions<BranchLabel>, "question" | "connect" | "gold"> {
  readonly gold: GoldSet<BranchLabel>;
  readonly connect: Connect;
}

/**
 * Evaluate one gold set with and without the anchoring examples, evidence first in both, so the
 * flip-rate difference the examples make is one call.
 */
export async function evaluateAnchoring(options: AnchoringOptions): Promise<{
  readonly anchored: Evaluation<BranchLabel>;
  readonly bare: Evaluation<BranchLabel>;
}> {
  const { connect, ...rest } = options;
  const run = (anchors: boolean) =>
    evaluate({
      ...rest,
      question: branchLabelQuestion({ anchors }),
      connect: evidenceFirst(connect),
    });
  return { anchored: await run(true), bare: await run(false) };
}
