import {
  sccMembers,
  stronglyConnectedComponents,
} from "@demlik/code-graph/scc";
import {
  type ArtifactStore,
  canonicalJson,
  runStage,
  type Stage,
  type StageArtifact,
  type StageRun,
} from "./artifact.js";
import type { Judgement } from "./ask.js";
import {
  type Fact,
  type FactValue,
  type SourceSpan,
  sourceSpan,
  unknownValue,
} from "./fact.js";
import type { HumanQueue, HumanQueueEntry } from "./gate.js";
import type { Resolution, ResolvedBranch } from "./lexicon.js";
import {
  type Atom,
  atomTerms,
  type LoweringGraph,
  outcomeTerms,
  renderAtom,
  renderTerm,
  type Term,
} from "./lower.js";

// ── what a summary carries ────────────────────────────────────────────────

/**
 * One way a function returns: `returns <value> ⇐ <condition>`, read off one of its stage-2 return
 * branches, with the stage-3 concepts that condition resolved to.
 */
export interface ReturnFact {
  readonly branch: string;
  readonly span: SourceSpan;
  /** `null` for a bare `return;`. */
  readonly value: Term | null;
  readonly condition: readonly Atom[];
  readonly resolutions: readonly Resolution[];
}

export function renderReturnFact(fact: ReturnFact): string {
  const value = fact.value === null ? "undefined" : renderTerm(fact.value);
  const condition =
    fact.condition.length === 0
      ? "⊤"
      : fact.condition.map(renderAtom).join(" ∧ ");
  return `returns ${value} ⇐ ${condition}`;
}

/**
 * How one branch was labelled. `labelled` was asked: its label is known when the gate promoted it and
 * `unknown` when the gate abstained, and it keeps the answer the gate settled on. `undetermined` is a
 * branch stage 2 could not lower, which is never asked.
 */
export type LabelRecord<L extends string, A extends Judgement<L>> =
  | {
      readonly _tag: "labelled";
      readonly id: string;
      readonly span: SourceSpan;
      readonly label: FactValue<L>;
      readonly answer: A;
      readonly rounds: number;
    }
  | {
      readonly _tag: "undetermined";
      readonly id: string;
      readonly span: SourceSpan;
    };

/** The label a caller reads off a record: the known label, or `unknown`, never a guess. */
export const labelOf = <L extends string, A extends Judgement<L>>(
  record: LabelRecord<L, A>,
): FactValue<L> =>
  record._tag === "labelled" ? record.label : unknownValue("undetermined");

/** A function's summary: what its return value means, and the stage-5 label of each of its branches. */
export interface FunctionSummary<L extends string, A extends Judgement<L>> {
  readonly function: string;
  readonly returns: readonly ReturnFact[];
  readonly branches: readonly LabelRecord<L, A>[];
}

// ── resolving a caller's check through a callee's returns ─────────────────

/** A caller's atom on a callee's result, and the callee returns under which that atom holds. */
export interface ReturnResolution {
  readonly atom: Atom;
  readonly callee: string;
  readonly returns: readonly ReturnFact[];
}

const FALSY = new Set(["null", "undefined", "false", "0", '""']);
const NULLISH = new Set(["null", "undefined"]);

const leaves = (path: readonly Atom[]): readonly Atom[] =>
  path.flatMap((atom) =>
    atom.kind === "any" ? leaves(atom.disjuncts.flat()) : [atom],
  );

/**
 * Resolve each `=== null` / `== null` / truthiness atom on a callee's result — a call, or a `const`
 * bound to one — into the callee returns it selects. An atom on a callee with no known summary is
 * left out: nothing is guessed.
 */
export function resolveReturns<L extends string, A extends Judgement<L>>(
  branch: ResolvedBranch["branch"],
  summaries: ReadonlyMap<string, Fact<FunctionSummary<L, A>>>,
): readonly ReturnResolution[] {
  const bound = new Map(branch.bindings.map((b) => [b.local, b.init]));
  const calleeOf = (term: Term): string | null => {
    const call = term.kind === "local" ? bound.get(term.name) : term;
    return call?.kind === "call" ? call.calleeId : null;
  };
  const out: ReturnResolution[] = [];
  for (const atom of leaves(branch.path)) {
    let subject: Term;
    let selects: (value: string) => boolean;
    if (
      atom.kind === "compare" &&
      (atom.operator === "===" || atom.operator === "==") &&
      atom.right.kind === "literal"
    ) {
      const raw = atom.right.raw;
      const equal =
        atom.operator === "==" && NULLISH.has(raw)
          ? (value: string) => NULLISH.has(value)
          : (value: string) => value === raw;
      subject = atom.left;
      selects = atom.polarity ? equal : (value) => !equal(value);
    } else if (atom.kind === "truthy") {
      subject = atom.subject;
      selects = atom.polarity
        ? (value) => !FALSY.has(value)
        : (value) => FALSY.has(value);
    } else continue;
    const callee = calleeOf(subject);
    const summary = callee === null ? undefined : summaries.get(callee);
    if (callee === null || summary?.value._tag !== "known") continue;
    const returns = summary.value.value.returns.filter((r) =>
      selects(r.value === null ? "undefined" : renderTerm(r.value)),
    );
    out.push({ atom, callee, returns });
  }
  return out;
}

// ── the SCC walk ──────────────────────────────────────────────────────────

/** What stage 5 is asked about one branch: the lowered branch, its concepts and its callees' summaries. */
export interface LabelRequest<L extends string, A extends Judgement<L>> {
  readonly id: string;
  readonly span: SourceSpan;
  readonly branch: ResolvedBranch;
  /** The summary of every callee the branch calls, in id order; a callee in the branch's own SCC has none yet. */
  readonly callees: readonly {
    readonly callee: string;
    readonly summary: FactValue<FunctionSummary<L, A>>;
  }[];
  readonly returns: readonly ReturnResolution[];
}

/** Stage 5 as the walk sees it: labels a batch of branches, and names what it is so a change re-labels. */
export interface Labeller<L extends string, A extends Judgement<L>> {
  readonly stage: string;
  readonly floor: number;
  /** The question and policy the labels come from; part of every SCC's key. */
  readonly identity: unknown;
  readonly label: (
    requests: readonly LabelRequest<L, A>[],
  ) => Promise<readonly Extract<LabelRecord<L, A>, { _tag: "labelled" }>[]>;
}

export interface SummarizeOptions<L extends string, A extends Judgement<L>> {
  readonly graph: LoweringGraph;
  /** Every file's stage-3 artifact. The walk covers the functions these hold facts for. */
  readonly resolved: readonly StageArtifact<ResolvedBranch>[];
  readonly labeller: Labeller<L, A>;
  readonly store: ArtifactStore<FunctionSummary<L, A>>;
}

export interface SccRun<L extends string, A extends Judgement<L>> {
  readonly members: readonly string[];
  readonly run: StageRun<FunctionSummary<L, A>>;
}

export interface Summaries<L extends string, A extends Judgement<L>> {
  /** One run per SCC, leaves first. */
  readonly sccs: readonly SccRun<L, A>[];
  readonly summaries: ReadonlyMap<string, Fact<FunctionSummary<L, A>>>;
  /** Every branch stage 5 abstained on, across every SCC. */
  readonly queue: HumanQueue<L, A>;
}

const SUMMARY_STAGE = { name: "summarize", version: "1" } as const;

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Group stage-3 facts by the function they belong to. */
function factsByFunction(
  resolved: readonly StageArtifact<ResolvedBranch>[],
): Map<string, Fact<ResolvedBranch>[]> {
  const out = new Map<string, Fact<ResolvedBranch>[]>();
  for (const artifact of resolved)
    for (const fact of artifact.facts) {
      const fn =
        fact.value._tag === "known"
          ? fact.value.value.branch.function
          : fact.id;
      out.set(fn, [...(out.get(fn) ?? []), fact]);
    }
  return out;
}

const callsIn = (branch: ResolvedBranch["branch"]): readonly string[] => {
  const ids: string[] = [];
  const visit = (term: Term): void => {
    switch (term.kind) {
      case "call":
        if (term.calleeId !== null) ids.push(term.calleeId);
        visit(term.callee);
        for (const arg of term.args) visit(arg);
        return;
      case "member":
        visit(term.object);
        return;
      default:
        return;
    }
  };
  for (const term of [
    ...branch.path.flatMap(atomTerms),
    ...outcomeTerms(branch.outcome),
    ...branch.bindings.map((b) => b.init),
  ])
    visit(term);
  return [...new Set(ids)].sort(byId);
};

/**
 * Stage 4: condense the call graph by SCC and walk it leaves-first. Each SCC's run labels its
 * branches through stage 5 with every callee's summary in hand, then summarizes its members as one
 * unit. Its key cites the digests of its callees' summary artifacts, so a changed leaf re-runs only
 * the SCCs that reach it.
 */
export async function summarize<L extends string, A extends Judgement<L>>(
  options: SummarizeOptions<L, A>,
): Promise<Summaries<L, A>> {
  const facts = factsByFunction(options.resolved);
  const spans = new Map(
    options.graph.functions.map((fn) => [
      fn.id,
      sourceSpan(fn.file, fn.startLine, Math.max(fn.startLine, fn.endLine)),
    ]),
  );
  const nodes = [...facts.keys()].filter((id) => spans.has(id)).sort(byId);
  const inScope = new Set(nodes);
  const adjacency = new Map<string, string[]>();
  for (const fn of options.graph.functions)
    if (inScope.has(fn.id))
      adjacency.set(
        fn.id,
        [
          ...new Set(
            (fn.edges?.calls ?? [])
              .map((c) => c.calleeId)
              .filter((id) => inScope.has(id)),
          ),
        ].sort(byId),
      );
  const sccOf = stronglyConnectedComponents(nodes, adjacency);
  const members = sccMembers(nodes, sccOf);
  const artifacts = new Map<number, StageArtifact<FunctionSummary<L, A>>>();
  const summaries = new Map<string, Fact<FunctionSummary<L, A>>>();
  const sccs: SccRun<L, A>[] = [];
  const order = [...members.keys()].sort((a, b) => a - b);
  for (const scc of order) {
    const ids = [...(members.get(scc) ?? [])].sort(byId);
    const callees = [
      ...new Set(
        ids.flatMap((id) =>
          (adjacency.get(id) ?? []).map((callee) => sccOf.get(callee)),
        ),
      ),
    ]
      .filter((s): s is number => s !== undefined && s !== scc)
      .sort((a, b) => a - b);
    const calleeArtifacts = callees.flatMap((s) => {
      const artifact = artifacts.get(s);
      return artifact === undefined ? [] : [artifact];
    });
    const memberFacts = ids.map((id) => ({
      id,
      span: spans.get(id) as SourceSpan,
      facts: facts.get(id) ?? [],
    }));
    const stage: Stage<FunctionSummary<L, A>> = {
      ...SUMMARY_STAGE,
      run: () => summarizeScc(memberFacts, summaries, options.labeller),
    };
    const run = await runStage(options.store, stage, {
      content: canonicalJson({
        members: memberFacts,
        labeller: options.labeller.identity,
      }),
      artifacts: calleeArtifacts,
    });
    artifacts.set(scc, run.artifact);
    for (const fact of run.artifact.facts) summaries.set(fact.id, fact);
    sccs.push({ members: ids, run });
  }
  return {
    sccs,
    summaries,
    queue: queueOf(options.labeller, [...summaries.values()]),
  };
}

async function summarizeScc<L extends string, A extends Judgement<L>>(
  members: readonly {
    readonly id: string;
    readonly span: SourceSpan;
    readonly facts: readonly Fact<ResolvedBranch>[];
  }[],
  summaries: ReadonlyMap<string, Fact<FunctionSummary<L, A>>>,
  labeller: Labeller<L, A>,
): Promise<readonly Fact<FunctionSummary<L, A>>[]> {
  const requests: LabelRequest<L, A>[] = [];
  for (const member of members)
    for (const fact of member.facts) {
      if (fact.value._tag !== "known") continue;
      const resolved = fact.value.value;
      requests.push({
        id: fact.id,
        span: fact.span,
        branch: resolved,
        callees: callsIn(resolved.branch).flatMap((callee) => {
          const summary = summaries.get(callee);
          return summary === undefined
            ? []
            : [{ callee, summary: summary.value }];
        }),
        returns: resolveReturns(resolved.branch, summaries),
      });
    }
  const labelled = new Map(
    (requests.length === 0 ? [] : await labeller.label(requests)).map((r) => [
      r.id,
      r,
    ]),
  );
  return members.map((member): Fact<FunctionSummary<L, A>> => {
    const undetermined = member.facts.some(
      (f) => f.id === member.id && f.value._tag === "unknown",
    );
    if (undetermined)
      return {
        id: member.id,
        span: member.span,
        value: unknownValue("undetermined"),
      };
    const returns: ReturnFact[] = [];
    const branches: LabelRecord<L, A>[] = [];
    for (const fact of member.facts) {
      if (fact.value._tag !== "known") {
        branches.push({ _tag: "undetermined", id: fact.id, span: fact.span });
        continue;
      }
      const { branch, resolutions } = fact.value.value;
      if (branch.outcome.kind === "return")
        returns.push({
          branch: fact.id,
          span: fact.span,
          value: branch.outcome.value,
          condition: branch.path,
          resolutions: resolutions.filter((r) => r.site !== "outcome"),
        });
      branches.push(
        labelled.get(fact.id) ?? {
          _tag: "undetermined",
          id: fact.id,
          span: fact.span,
        },
      );
    }
    return {
      id: member.id,
      span: member.span,
      value: {
        _tag: "known",
        value: { function: member.id, returns, branches },
        basis: { _tag: "derived" },
      },
    };
  });
}

function queueOf<L extends string, A extends Judgement<L>>(
  labeller: Labeller<L, A>,
  summaries: readonly Fact<FunctionSummary<L, A>>[],
): HumanQueue<L, A> {
  const entries: HumanQueueEntry<L, A>[] = [];
  for (const summary of summaries) {
    if (summary.value._tag !== "known") continue;
    for (const record of summary.value.value.branches)
      if (
        record._tag === "labelled" &&
        record.label._tag === "unknown" &&
        record.label.reason === "abstained"
      )
        entries.push({
          id: record.id,
          span: record.span,
          answer: record.answer,
          rounds: record.rounds,
        });
  }
  return { stage: labeller.stage, floor: labeller.floor, entries };
}
