import {
  type BoundaryLedgerEntry,
  BoundaryLedgerSchema,
  boundaryLedgerOf,
  ledgerKey,
} from "@demlik/code-graph/boundaries";
import { z } from "zod";
import {
  type ArtifactStore,
  canonicalJson,
  runStage,
  type StageRun,
} from "./artifact.js";
import { type Fact, SourceSpan } from "./fact.js";
import {
  type CandidateCluster,
  ClusterBasis,
  clusterId,
  clusterInput,
  clusterStage,
  type GroupingGraph,
  type RuleGroup,
} from "./group.js";
import {
  type Lexicon,
  type ResolvedBranch,
  resolveInput,
  resolveStage,
} from "./lexicon.js";
import {
  type GraphFunction,
  type LoweredBranch,
  loweringInput,
  lowerStage,
} from "./lower.js";
import type { Owner } from "./owner.js";

// ── the boundary interface ────────────────────────────────────────────────

/**
 * One boundary crossing as the re-measure reads it: `{scope, kind, from, to, specifier, reason?}`,
 * the entry shape of `@demlik/code-graph/boundaries`' per-edge ledger, which backs it.
 */
export type BoundaryCrossing = BoundaryLedgerEntry;

// ── the task spec ─────────────────────────────────────────────────────────

const SpecMember = z.strictObject({
  member: z.string().min(1),
  function: z.string().min(1),
  span: SourceSpan,
});

export type SpecMember = z.infer<typeof SpecMember>;

/**
 * One collapse, for an operator lane to carry out without reading the pipeline: the rule group,
 * the owner's span, every other member's span, and the expected delta. The collapse edits source
 * through these spans, never the lowered form.
 */
export const TaskSpec = z
  .strictObject({
    version: z.literal(1),
    group: z.string().min(1),
    /** The key the group clustered on. After the collapse, a cluster on it is how a member stays. */
    basis: ClusterBasis,
    owner: SpecMember,
    /** Every member branch but the owner's. */
    members: z.array(SpecMember).min(1),
    /**
     * The functions whose branches no longer form a separate cluster with the owner once the
     * collapse lands: every member function but the owner's own.
     */
    expectedDelta: z.strictObject({
      leaves: z.array(z.string().min(1)).min(1),
    }),
    /** The boundary crossings touching the spec's files before the collapse, as a ledger. */
    boundaries: BoundaryLedgerSchema,
  })
  .refine((spec) => spec.group === clusterId(spec.basis), {
    message: "a spec's group id is the hash of its basis",
    path: ["group"],
  });

export type TaskSpec = z.infer<typeof TaskSpec>;

/** The files a spec names: the owner's and every member's, sorted. */
export const specFiles = (spec: TaskSpec): readonly string[] =>
  [...new Set([spec.owner, ...spec.members].map((m) => m.span.file))].sort();

const touches = (files: ReadonlySet<string>) => (c: BoundaryCrossing) =>
  files.has(c.from) || (c.to !== null && files.has(c.to));

/**
 * One task spec per rule group whose owner is settled. A group whose owner is `unknown`, or that
 * has no stage-7 fact, produces none. `boundaries` is the crossings measured before the collapse;
 * each spec keeps the ones touching its own files.
 */
export function taskSpecs(
  groups: readonly Fact<RuleGroup>[],
  owners: readonly Fact<Owner>[],
  boundaries: readonly BoundaryCrossing[] = [],
): readonly TaskSpec[] {
  const ownerOf = new Map(owners.map((o) => [o.id, o.value]));
  return groups.flatMap((fact): TaskSpec[] => {
    const owner = ownerOf.get(fact.id);
    if (fact.value._tag !== "known" || owner?._tag !== "known") return [];
    const group = fact.value.value;
    const others = group.members.filter((m) => m.branch !== owner.value.member);
    const leaves = [
      ...new Set(
        others
          .map((m) => m.function)
          .filter((fn) => fn !== owner.value.function),
      ),
    ].sort();
    if (others.length === 0 || leaves.length === 0) return [];
    const draft = {
      version: 1 as const,
      group: group.id,
      basis: group.basis,
      owner: {
        member: owner.value.member,
        function: owner.value.function,
        span: owner.value.span,
      },
      members: others.map((m) => ({
        member: m.branch,
        function: m.function,
        span: m.span,
      })),
      expectedDelta: { leaves },
      boundaries: { entries: [] },
    };
    const files = new Set(specFiles(draft));
    return [
      TaskSpec.parse({
        ...draft,
        boundaries: boundaryLedgerOf(boundaries.filter(touches(files))),
      }),
    ];
  });
}

// ── the re-measure ────────────────────────────────────────────────────────

export interface RemeasureStores {
  readonly lower: ArtifactStore<LoweredBranch>;
  readonly resolve: ArtifactStore<ResolvedBranch>;
  readonly cluster: ArtifactStore<CandidateCluster>;
}

/** The post-change tree, as far as the re-measure reads it. */
export interface RemeasureInput {
  /** The post-change source of every file the spec names. */
  readonly sources: Readonly<Record<string, string>>;
  /** The post-change `--graph` JSON's function nodes. */
  readonly functions: readonly GraphFunction[];
  readonly lexicon: Lexicon;
  /** The post-change graph's data edges, or `null` without `--data`. */
  readonly data?: GroupingGraph["data"];
  /** The post-change boundary crossings. */
  readonly boundaries: readonly BoundaryCrossing[];
  readonly loggingRoots?: readonly string[];
  /** Where stage 2, 3 and 6 artifacts live: an unchanged file's are a `hit`. */
  readonly stores: RemeasureStores;
}

/** The closed verdict: the expected delta holds, or it does not and these members still cluster. */
export type RemeasureVerdict =
  | {
      readonly _tag: "collapsed";
      readonly group: string;
      readonly basis: ClusterBasis;
    }
  | {
      readonly _tag: "still-clustered";
      readonly group: string;
      /** The member branches still in a cluster on the spec's key, at their post-change spans. */
      readonly members: readonly SpecMember[];
    };

export interface Remeasure {
  readonly verdict: RemeasureVerdict;
  /** How each named file's stage-2 and stage-3 runs were answered, in file order. */
  readonly runs: readonly {
    readonly file: string;
    readonly lower: StageRun<LoweredBranch>["_tag"];
    readonly resolve: StageRun<ResolvedBranch>["_tag"];
  }[];
  readonly cluster: StageRun<CandidateCluster>["_tag"];
  /** Crossings touching the spec's files that the collapse added or removed. */
  readonly boundaries: {
    readonly added: readonly BoundaryCrossing[];
    readonly removed: readonly BoundaryCrossing[];
  };
}

/**
 * Re-run stages 2, 3 and 6 over the post-change sources of the files `spec` names and check its
 * expected delta: `collapsed` when no member function it expects to leave still has a branch in a
 * cluster on the spec's key, otherwise `still-clustered`, naming those branches. Artifacts are
 * hash-keyed, so an unchanged file is answered from `after.stores`.
 */
export async function remeasure(
  spec: TaskSpec,
  after: RemeasureInput,
): Promise<Remeasure> {
  const files = specFiles(spec);
  const runs: {
    file: string;
    lower: StageRun<LoweredBranch>["_tag"];
    resolve: StageRun<ResolvedBranch>["_tag"];
  }[] = [];
  const resolved = [];
  for (const file of files) {
    const source = after.sources[file];
    if (source === undefined)
      throw new RangeError(
        `remeasure: no post-change source for ${file}, which the spec for ${spec.group} names`,
      );
    const lowered = await runStage(
      after.stores.lower,
      lowerStage,
      loweringInput({
        file,
        source,
        functions: after.functions,
        ...(after.loggingRoots === undefined
          ? {}
          : { loggingRoots: after.loggingRoots }),
      }),
    );
    const resolvedRun = await runStage(
      after.stores.resolve,
      resolveStage,
      resolveInput(after.lexicon, lowered.artifact),
    );
    runs.push({ file, lower: lowered._tag, resolve: resolvedRun._tag });
    resolved.push(resolvedRun.artifact);
  }
  const clustered = await runStage(
    after.stores.cluster,
    clusterStage,
    clusterInput(resolved, after.data ?? null),
  );
  const leaving = new Set(spec.expectedDelta.leaves);
  const key = canonicalJson(spec.basis);
  const still = clustered.artifact.facts.flatMap((fact) =>
    fact.value._tag === "known" && canonicalJson(fact.value.value.basis) === key
      ? fact.value.value.members.filter((m) => leaving.has(m.function))
      : [],
  );
  const verdict: RemeasureVerdict =
    still.length === 0
      ? { _tag: "collapsed", group: spec.group, basis: spec.basis }
      : {
          _tag: "still-clustered",
          group: spec.group,
          members: still.map((m) => ({
            member: m.branch,
            function: m.function,
            span: m.span,
          })),
        };
  const touched = touches(new Set(files));
  const before = new Map(spec.boundaries.entries.map((e) => [ledgerKey(e), e]));
  const now = new Map(
    after.boundaries.filter(touched).map((e) => [ledgerKey(e), e]),
  );
  return {
    verdict,
    runs,
    cluster: clustered._tag,
    boundaries: {
      added: boundaryLedgerOf(
        [...now].flatMap(([k, e]) => (before.has(k) ? [] : [e])),
      ).entries,
      removed: boundaryLedgerOf(
        [...before].flatMap(([k, e]) => (now.has(k) ? [] : [e])),
      ).entries,
    },
  };
}

// ── the ratchet ───────────────────────────────────────────────────────────

export const RuleGroupLedgerEntry = z.strictObject({
  group: z.string().min(1),
  basis: ClusterBasis,
  /** Why a cluster on this key may come back. With none, one that does fails the measure. */
  reason: z.string().trim().min(1).optional(),
});

export type RuleGroupLedgerEntry = z.infer<typeof RuleGroupLedgerEntry>;

/** Every rule group a landed collapse removed, keyed by the basis it clustered on. */
export const RuleGroupLedger = z.strictObject({
  entries: z.array(RuleGroupLedgerEntry),
});

export type RuleGroupLedger = z.infer<typeof RuleGroupLedger>;

export const emptyRuleGroupLedger = (): RuleGroupLedger => ({ entries: [] });

/**
 * Record a collapsed group. Only a `collapsed` verdict can be recorded, and a group already in the
 * ledger keeps its entry, reason and all.
 */
export function recordCollapse(
  ledger: RuleGroupLedger,
  collapsed: Extract<RemeasureVerdict, { _tag: "collapsed" }>,
  reason?: string,
): RuleGroupLedger {
  if (ledger.entries.some((e) => e.group === collapsed.group)) return ledger;
  const entry = RuleGroupLedgerEntry.parse({
    group: collapsed.group,
    basis: collapsed.basis,
    ...(reason === undefined ? {} : { reason }),
  });
  return {
    entries: [...ledger.entries, entry].sort((a, b) =>
      a.group < b.group ? -1 : a.group > b.group ? 1 : 0,
    ),
  };
}

export type RatchetVerdict =
  | {
      readonly _tag: "pass";
      /** Clusters that match a recorded group whose entry carries a reason. */
      readonly allowed: readonly string[];
    }
  | {
      readonly _tag: "fail";
      readonly violations: readonly {
        readonly cluster: string;
        readonly entry: RuleGroupLedgerEntry;
      }[];
    };

/** A later measure fails when a cluster matches a recorded group's key, unless that entry has a reason. */
export function checkRatchet(
  ledger: RuleGroupLedger,
  clusters: readonly CandidateCluster[],
): RatchetVerdict {
  const recorded = new Map(
    ledger.entries.map((e) => [canonicalJson(e.basis), e]),
  );
  const allowed: string[] = [];
  const violations: { cluster: string; entry: RuleGroupLedgerEntry }[] = [];
  for (const cluster of clusters) {
    const entry = recorded.get(canonicalJson(cluster.basis));
    if (entry === undefined) continue;
    if (entry.reason === undefined)
      violations.push({ cluster: cluster.id, entry });
    else allowed.push(cluster.id);
  }
  return violations.length === 0
    ? { _tag: "pass", allowed }
    : { _tag: "fail", violations };
}
