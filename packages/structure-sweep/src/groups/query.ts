import type { SourceSpan } from "../lowering/fact.js";
import {
  type ClusterBasis,
  type ClusterDifference,
  type ClusterMember,
  type ClusterRecord,
  type ClusterStatus,
  clusterQuestionState,
  clusterStatus,
  GROUP_CONFIRM_STAGE,
  type GroupingGraph,
  type GroupJudgement,
  groupQueue,
} from "../lowering/group.js";
import type { TaskSpec } from "../lowering/handoff.js";
import {
  OWNER_STAGE,
  type Owner,
  type OwnerCandidate,
  type OwnerJudgement,
  type OwnerRecord,
  ownerQueue,
} from "../lowering/owner.js";
import type { GroupsFile } from "./file.js";

/** An owner as the query surface prints it: settled, `unknown`, or `null` before stage 7 ran. */
export type OwnerView = Owner | "unknown";

export interface GroupListRow {
  readonly id: string;
  readonly state: ClusterStatus;
  readonly signal: ClusterBasis["_tag"];
  readonly members: number;
  /** Only a confirmed group has an owner; `null` for a cluster that is not one, or before stage 7. */
  readonly owner: OwnerView | null;
  readonly spec: boolean;
}

export interface GroupList {
  readonly groups: readonly GroupListRow[];
}

/** A human-queue entry stage 6 or stage 7 wrote for one group. */
export type QuestionView =
  | {
      readonly stage: typeof GROUP_CONFIRM_STAGE;
      readonly status: Exclude<ClusterStatus, "confirmed">;
      readonly span: SourceSpan;
      readonly answer: GroupJudgement;
      readonly rounds: number;
    }
  | {
      readonly stage: typeof OWNER_STAGE;
      readonly span: SourceSpan;
      readonly tied: readonly string[];
      readonly answer: OwnerJudgement | null;
      readonly rounds: number;
    };

export interface GroupView {
  readonly id: string;
  readonly state: ClusterStatus;
  readonly basis: ClusterBasis;
  readonly members: readonly (ClusterMember & {
    /** The member function's callers, from the `--graph` JSON's `edges.calledBy`, sorted. */
    readonly callers: readonly string[];
  })[];
  /** Stage 7's reading: every candidate it narrowed to, and the owner or `unknown`. */
  readonly owner: {
    readonly candidates: readonly OwnerCandidate[];
    readonly settledBy: OwnerRecord["settledBy"];
    readonly owner: OwnerView;
  } | null;
  /** Stage 6's confirm evidence: the differences Jev was shown and the answer the gate settled on. */
  readonly evidence: {
    readonly differences: readonly ClusterDifference[];
    readonly answer: GroupJudgement;
    readonly rounds: number;
  };
  /** The human-queue entries stage 6 or stage 7 wrote for this group. */
  readonly questions: readonly QuestionView[];
  readonly spec: TaskSpec | null;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const recordsOf = (file: GroupsFile): readonly ClusterRecord[] =>
  file.confirmed.facts
    .flatMap((f) => (f.value._tag === "known" ? [f.value.value] : []))
    .sort((a, b) => byText(a.cluster.id, b.cluster.id));

const ownersOf = (file: GroupsFile): ReadonlyMap<string, OwnerRecord> =>
  new Map(
    (file.owners?.facts ?? []).flatMap((f) =>
      f.value._tag === "known" ? [[f.value.value.group, f.value.value]] : [],
    ),
  );

const ownerView = (record: OwnerRecord): OwnerView =>
  record.owner._tag === "known" ? record.owner.value : "unknown";

/** Every rule group and every cluster that did not become one, with its id and state. */
export function listGroups(file: GroupsFile): GroupList {
  const owners = ownersOf(file);
  const specs = new Set(file.specs.map((s) => s.group));
  return {
    groups: recordsOf(file).map((record) => {
      const state = clusterStatus(record);
      const owner = owners.get(record.cluster.id);
      return {
        id: record.cluster.id,
        state,
        signal: record.cluster.basis._tag,
        members: record.cluster.members.length,
        owner:
          state === "confirmed" && owner !== undefined
            ? ownerView(owner)
            : null,
        spec: specs.has(record.cluster.id),
      };
    }),
  };
}

export class UnknownGroupError extends Error {}

/**
 * One group's evidence: its member branches with spans and callers, stage 7's candidates and owner,
 * stage 6's confirm evidence, and the human-queue entries either stage wrote for it. It reads the
 * artifacts only, so it asks nothing.
 */
export function showGroup(
  file: GroupsFile,
  id: string,
  graph: GroupingGraph,
): GroupView {
  const record = recordsOf(file).find((r) => r.cluster.id === id);
  if (record === undefined)
    throw new UnknownGroupError(
      `no group or cluster ${id}; \`structure-sweep groups list\` names every one`,
    );
  const calledBy = new Map(
    graph.functions.map((fn) => [
      fn.id,
      [...new Set((fn.edges?.calledBy ?? []).map((c) => c.callerId))].sort(
        byText,
      ),
    ]),
  );
  const owner = ownersOf(file).get(id);
  const confirmFacts = file.confirmed.facts.filter((f) => f.id === id);
  const ownerFacts = (file.owners?.facts ?? []).filter((f) => f.id === id);
  const questions: QuestionView[] = [
    ...groupQueue(confirmFacts).entries.map(
      (e): QuestionView => ({
        stage: GROUP_CONFIRM_STAGE,
        status: e.status,
        span: e.span,
        answer: e.answer,
        rounds: e.rounds,
      }),
    ),
    ...ownerQueue(ownerFacts).entries.map(
      (e): QuestionView => ({
        stage: OWNER_STAGE,
        span: e.span,
        tied: e.tied,
        answer: e.answer,
        rounds: e.rounds,
      }),
    ),
  ];
  return {
    id,
    state: clusterStatus(record),
    basis: record.cluster.basis,
    members: record.cluster.members.map((m) => ({
      ...m,
      callers: calledBy.get(m.function) ?? [],
    })),
    owner:
      owner === undefined
        ? null
        : {
            candidates: owner.candidates,
            settledBy: owner.settledBy,
            owner: ownerView(owner),
          },
    evidence: {
      differences: clusterQuestionState(record.cluster).differences,
      answer: record.answer,
      rounds: record.rounds,
    },
    questions,
    spec: file.specs.find((s) => s.group === id) ?? null,
  };
}
