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
  derived,
  type Fact,
  factValueSchema,
  type SourceSpan,
  SourceSpan as SourceSpanSchema,
  unknownValue,
} from "./fact.js";
import {
  type Enrich,
  type GateItem,
  type GatePolicy,
  gateAll,
} from "./gate.js";
import {
  type ClusterRecord,
  GROUP_CONFIRM_STAGE,
  type GroupingGraph,
  type RuleGroup,
  ruleGroups,
} from "./group.js";

// ── the layer lookup ──────────────────────────────────────────────────────

/**
 * A file's layer, shaped like code-graph's `LayerRank`: an index into the declared stack, where a
 * higher `rank` is a lower layer. code-graph exports no layer classifier, so the caller injects one.
 */
export interface LayerRank {
  readonly name: string;
  readonly rank: number;
}

export type LayerLookup = (file: string) => LayerRank | null;

const LayerRankSchema = z
  .strictObject({ name: z.string().min(1), rank: z.number().int() })
  .nullable();

// ── the tie-break question ────────────────────────────────────────────────

/** The refs a stage-7 answer picks from: one per tied candidate, in candidate order. */
export const OWNER_REFS = [
  "c0",
  "c1",
  "c2",
  "c3",
  "c4",
  "c5",
  "c6",
  "c7",
] as const;

export type OwnerRef = (typeof OWNER_REFS)[number];

export const OWNER_INSTRUCTIONS =
  "state.candidates are functions that each hold one branch of the rule group state.rule, tied on layer and on how many callers they have. Pick the one the other members should call so the rule has one owner: the candidate whose name, file and outcome make it the natural home of this decision. Answer with the candidate's ref; a ref not listed in state.candidates is never the owner.";

/** The stage-7 question: one criterion per ref, so every tie up to `OWNER_REFS.length` is askable. */
export function ownerQuestion(): ChoiceQuestion<OwnerRef> {
  const criteria = {} as Record<OwnerRef, JevText>;
  for (const ref of OWNER_REFS)
    criteria[ref] = `The candidate listed as ${ref} in state.candidates.`;
  return { type: "choice", instructions: OWNER_INSTRUCTIONS, criteria };
}

export type OwnerQuestionState = {
  readonly group: string;
  readonly rule: {
    readonly atoms: readonly string[];
    readonly outcome: string;
  };
  readonly candidates: readonly {
    readonly ref: OwnerRef;
    readonly function: string;
    readonly file: string;
    readonly layer: string | null;
    readonly fanIn: number;
    readonly atoms: readonly string[];
    readonly outcome: string;
  }[];
};

export interface OwnerJudgement extends Judgement<OwnerRef> {
  readonly probabilities: Readonly<Record<OwnerRef, number>>;
}

export const askOwner =
  (
    client: JevClient<ChoiceQuestions<OwnerRef>>,
  ): Asker<OwnerRef, OwnerJudgement> =>
  async (state: JevState) => {
    const { verdict } = (await client(state)).answers;
    return {
      label: verdict.choice,
      confidence: verdict.confidence,
      probabilities: verdict.probabilities,
    };
  };

// ── the record ────────────────────────────────────────────────────────────

const OwnerRefSchema = z.enum(OWNER_REFS);

export const OwnerJudgementSchema = z.strictObject({
  label: OwnerRefSchema,
  confidence: z.number().min(0).max(1),
  probabilities: z.record(OwnerRefSchema, z.number()),
});

/** One member function a group could be owned by, with the facts stage 7 decided on. */
export const OwnerCandidate = z.strictObject({
  function: z.string().min(1),
  /** The group's branch in this function that the owner's span points at. */
  member: z.string().min(1),
  span: SourceSpanSchema,
  layer: LayerRankSchema,
  /** The function's `edges.calledBy` count in the `--graph` JSON. */
  fanIn: z.number().int().min(0),
});

export type OwnerCandidate = z.infer<typeof OwnerCandidate>;

/** A group's owner: the member the others collapse to, and where it is. */
export const Owner = z.strictObject({
  group: z.string().min(1),
  member: z.string().min(1),
  function: z.string().min(1),
  span: SourceSpanSchema,
});

export type Owner = z.infer<typeof Owner>;

/**
 * How one group's owner was chosen. `candidates` is every member the layer rule narrowed to (every
 * member when one is unlayered), not only the winner. `settledBy` names the step that decided it;
 * `asked` is the Jev tie-break, when there was one.
 */
export const OwnerRecord = z.strictObject({
  group: z.string().min(1),
  span: SourceSpanSchema,
  candidates: z.array(OwnerCandidate).min(1),
  settledBy: z.enum(["layer", "fan-in", "jev"]),
  owner: factValueSchema(Owner),
  asked: z
    .strictObject({
      /** The tied candidates' functions, in ref order: `c0` is the first. */
      tied: z.array(z.string()).min(2),
      /** `null` when the tie was wider than `OWNER_REFS`, so nothing could be asked. */
      answer: OwnerJudgementSchema.nullable(),
      rounds: z.number().int().min(0),
    })
    .nullable(),
});

export type OwnerRecord = z.infer<typeof OwnerRecord>;

// ── the stage ─────────────────────────────────────────────────────────────

const FunctionFacts = z.strictObject({
  file: z.string(),
  layer: LayerRankSchema,
  fanIn: z.number().int().min(0),
  callers: z.array(z.strictObject({ id: z.string(), layer: LayerRankSchema })),
});

const OwnerContent = z.strictObject({
  functions: z.record(z.string(), FunctionFacts),
  identity: z.unknown(),
});

export const OWNER_STAGE = "owner";

export interface OwnerOptions {
  /** Built by `gatePolicy` from stage 7's own calibration. */
  readonly policy: GatePolicy;
  readonly ask: Asker<OwnerRef, OwnerJudgement>;
  readonly enrich: Enrich<OwnerRef, OwnerJudgement>;
  readonly question?: ChoiceQuestion<OwnerRef>;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A code-graph function id's file: everything before its last `:`. */
const fileOfId = (id: string) => id.slice(0, Math.max(0, id.lastIndexOf(":")));

/**
 * Stage 7's input: the confirm artifact, and — for every member function of a confirmed group —
 * its file, its layer, its fan-in and its callers' layers, read off `graph` and `layerOf`. The
 * layer lookup is a function, so what it answered is written into the key, not the function.
 */
export function ownerInput(
  confirmed: StageArtifact<ClusterRecord>,
  options: {
    readonly graph: GroupingGraph;
    readonly layerOf: LayerLookup;
  } & Pick<OwnerOptions, "policy" | "question">,
): StageInput {
  const byId = new Map(options.graph.functions.map((fn) => [fn.id, fn]));
  const members = new Set(
    ruleGroups(confirmed.facts).flatMap((g) =>
      g.value._tag === "known"
        ? g.value.value.members.map((m) => m.function)
        : [],
    ),
  );
  const functions: Record<string, z.infer<typeof FunctionFacts>> = {};
  for (const id of [...members].sort(byText)) {
    const node = byId.get(id);
    const file = node?.file ?? fileOfId(id);
    const calledBy = node?.edges?.calledBy ?? [];
    functions[id] = {
      file,
      layer: options.layerOf(file),
      fanIn: calledBy.length,
      callers: [...new Set(calledBy.map((c) => c.callerId))]
        .sort(byText)
        .map((caller) => ({
          id: caller,
          layer: options.layerOf(byId.get(caller)?.file ?? fileOfId(caller)),
        })),
    };
  }
  return {
    content: canonicalJson({
      functions,
      identity: {
        question: options.question ?? ownerQuestion(),
        floor: options.policy.floor,
        maxRounds: options.policy.maxRounds,
      },
    }),
    artifacts: [confirmed],
  };
}

type Facts = z.infer<typeof FunctionFacts>;

/** The deterministic part: the candidates the layer rule leaves, and what it settles alone. */
function narrow(
  group: RuleGroup,
  functions: Readonly<Record<string, Facts>>,
):
  | {
      readonly _tag: "settled";
      readonly candidates: readonly OwnerCandidate[];
      readonly owner: OwnerCandidate;
      readonly by: "layer" | "fan-in";
    }
  | {
      readonly _tag: "tied";
      readonly candidates: readonly OwnerCandidate[];
      readonly tied: readonly OwnerCandidate[];
    }
  | {
      readonly _tag: "unreachable";
      readonly candidates: readonly OwnerCandidate[];
    } {
  const seen = new Set<string>();
  const all: OwnerCandidate[] = [];
  for (const member of group.members) {
    if (seen.has(member.function)) continue;
    seen.add(member.function);
    const facts = functions[member.function];
    all.push({
      function: member.function,
      member: member.branch,
      span: member.span,
      layer: facts?.layer ?? null,
      fanIn: facts?.fanIn ?? 0,
    });
  }
  const layered = all.flatMap((c) =>
    c.layer === null ? [] : [{ ...c, layer: c.layer }],
  );
  if (layered.length < all.length)
    return { _tag: "tied", candidates: all, tied: all };
  // A caller → member edge is upward when the caller sits in a lower layer (a higher rank) than the
  // member. An unlayered caller's edge cannot be judged, so it constrains nothing.
  const callerRanks = all.flatMap((c) =>
    (functions[c.function]?.callers ?? []).flatMap((caller) =>
      caller.layer === null ? [] : [caller.layer.rank],
    ),
  );
  const reachFloor =
    callerRanks.length === 0
      ? Number.NEGATIVE_INFINITY
      : Math.max(...callerRanks);
  const reachable = layered.filter((c) => c.layer.rank >= reachFloor);
  // No member sits where every caller reaches it without an upward edge: nothing deterministic
  // can place the rule, and asking Jev to pick one would pick an upward edge.
  if (reachable.length === 0) return { _tag: "unreachable", candidates: all };
  const lowest = Math.max(...reachable.map((c) => c.layer.rank));
  const candidates = reachable.filter((c) => c.layer.rank === lowest);
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined)
    return { _tag: "settled", candidates, owner: only, by: "layer" };
  const top = Math.max(...candidates.map((c) => c.fanIn));
  const leaders = candidates.filter((c) => c.fanIn === top);
  const [leader] = leaders;
  if (leaders.length === 1 && leader !== undefined)
    return { _tag: "settled", candidates, owner: leader, by: "fan-in" };
  return { _tag: "tied", candidates, tied: leaders };
}

const ownerOf = (group: string, c: OwnerCandidate): Owner => ({
  group,
  member: c.member,
  function: c.function,
  span: c.span,
});

function ownerQuestionState(
  group: RuleGroup,
  tied: readonly OwnerCandidate[],
  functions: Readonly<Record<string, Facts>>,
): OwnerQuestionState {
  const { basis } = group;
  return {
    group: group.id,
    rule:
      basis._tag === "condition"
        ? basis.key
        : {
            atoms: [],
            outcome: `touches ${basis.binding.bindingKind} ${basis.binding.binding} (service ${basis.binding.ownerService})`,
          },
    candidates: tied.map((c, i) => {
      const member = group.members.find((m) => m.branch === c.member);
      return {
        ref: OWNER_REFS[i] as OwnerRef,
        function: c.function.slice(c.function.lastIndexOf(":") + 1),
        file: functions[c.function]?.file ?? fileOfId(c.function),
        layer: c.layer?.name ?? null,
        fanIn: c.fanIn,
        atoms: member?.atoms ?? [],
        outcome: member?.outcome ?? "",
      };
    }),
  };
}

/**
 * Stage 7: one owner per confirmed rule group. The lowest layer every member's callers reach
 * without an upward edge decides first, then fan-in; only a tie that survives both, or a group with
 * an unlayered member, is asked through `gateAll`. An abstained owner is `unknown`.
 */
export function ownerStage(options: OwnerOptions): Stage<OwnerRecord> {
  return {
    name: OWNER_STAGE,
    version: "1",
    run: async (input) => {
      const [confirmed, ...rest] = input.artifacts;
      if (
        confirmed === undefined ||
        rest.length > 0 ||
        confirmed.stage !== GROUP_CONFIRM_STAGE
      )
        throw new TypeError(
          `stage 7 reads exactly one "${GROUP_CONFIRM_STAGE}" artifact`,
        );
      const { functions } = OwnerContent.parse(JSON.parse(input.content));
      const groups = ruleGroups(
        (confirmed as StageArtifact<ClusterRecord>).facts,
      ).flatMap((f) =>
        f.value._tag === "known" ? [{ fact: f, group: f.value.value }] : [],
      );
      const narrowed = groups.map(({ fact, group }) => ({
        fact,
        group,
        narrowed: narrow(group, functions),
      }));
      const askable = narrowed.filter(
        (n) =>
          n.narrowed._tag === "tied" &&
          n.narrowed.tied.length <= OWNER_REFS.length,
      );
      const items: GateItem[] = askable.map(({ fact, group, narrowed: n }) => ({
        id: group.id,
        span: fact.span,
        state: ownerQuestionState(
          group,
          n._tag === "tied" ? n.tied : [],
          functions,
        ),
      }));
      const gated = await gateAll(OWNER_STAGE, items, options);
      const settledOf = new Map(
        askable.map(({ group }, i) => [
          group.id,
          { fact: gated.facts[i], settled: gated.settled[i] },
        ]),
      );
      return narrowed.map(({ fact, group, narrowed: n }): Fact<OwnerRecord> => {
        const base = {
          group: group.id,
          span: fact.span,
          candidates: [...n.candidates],
        };
        if (n._tag === "settled")
          return {
            id: group.id,
            span: n.owner.span,
            value: derived({
              ...base,
              settledBy: n.by,
              owner: derived(ownerOf(group.id, n.owner)),
              asked: null,
            }),
          };
        if (n._tag === "unreachable")
          return {
            id: group.id,
            span: fact.span,
            value: derived({
              ...base,
              settledBy: "layer",
              owner: unknownValue("undetermined"),
              asked: null,
            }),
          };
        const tied = n.tied.map((c) => c.function);
        const gatedOne = settledOf.get(group.id);
        if (gatedOne?.fact === undefined || gatedOne.settled === undefined)
          return {
            id: group.id,
            span: fact.span,
            value: derived({
              ...base,
              settledBy: "jev",
              owner: unknownValue("undetermined"),
              asked: { tied, answer: null, rounds: 0 },
            }),
          };
        const { fact: verdict, settled } = gatedOne;
        const rounds =
          settled._tag === "promoted" ? settled.round : settled.rounds;
        const picked =
          verdict.value._tag === "known"
            ? n.tied[OWNER_REFS.indexOf(verdict.value.value)]
            : undefined;
        const owner =
          verdict.value._tag === "unknown"
            ? verdict.value
            : picked === undefined
              ? unknownValue("undetermined")
              : {
                  ...verdict.value,
                  value: ownerOf(group.id, picked),
                };
        return {
          id: group.id,
          span: owner._tag === "known" ? owner.value.span : fact.span,
          value: derived({
            ...base,
            settledBy: "jev",
            owner,
            asked: { tied, answer: settled.judgement, rounds },
          }),
        };
      });
    },
  };
}

// ── reading the records ───────────────────────────────────────────────────

/**
 * One fact per rule group: its id, the owner member and the owner's span when the owner is
 * settled, and `unknown` when it is not.
 */
export function ownerFacts(
  records: readonly Fact<OwnerRecord>[],
): readonly Fact<Owner>[] {
  return records.flatMap((fact): Fact<Owner>[] => {
    if (fact.value._tag !== "known") return [];
    const record = fact.value.value;
    return [
      {
        id: record.group,
        span:
          record.owner._tag === "known" ? record.owner.value.span : record.span,
        value: record.owner,
      },
    ];
  });
}

export interface OwnerQueueEntry {
  readonly id: string;
  readonly span: SourceSpan;
  /** The tied candidates Jev was asked to choose between. */
  readonly tied: readonly string[];
  /** The last answer, below the floor or off the tie; `null` when the tie was too wide to ask. */
  readonly answer: OwnerJudgement | null;
  readonly rounds: number;
}

export interface OwnerQueue {
  readonly stage: typeof OWNER_STAGE;
  readonly entries: readonly OwnerQueueEntry[];
}

/** Every group whose owner is `unknown`: the one place a human touches stage 7. */
export function ownerQueue(records: readonly Fact<OwnerRecord>[]): OwnerQueue {
  const entries = records.flatMap((fact): OwnerQueueEntry[] => {
    if (fact.value._tag !== "known") return [];
    const record = fact.value.value;
    if (record.owner._tag === "known") return [];
    return [
      {
        id: record.group,
        span: record.span,
        tied: record.asked?.tied ?? record.candidates.map((c) => c.function),
        answer: record.asked?.answer ?? null,
        rounds: record.asked?.rounds ?? 0,
      },
    ];
  });
  return { stage: OWNER_STAGE, entries };
}
