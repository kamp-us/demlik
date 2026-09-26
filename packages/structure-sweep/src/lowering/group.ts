import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JevState, JevText } from "@demlik/tea/jev";
import { z } from "zod";
import type { JevClient } from "../jev.js";
import {
  canonicalJson,
  type Stage,
  type StageArtifact,
  type StageInput,
} from "./artifact.js";
import type {
  Asker,
  ChoiceQuestion,
  ChoiceQuestions,
  Judgement,
} from "./ask.js";
import {
  type BranchVector,
  DEFAULT_SIMILARITY_THRESHOLD,
  EMBED_STAGE,
  nearestNeighbourPairs,
  similarityThreshold,
  textHash,
} from "./embed.js";
import {
  derived,
  type Fact,
  factValueSchema,
  type SourceSpan,
  SourceSpan as SourceSpanSchema,
} from "./fact.js";
import {
  type Enrich,
  type GateItem,
  type GatePolicy,
  gateAll,
} from "./gate.js";
import { type ResolvedBranch, resolveStage } from "./lexicon.js";
import {
  type Atom,
  type LoweredBranch,
  type Outcome,
  renderAtom,
  renderOutcome,
  renderTerm,
  type Term,
} from "./lower.js";

// ── the named rules ───────────────────────────────────────────────────────

/**
 * The resolver rules stage 6 adds to the canonical key, by name, each pinned by its own fixture on
 * held-out synthetic cases. `deny-outcome` (the issue's polarity normalization, in the form this
 * lowering needs): a `throw` of any value and a `return false` normalize to one outcome, `deny`, so a
 * guard that throws on the denied case and one that returns `false` on it key alike. A bare `return`,
 * `return null` and `return 0` are not `deny`.
 */
export const GROUPING_RULES = ["deny-outcome"] as const;

export type GroupingRule = (typeof GROUPING_RULES)[number];

/** The normalized outcome every `deny-outcome` branch keys on. */
export const DENY = "deny";

// ── the graph input ───────────────────────────────────────────────────────

const DataBindingKind = z.enum(["d1", "durable-object", "kv", "queue", "r2"]);

/**
 * One `Graph.data` edge of a code-graph `--graph` JSON file (`--data`): a binding call site inside
 * a named function. Read through this schema because the sweep's graph reader does not parse `data`.
 */
export const DataEdgeRow = z.object({
  functionId: z.string().min(1),
  ownerService: z.string(),
  binding: z.string().min(1),
  bindingKind: DataBindingKind,
  method: z.string().nullable(),
  access: z.enum(["read", "unknown", "write"]),
  line: z.number().int(),
  column: z.number().int(),
});

export type DataEdgeRow = z.infer<typeof DataEdgeRow>;

const CallerSite = z.object({ callerId: z.string(), line: z.number().int() });

/**
 * A code-graph `--graph` JSON file, parsed to what stages 6 to 8 read: each function's file and
 * callers, and the `data` report's attributed edges. `unattributed` sites name no function, so they
 * are never read. A graph with no `data` (null, or a file from before `--data`) reads as `null`.
 */
export const GroupingGraph = z.object({
  functions: z.array(
    z.object({
      id: z.string().min(1),
      file: z.string().min(1),
      edges: z
        .object({ calledBy: z.array(CallerSite).default([]) })
        .nullable()
        .default(null),
    }),
  ),
  data: z
    .object({ edges: z.array(DataEdgeRow) })
    .nullish()
    .transform((data) => data ?? null),
});

export type GroupingGraph = z.infer<typeof GroupingGraph>;

export const readGroupingGraph = (path: string): GroupingGraph =>
  GroupingGraph.parse(JSON.parse(readFileSync(path, "utf8")));

// ── the candidate cluster ─────────────────────────────────────────────────

/** A branch's canonical key: its atoms as an order-independent set, and its normalized outcome. */
export const ConditionKey = z.strictObject({
  atoms: z.array(z.string()),
  outcome: z.string(),
});

export type ConditionKey = z.infer<typeof ConditionKey>;

/** One binding as the data signal keys it: the service that declares it, its kind and its name. */
export const DataBinding = z.strictObject({
  ownerService: z.string(),
  bindingKind: DataBindingKind,
  binding: z.string().min(1),
});

export type DataBinding = z.infer<typeof DataBinding>;

/**
 * Why branches are one candidate: an equal condition key, functions that touch one binding, or
 * nearest-neighbour branches whose embedded lowered texts are at least the threshold similar. An
 * `embedding` basis names the content hashes of the one or two texts its members carry, and their
 * cosine similarity to four places.
 */
export const ClusterBasis = z.discriminatedUnion("_tag", [
  z.strictObject({ _tag: z.literal("condition"), key: ConditionKey }),
  z.strictObject({ _tag: z.literal("data"), binding: DataBinding }),
  z.strictObject({
    _tag: z.literal("embedding"),
    texts: z.array(z.string().min(1)).min(1).max(2),
    similarity: z.number().min(-1).max(1),
  }),
]);

export type ClusterBasis = z.infer<typeof ClusterBasis>;

/** One branch of a cluster, with its span and its lowered text as a reader of the cluster sees it. */
export const ClusterMember = z.strictObject({
  branch: z.string().min(1),
  function: z.string().min(1),
  span: SourceSpanSchema,
  atoms: z.array(z.string()),
  outcome: z.string(),
  bindings: z.array(z.string()),
});

export type ClusterMember = z.infer<typeof ClusterMember>;

/**
 * N branches that stage 6 put together, from at least two functions: never a pair of functions,
 * and never a group until Jev confirms it.
 */
export const CandidateCluster = z
  .strictObject({
    id: z.string().min(1),
    basis: ClusterBasis,
    members: z.array(ClusterMember).min(2),
  })
  .refine((c) => new Set(c.members.map((m) => m.function)).size >= 2, {
    message: "a cluster holds branches from at least two functions",
  });

export type CandidateCluster = z.infer<typeof CandidateCluster>;

/** A cluster's id: a hash of its basis, so the same key names the same cluster on every run. */
export const clusterId = (basis: ClusterBasis): string =>
  `g-${createHash("sha256").update(canonicalJson(basis)).digest("hex").slice(0, 12)}`;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedSet = (xs: readonly string[]) => [...new Set(xs)].sort(byText);

/** A term as the key reads it: a free path the lexicon resolved is its concept, not its name. */
function keyTerm(term: Term, concepts: ReadonlyMap<string, string>): string {
  switch (term.kind) {
    case "free":
      return concepts.get(term.path) ?? term.path;
    case "member":
      return `${keyTerm(term.object, concepts)}.${term.property}`;
    case "call":
      return `${keyTerm(term.callee, concepts)}(${term.args.map((a) => keyTerm(a, concepts)).join(", ")})`;
    default:
      return renderTerm(term);
  }
}

/** An atom as the key reads it: `renderAtom`'s form, an `any`'s disjuncts and conjuncts sorted. */
function keyAtom(atom: Atom, concepts: ReadonlyMap<string, string>): string {
  const sign = (polarity: boolean, text: string) =>
    polarity ? text : `¬(${text})`;
  const term = (t: Term) => keyTerm(t, concepts);
  switch (atom.kind) {
    case "compare":
      return sign(
        atom.polarity,
        `${term(atom.left)} ${atom.operator} ${term(atom.right)}`,
      );
    case "predicate":
      return sign(atom.polarity, term(atom.call));
    case "in":
      return sign(atom.polarity, `${term(atom.key)} in ${term(atom.object)}`);
    case "instanceof":
      return sign(
        atom.polarity,
        `${term(atom.value)} instanceof ${term(atom.type)}`,
      );
    case "truthy":
      return sign(atom.polarity, term(atom.subject));
    case "any":
      return `(${sortedSet(
        atom.disjuncts.map((d) =>
          sortedSet(d.map((a) => keyAtom(a, concepts))).join(" ∧ "),
        ),
      ).join(" ∨ ")})`;
  }
}

/** The outcome as the key reads it, `deny-outcome` applied. */
function keyOutcome(
  outcome: Outcome,
  concepts: ReadonlyMap<string, string>,
): string {
  switch (outcome.kind) {
    case "throw":
      return DENY;
    case "return":
      if (outcome.value === null) return "return";
      if (outcome.value.kind === "literal" && outcome.value.raw === "false")
        return DENY;
      return `return ${keyTerm(outcome.value, concepts)}`;
    case "call":
      return `call ${keyTerm(outcome.call, concepts)}`;
  }
}

/**
 * Reduce one stage-3-resolved branch to its canonical key. Stage 2's neutral names already remove
 * local and parameter names; the atoms become a sorted set, so their order does not matter; an
 * identifier the lexicon resolved reads as its concept (`⟨flag project-caps⟩`); and the outcome is
 * normalized under `deny-outcome`.
 */
export function conditionKey(resolved: ResolvedBranch): ConditionKey {
  const concepts = new Map<string, string>();
  for (const r of resolved.resolutions)
    if (r._tag === "resolved")
      concepts.set(r.identifier, `⟨${r.kind} ${r.concept}⟩`);
  const { branch } = resolved;
  return {
    atoms: sortedSet(branch.path.map((atom) => keyAtom(atom, concepts))),
    outcome: keyOutcome(branch.outcome, concepts),
  };
}

function memberOf(id: string, span: SourceSpan, branch: LoweredBranch) {
  return {
    branch: id,
    function: branch.function,
    span,
    atoms: branch.path.map(renderAtom),
    outcome: renderOutcome(branch.outcome),
    bindings: branch.bindings.map((b) => `${b.local} = ${renderTerm(b.init)}`),
  } satisfies ClusterMember;
}

function clusterFact(
  basis: ClusterBasis,
  members: readonly ClusterMember[],
): Fact<CandidateCluster> | null {
  const sorted = [...members].sort((a, b) => byText(a.branch, b.branch));
  const [first] = sorted;
  if (
    first === undefined ||
    sorted.length < 2 ||
    new Set(sorted.map((m) => m.function)).size < 2
  )
    return null;
  const cluster = { id: clusterId(basis), basis, members: sorted };
  return { id: cluster.id, span: first.span, value: derived(cluster) };
}

/** The embedding candidate source: every branch's vector, and the similarity a pair must reach. */
export interface EmbeddingCandidates {
  readonly vectors: readonly Fact<BranchVector>[];
  readonly threshold: number;
}

const roundSimilarity = (similarity: number) =>
  Math.round(similarity * 10_000) / 10_000;

/**
 * Cluster branches, with no Jev call. Branches whose condition keys are equal form one candidate;
 * with `data`, so do the branches of every function whose data edges touch one binding, whatever
 * their atoms; with `embedding`, so does each branch and its nearest neighbour in another function
 * when their vectors are at least the threshold similar and their condition keys differ. Each
 * cluster holds at least two branches from at least two functions. A branch can sit in clusters on
 * several signals at once; they are separate candidates.
 */
export function clusterBranches(
  branches: readonly Fact<ResolvedBranch>[],
  data: readonly DataEdgeRow[] | null,
  embedding?: EmbeddingCandidates,
): readonly Fact<CandidateCluster>[] {
  const byKey = new Map<
    string,
    { basis: ClusterBasis; members: ClusterMember[] }
  >();
  const byFunction = new Map<string, ClusterMember[]>();
  const byBranch = new Map<string, { member: ClusterMember; key: string }>();
  const join = (basis: ClusterBasis, members: readonly ClusterMember[]) => {
    const key = canonicalJson(basis);
    const entry = byKey.get(key) ?? { basis, members: [] };
    const seen = new Set(entry.members.map((m) => m.branch));
    for (const member of members)
      if (!seen.has(member.branch)) entry.members.push(member);
    byKey.set(key, entry);
  };
  for (const fact of branches) {
    if (fact.value._tag !== "known") continue;
    const resolved = fact.value.value;
    const member = memberOf(fact.id, fact.span, resolved.branch);
    const basis: ClusterBasis = {
      _tag: "condition",
      key: conditionKey(resolved),
    };
    const key = canonicalJson(basis);
    const entry = byKey.get(key) ?? { basis, members: [] };
    entry.members.push(member);
    byKey.set(key, entry);
    byBranch.set(fact.id, { member, key });
    byFunction.set(member.function, [
      ...(byFunction.get(member.function) ?? []),
      member,
    ]);
  }
  for (const edge of data ?? []) {
    const basis: ClusterBasis = {
      _tag: "data",
      binding: {
        ownerService: edge.ownerService,
        bindingKind: edge.bindingKind,
        binding: edge.binding,
      },
    };
    join(basis, byFunction.get(edge.functionId) ?? []);
  }
  if (embedding !== undefined) {
    const vectorOf = new Map(
      embedding.vectors.flatMap((f) =>
        f.value._tag === "known" ? [[f.id, f.value.value] as const] : [],
      ),
    );
    const embedded = [...byBranch.values()].flatMap(({ member }) => {
      const v = vectorOf.get(member.branch);
      return v === undefined
        ? []
        : [
            {
              branch: member.branch,
              function: member.function,
              text: v.text,
              vector: v.vector,
            },
          ];
    });
    const textOf = new Map(embedded.map((e) => [e.branch, e.text]));
    for (const pair of nearestNeighbourPairs(embedded, embedding.threshold)) {
      const [a, b] = pair.branches.map((id) => byBranch.get(id));
      // Equal condition keys are already one candidate on the condition signal.
      if (a === undefined || b === undefined || a.key === b.key) continue;
      const basis: ClusterBasis = {
        _tag: "embedding",
        texts: sortedSet(
          pair.branches.map((id) => textHash(textOf.get(id) ?? "")),
        ),
        similarity: roundSimilarity(pair.similarity),
      };
      join(basis, [a.member, b.member]);
    }
  }
  return [...byKey.values()]
    .flatMap(({ basis, members }) => {
      const fact = clusterFact(basis, members);
      return fact === null ? [] : [fact];
    })
    .sort((a, b) => byText(a.id, b.id));
}

const ClusterContent = z.strictObject({
  data: z.array(DataEdgeRow).nullable(),
  embedding: z.strictObject({ threshold: z.number() }).optional(),
});

const resolvedFactsOf = (
  artifacts: readonly StageArtifact<unknown>[],
): readonly Fact<ResolvedBranch>[] =>
  artifacts.flatMap((artifact) => {
    if (artifact.stage !== resolveStage.name)
      throw new TypeError(
        `stage 6 reads "${resolveStage.name}" artifacts, not "${artifact.stage}"`,
      );
    return (artifact as StageArtifact<ResolvedBranch>).facts;
  });

/** The embedding candidate source, as stage 6's input takes it. */
export interface ClusterEmbedding {
  /** Every file's embedding-stage artifact (`embeddingStage` over its stage-2 artifact). */
  readonly vectors: readonly StageArtifact<BranchVector>[];
  /** The similarity a nearest-neighbour pair must reach. Defaults to `DEFAULT_SIMILARITY_THRESHOLD`. */
  readonly threshold?: number;
}

/**
 * Stage 6's input: every file's stage-3 artifact, and the graph's data edges on the functions those
 * artifacts hold (or `null` without `--data`). With `embedding`, every file's vector artifact
 * follows the stage-3 artifacts and the threshold enters the content; without it, the input and its
 * key are exactly what they were before the embedding source existed. Artifacts are keyed in digest
 * order, so the order a caller lists files in does not change the key.
 */
export function clusterInput(
  resolved: readonly StageArtifact<ResolvedBranch>[],
  data: GroupingGraph["data"] = null,
  embedding?: ClusterEmbedding,
): StageInput {
  const artifacts = [...resolved].sort((a, b) => byText(a.digest, b.digest));
  const functions = new Set(
    resolvedFactsOf(artifacts).flatMap((f) =>
      f.value._tag === "known" ? [f.value.value.branch.function] : [],
    ),
  );
  const edges =
    data === null
      ? null
      : data.edges
          .filter((e) => functions.has(e.functionId))
          .map((e) => DataEdgeRow.parse(e))
          .sort((a, b) => byText(canonicalJson(a), canonicalJson(b)));
  if (embedding === undefined)
    return { content: canonicalJson({ data: edges }), artifacts };
  for (const artifact of embedding.vectors)
    if (artifact.stage !== EMBED_STAGE)
      throw new TypeError(
        `stage 6 embeds from "${EMBED_STAGE}" artifacts, not "${artifact.stage}"`,
      );
  const threshold = similarityThreshold(
    embedding.threshold ?? DEFAULT_SIMILARITY_THRESHOLD,
  );
  return {
    content: canonicalJson({ data: edges, embedding: { threshold } }),
    artifacts: [
      ...artifacts,
      ...[...embedding.vectors].sort((a, b) => byText(a.digest, b.digest)),
    ],
  };
}

/** Stage 6, deterministic half: one fact per candidate cluster. It makes no Jev call. */
export const clusterStage: Stage<CandidateCluster> = {
  name: "cluster",
  version: "1",
  run: async (input) => {
    const { data, embedding } = ClusterContent.parse(JSON.parse(input.content));
    const vectors = input.artifacts.filter((a) => a.stage === EMBED_STAGE);
    if (embedding === undefined && vectors.length > 0)
      throw new TypeError(
        `stage 6 read "${EMBED_STAGE}" artifacts with no similarity threshold in its content`,
      );
    const resolved = resolvedFactsOf(
      input.artifacts.filter((a) => a.stage !== EMBED_STAGE),
    );
    return clusterBranches(
      resolved,
      data,
      embedding === undefined
        ? undefined
        : {
            vectors: vectors.flatMap(
              (a) => (a as StageArtifact<BranchVector>).facts,
            ),
            threshold: embedding.threshold,
          },
    );
  },
};

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
  /**
   * Why the members are one candidate: the condition key they share, the binding they touch, or how
   * similar their embedded lowered texts are.
   */
  readonly shared:
    | {
        readonly signal: "condition";
        readonly atoms: readonly string[];
        readonly outcome: string;
      }
    | { readonly signal: "data"; readonly binding: string }
    | { readonly signal: "embedding"; readonly similarity: number };
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

/** A function id's own name, without the file it is in. */
const functionName = (id: string) => id.slice(id.lastIndexOf(":") + 1);

/**
 * What stage 6 asks about one cluster. The differences are computed, not asked: per member, the
 * atoms not every member has, and its outcome when the members' outcomes are not all one text.
 */
export function clusterQuestionState(
  cluster: CandidateCluster,
): ClusterQuestionState {
  const members = cluster.members.map((m, i) => ({
    ref: `m${i}`,
    function: functionName(m.function),
    atoms: m.atoms,
    outcome: m.outcome,
    bindings: m.bindings,
  }));
  const common = new Set(
    members[0]?.atoms.filter((a) => members.every((m) => m.atoms.includes(a))),
  );
  const outcomesDiffer = new Set(members.map((m) => m.outcome)).size > 1;
  const differences = members.flatMap((m): ClusterDifference[] => {
    const atoms = m.atoms.filter((a) => !common.has(a));
    return atoms.length === 0 && !outcomesDiffer
      ? []
      : [{ ref: m.ref, atoms, outcome: outcomesDiffer ? m.outcome : null }];
  });
  return {
    cluster: cluster.id,
    shared: sharedOf(cluster.basis),
    members,
    differences,
  };
}

function sharedOf(basis: ClusterBasis): ClusterQuestionState["shared"] {
  switch (basis._tag) {
    case "condition":
      return { signal: "condition", ...basis.key };
    case "data":
      return {
        signal: "data",
        binding: `${basis.binding.bindingKind} ${basis.binding.binding} (service ${basis.binding.ownerService})`,
      };
    case "embedding":
      return { signal: "embedding", similarity: basis.similarity };
  }
}

// ── the confirm stage ─────────────────────────────────────────────────────

const GroupVerdictSchema = z.enum(GROUP_VERDICTS);

export const GroupJudgementSchema = z.strictObject({
  label: GroupVerdictSchema,
  confidence: z.number().min(0).max(1),
  probabilities: z.record(GroupVerdictSchema, z.number()),
});

/**
 * Where one candidate came to rest: its verdict (`known` when the gate promoted it, `unknown` when
 * it abstained), the answer the gate settled on, and how many enrichment rounds it took.
 */
export const ClusterRecord = z.strictObject({
  cluster: CandidateCluster,
  verdict: factValueSchema(GroupVerdictSchema),
  answer: GroupJudgementSchema,
  rounds: z.number().int().min(0),
});

export type ClusterRecord = z.infer<typeof ClusterRecord>;

export const GROUP_CONFIRM_STAGE = "group-confirm";

export interface ConfirmOptions {
  /** Built by `gatePolicy` from stage 6's own calibration over its gold set. */
  readonly policy: GatePolicy;
  readonly ask: Asker<GroupVerdict, GroupJudgement>;
  readonly enrich: Enrich<GroupVerdict, GroupJudgement>;
  /** The question `ask` asks; part of the stage's key. Defaults to `groupConfirmQuestion()`. */
  readonly question?: ChoiceQuestion<GroupVerdict>;
}

/** The confirm stage's input: the cluster artifact, keyed with the question and policy it is asked under. */
export function confirmInput(
  clusters: StageArtifact<CandidateCluster>,
  options: ConfirmOptions,
): StageInput {
  return {
    content: canonicalJson({
      question: options.question ?? groupConfirmQuestion(),
      floor: options.policy.floor,
      maxRounds: options.policy.maxRounds,
    }),
    artifacts: [clusters],
  };
}

/**
 * Stage 6, Jev half: asks the confirm question per candidate cluster through `gateAll`, and writes
 * one record per cluster. A repeat run over the same store is a `hit` and asks nothing.
 */
export function confirmStage(options: ConfirmOptions): Stage<ClusterRecord> {
  return {
    name: GROUP_CONFIRM_STAGE,
    version: "1",
    run: async (input) => {
      const [clusters, ...rest] = input.artifacts;
      if (
        clusters === undefined ||
        rest.length > 0 ||
        clusters.stage !== clusterStage.name
      )
        throw new TypeError(
          `stage 6 confirms exactly one "${clusterStage.name}" artifact`,
        );
      const candidates = (
        clusters as StageArtifact<CandidateCluster>
      ).facts.flatMap((f) =>
        f.value._tag === "known" ? [{ fact: f, cluster: f.value.value }] : [],
      );
      const items: GateItem[] = candidates.map(({ fact, cluster }) => ({
        id: cluster.id,
        span: fact.span,
        state: clusterQuestionState(cluster),
      }));
      const gated = await gateAll(GROUP_CONFIRM_STAGE, items, options);
      return candidates.map(({ fact, cluster }, i): Fact<ClusterRecord> => {
        const settled = gated.settled[i];
        const verdict = gated.facts[i];
        if (settled === undefined || verdict === undefined)
          throw new Error(`stage 6: no settled answer for ${cluster.id}`);
        return {
          id: cluster.id,
          span: fact.span,
          value: derived({
            cluster,
            verdict: verdict.value,
            answer: settled.judgement,
            rounds:
              settled._tag === "promoted" ? settled.round : settled.rounds,
          }),
        };
      });
    },
  };
}

// ── reading the records ───────────────────────────────────────────────────

/** A confirmed cluster is a rule group; a rejected or abstained one is a human-queue entry. */
export type ClusterStatus = "confirmed" | "rejected" | "abstained";

export function clusterStatus(record: ClusterRecord): ClusterStatus {
  if (record.verdict._tag === "unknown") return "abstained";
  return record.verdict.value === "same-rule" ? "confirmed" : "rejected";
}

/** A rule group: one fact, N branches with their spans, the cluster Jev confirmed as one rule. */
export interface RuleGroup {
  readonly id: string;
  readonly basis: ClusterBasis;
  readonly members: readonly ClusterMember[];
}

const recordsOf = (records: readonly Fact<ClusterRecord>[]) =>
  records.flatMap((f) => (f.value._tag === "known" ? [f.value.value] : []));

/** Every confirmed cluster as a rule-group fact, promoted on the confirm answer's own basis. */
export function ruleGroups(
  records: readonly Fact<ClusterRecord>[],
): readonly Fact<RuleGroup>[] {
  return records.flatMap((fact): Fact<RuleGroup>[] => {
    if (fact.value._tag !== "known") return [];
    const { cluster, verdict } = fact.value.value;
    if (verdict._tag !== "known" || verdict.value !== "same-rule") return [];
    return [
      {
        id: cluster.id,
        span: fact.span,
        value: {
          _tag: "known",
          value: {
            id: cluster.id,
            basis: cluster.basis,
            members: cluster.members,
          },
          basis: verdict.basis,
        },
      },
    ];
  });
}

export interface GroupQueueEntry {
  readonly id: string;
  readonly span: SourceSpan;
  readonly status: Exclude<ClusterStatus, "confirmed">;
  /** The answer the gate settled on, for a human to confirm or overrule. */
  readonly answer: GroupJudgement;
  readonly rounds: number;
}

/** Every cluster that did not become a rule group: the one place a human touches stage 6. */
export interface GroupQueue {
  readonly stage: typeof GROUP_CONFIRM_STAGE;
  readonly entries: readonly GroupQueueEntry[];
}

export function groupQueue(
  records: readonly Fact<ClusterRecord>[],
): GroupQueue {
  const entries = recordsOf(records).flatMap((record): GroupQueueEntry[] => {
    const status = clusterStatus(record);
    const [first] = record.cluster.members;
    return status === "confirmed" || first === undefined
      ? []
      : [
          {
            id: record.cluster.id,
            span: first.span,
            status,
            answer: record.answer,
            rounds: record.rounds,
          },
        ];
  });
  return { stage: GROUP_CONFIRM_STAGE, entries };
}
