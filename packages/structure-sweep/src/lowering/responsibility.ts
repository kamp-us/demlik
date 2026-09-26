import type { JevClient } from "../jev.js";
import type { Vocabulary } from "../vocabulary.js";
import {
  type ArtifactStore,
  canonicalJson,
  runStage,
  type Stage,
  type StageArtifact,
  type StageInput,
  type StageRun,
} from "./artifact.js";
import {
  askVerdict,
  type ChoiceQuestion,
  type ChoiceQuestions,
  type Judgement,
} from "./ask.js";
import {
  derived,
  type Fact,
  type FactValue,
  type SourceSpan,
  sourceSpan,
  unknownValue,
} from "./fact.js";
import {
  type Enrich,
  type GateItem,
  type GatePolicy,
  gateAll,
  type HumanQueue,
  type HumanQueueEntry,
} from "./gate.js";
import type { ResolvedBranch } from "./lexicon.js";
import {
  type LoweringGraph,
  renderAtom,
  renderOutcome,
  renderTerm,
} from "./lower.js";
import {
  type FunctionSummary,
  type LabelRecord,
  renderReturnFact,
} from "./summarize.js";

/** The two answers to "does this function serve this feature". A function can serve several, or none. */
export const RESPONSIBILITY_ANSWERS = ["serves", "does-not-serve"] as const;

export type ResponsibilityAnswer = (typeof RESPONSIBILITY_ANSWERS)[number];

export const RESPONSIBILITY_STAGE = "responsibility";

export const RESPONSIBILITY_INSTRUCTIONS =
  "state.function is one function, lowered: each branch's path condition and outcome, the concepts its identifiers resolved to, and summaries of the functions it calls. state.feature is one product feature of state.product. Say whether this function does work for that feature. Judge the feature named, not the others: a function can serve several features, and plumbing that serves every caller alike serves none.";

/** The question asked once per (function, feature), with the feature in the state. */
export const responsibilityQuestion: ChoiceQuestion<ResponsibilityAnswer> = {
  type: "choice",
  instructions: RESPONSIBILITY_INSTRUCTIONS,
  criteria: {
    serves:
      "The function does work that belongs to this feature: it decides, computes, reads or writes something only this feature needs, or calls into this feature's functions to do so.",
    "does-not-serve":
      "Nothing the function does belongs to this feature: it belongs to other features, or it is shared plumbing — formatting, retries, transport, generic validation — that any feature could call.",
  },
};

// ── what Jev is shown about one function ──────────────────────────────────

/** One lowered branch as the state renders it, with the concepts its identifiers resolved to. */
export type BranchView = {
  readonly branch: string;
  readonly condition: readonly string[];
  readonly outcome: string;
  readonly bindings: readonly string[];
  readonly concepts: readonly {
    readonly identifier: string;
    readonly site: string;
    readonly concept: string;
  }[];
};

/** One callee's stage-4 summary as the state renders it: its returns and its branches' stage-5 labels. */
export type CalleeView = {
  readonly callee: string;
  readonly returns: readonly string[];
  readonly labels: readonly {
    readonly branch: string;
    readonly label: string;
  }[];
};

/**
 * Everything the stage reads about one function, built from stages 2 to 4 and never from its source.
 * `undetermined` is a function stage 2 could not lower: it is never asked.
 */
export type FunctionEvidence =
  | {
      readonly _tag: "lowered";
      readonly function: string;
      readonly branches: readonly BranchView[];
      readonly callees: readonly CalleeView[];
    }
  | { readonly _tag: "undetermined"; readonly function: string };

/** The state one (function, feature) question is asked on. */
export type ResponsibilityState = {
  readonly function: string;
  readonly product: string | null;
  readonly feature: { readonly key: string; readonly description: string };
  readonly branches: readonly BranchView[];
  readonly callees: readonly CalleeView[];
};

/** One function the stage runs over: where it is, and the evidence it is judged on. */
export interface ResponsibilityRequest {
  readonly span: SourceSpan;
  readonly evidence: FunctionEvidence;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function branchView(fact: Fact<ResolvedBranch>): BranchView {
  if (fact.value._tag !== "known")
    return {
      branch: fact.id,
      condition: [],
      outcome: "undetermined",
      bindings: [],
      concepts: [],
    };
  const { branch, resolutions } = fact.value.value;
  return {
    branch: fact.id,
    condition: branch.path.map(renderAtom),
    outcome: renderOutcome(branch.outcome),
    bindings: branch.bindings.map((b) => `${b.local} = ${renderTerm(b.init)}`),
    concepts: resolutions.map((r) => ({
      identifier: r.identifier,
      site: r.site,
      concept: r._tag === "resolved" ? `${r.kind} ${r.concept}` : "unresolved",
    })),
  };
}

function calleeView<L extends string, A extends Judgement<L>>(
  callee: string,
  summary: FactValue<FunctionSummary<L, A>>,
): CalleeView {
  if (summary._tag !== "known")
    return {
      callee,
      returns: [],
      labels: [{ branch: callee, label: "unknown" }],
    };
  const labelText = (record: LabelRecord<L, A>) =>
    record._tag === "labelled" && record.label._tag === "known"
      ? record.label.value
      : "unknown";
  return {
    callee,
    returns: summary.value.returns.map(renderReturnFact),
    labels: summary.value.branches.map((record) => ({
      branch: record.id,
      label: labelText(record),
    })),
  };
}

export interface ResponsibilityRequestsOptions<
  L extends string,
  A extends Judgement<L>,
> {
  readonly graph: LoweringGraph;
  /** Every file's stage-3 artifact. The requests cover the graph's functions in the files these hold facts for. */
  readonly resolved: readonly StageArtifact<ResolvedBranch>[];
  /** Stage 4's summaries, keyed by function id. A callee with no summary here is left out. */
  readonly summaries: ReadonlyMap<string, Fact<FunctionSummary<L, A>>>;
}

/**
 * One request per function: its stage-2 branches with their stage-3 resolutions, and the stage-4
 * summary of every function it calls. A function with no branch still gets a request, judged on its
 * callees alone; one stage 2 could not lower is `undetermined`.
 */
export function responsibilityRequests<
  L extends string,
  A extends Judgement<L>,
>(
  options: ResponsibilityRequestsOptions<L, A>,
): readonly ResponsibilityRequest[] {
  const facts = new Map<string, Fact<ResolvedBranch>[]>();
  const files = new Set<string>();
  for (const artifact of options.resolved)
    for (const fact of artifact.facts) {
      files.add(fact.span.file);
      const fn =
        fact.value._tag === "known"
          ? fact.value.value.branch.function
          : fact.id;
      facts.set(fn, [...(facts.get(fn) ?? []), fact]);
    }
  return options.graph.functions
    .filter((fn) => files.has(fn.file))
    .sort((a, b) => byId(a.id, b.id))
    .map((fn): ResponsibilityRequest => {
      const span = sourceSpan(
        fn.file,
        fn.startLine,
        Math.max(fn.startLine, fn.endLine),
      );
      const own = facts.get(fn.id) ?? [];
      if (own.some((f) => f.id === fn.id && f.value._tag === "unknown"))
        return { span, evidence: { _tag: "undetermined", function: fn.id } };
      const callees = [
        ...new Set((fn.edges?.calls ?? []).map((c) => c.calleeId)),
      ]
        .filter((id) => id !== fn.id)
        .sort(byId)
        .flatMap((callee) => {
          const summary = options.summaries.get(callee);
          return summary === undefined
            ? []
            : [calleeView(callee, summary.value)];
        });
      return {
        span,
        evidence: {
          _tag: "lowered",
          function: fn.id,
          branches: own.map(branchView),
          callees,
        },
      };
    });
}

/** The state one feature is asked on, for one function. */
export function responsibilityState(
  evidence: Extract<FunctionEvidence, { _tag: "lowered" }>,
  vocabulary: {
    readonly product?: string | null;
    readonly features: Vocabulary["features"];
  },
  feature: string,
): ResponsibilityState {
  const description = Object.hasOwn(vocabulary.features, feature)
    ? vocabulary.features[feature]
    : undefined;
  if (description === undefined)
    throw new RangeError(`"${feature}" is not a feature of the vocabulary`);
  return {
    function: evidence.function,
    product: vocabulary.product ?? null,
    feature: { key: feature, description },
    branches: evidence.branches,
    callees: evidence.callees,
  };
}

// ── what the stage writes ─────────────────────────────────────────────────

/**
 * One (function, feature) verdict. `asked` went through the gate: `verdict` is `serves` or
 * `does-not-serve` when it was promoted and `unknown` when it abstained, and `answer` is the answer
 * the gate settled on. `undetermined` belongs to a function stage 2 could not lower, never asked.
 */
export type Responsibility =
  | {
      readonly _tag: "asked";
      readonly function: string;
      readonly feature: string;
      readonly verdict: FactValue<ResponsibilityAnswer>;
      readonly answer: Judgement<ResponsibilityAnswer>;
      readonly rounds: number;
    }
  | {
      readonly _tag: "undetermined";
      readonly function: string;
      readonly feature: string;
    };

/** What a caller reads off a record: `serves`, `does-not-serve`, or `unknown` — never a guess. */
export const verdictOf = (
  record: Responsibility,
): FactValue<ResponsibilityAnswer> =>
  record._tag === "asked" ? record.verdict : unknownValue("undetermined");

/** A (function, feature) fact's id. A feature key never holds `#`, so the pair reads back unambiguously. */
export const responsibilityId = (fn: string, feature: string): string =>
  `${fn}#${feature}`;

export interface ResponsibilityOptions {
  readonly vocabulary: Vocabulary;
  /** Built by `gatePolicy` from this stage's own calibration over its gold set. */
  readonly policy: GatePolicy;
  /** A client for one wording of the question; a run hands back `httpJevClient`, a test a stub. */
  readonly connect: (
    questions: ChoiceQuestions<ResponsibilityAnswer>,
  ) => JevClient<ChoiceQuestions<ResponsibilityAnswer>>;
  readonly enrich: Enrich<ResponsibilityAnswer>;
  readonly question?: ChoiceQuestion<ResponsibilityAnswer>;
}

/** The responsibility stage, with the builder of its per-function input and the floor it gates at. */
export interface ResponsibilityStage extends Stage<Responsibility> {
  readonly floor: number;
  readonly input: (request: ResponsibilityRequest) => StageInput;
}

interface Content {
  readonly span: SourceSpan;
  readonly evidence: FunctionEvidence;
  readonly vocabulary: {
    readonly fingerprint: string;
    readonly product: string | null;
    readonly features: Vocabulary["features"];
  };
  readonly identity: {
    readonly question: ChoiceQuestion<ResponsibilityAnswer>;
    readonly floor: number;
    readonly maxRounds: number;
  };
}

/**
 * The responsibility stage. One run is one function: every vocabulary feature is asked as its own
 * closed two-answer question, all through one `gateAll`, and each writes one fact. The key holds the
 * function's evidence, the vocabulary and the question and policy, so an unchanged function is a hit.
 */
export function responsibilityStage(
  options: ResponsibilityOptions,
): ResponsibilityStage {
  const question = options.question ?? responsibilityQuestion;
  const ask = askVerdict(options.connect({ verdict: question }));
  const { vocabulary, policy } = options;
  const identity = {
    question,
    floor: policy.floor,
    maxRounds: policy.maxRounds,
  };
  return {
    name: RESPONSIBILITY_STAGE,
    version: "1",
    floor: policy.floor,
    input: (request) => ({
      content: canonicalJson({
        span: request.span,
        evidence: request.evidence,
        vocabulary: {
          fingerprint: vocabulary.fingerprint,
          product: vocabulary.product ?? null,
          features: vocabulary.features,
        },
        identity,
      } satisfies Content),
      artifacts: [],
    }),
    run: async (input) => {
      const content = JSON.parse(input.content) as Content;
      if (canonicalJson(content.identity) !== canonicalJson(identity))
        throw new TypeError(
          "the responsibility stage reads an input built for another question or policy",
        );
      const { span, evidence } = content;
      const features = Object.keys(content.vocabulary.features).sort(byId);
      if (evidence._tag === "undetermined")
        return features.map(
          (feature): Fact<Responsibility> => ({
            id: responsibilityId(evidence.function, feature),
            span,
            value: derived({
              _tag: "undetermined",
              function: evidence.function,
              feature,
            }),
          }),
        );
      const items = features.map(
        (feature): GateItem => ({
          id: responsibilityId(evidence.function, feature),
          span,
          state: responsibilityState(evidence, content.vocabulary, feature),
        }),
      );
      const gated = await gateAll(RESPONSIBILITY_STAGE, items, {
        policy,
        ask,
        enrich: options.enrich,
      });
      return gated.facts.map((fact, i): Fact<Responsibility> => {
        const settled = gated.settled[i];
        const feature = features[i];
        if (settled === undefined || feature === undefined)
          throw new Error(`responsibility: no settled answer for ${fact.id}`);
        return {
          id: fact.id,
          span: fact.span,
          value: derived({
            _tag: "asked",
            function: evidence.function,
            feature,
            verdict: fact.value,
            answer: settled.judgement,
            rounds:
              settled._tag === "promoted" ? settled.round : settled.rounds,
          }),
        };
      });
    },
  };
}

export interface LabelResponsibilitiesOptions {
  readonly requests: readonly ResponsibilityRequest[];
  readonly stage: ResponsibilityStage;
  readonly store: ArtifactStore<Responsibility>;
}

export interface Responsibilities {
  /** One run per function, in request order. */
  readonly runs: readonly {
    readonly function: string;
    readonly run: StageRun<Responsibility>;
  }[];
  /** One fact per (function, feature), in request order and then feature order. */
  readonly facts: readonly Fact<Responsibility>[];
  /** Every (function, feature) the gate abstained on, including those read back from a hit. */
  readonly queue: HumanQueue<ResponsibilityAnswer>;
}

/** Run the stage over every function, each through `runStage`, and gather the facts and the human queue. */
export async function labelResponsibilities(
  options: LabelResponsibilitiesOptions,
): Promise<Responsibilities> {
  const runs: Responsibilities["runs"][number][] = [];
  for (const request of options.requests)
    runs.push({
      function: request.evidence.function,
      run: await runStage(
        options.store,
        options.stage,
        options.stage.input(request),
      ),
    });
  const facts = runs.flatMap(({ run }) => run.artifact.facts);
  const entries: HumanQueueEntry<ResponsibilityAnswer>[] = [];
  for (const fact of facts) {
    if (fact.value._tag !== "known") continue;
    const record = fact.value.value;
    if (
      record._tag === "asked" &&
      record.verdict._tag === "unknown" &&
      record.verdict.reason === "abstained"
    )
      entries.push({
        id: fact.id,
        span: fact.span,
        answer: record.answer,
        rounds: record.rounds,
      });
  }
  return {
    runs,
    facts,
    queue: {
      stage: RESPONSIBILITY_STAGE,
      floor: options.stage.floor,
      entries,
    },
  };
}
