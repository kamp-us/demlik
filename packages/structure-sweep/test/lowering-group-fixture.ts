import { join } from "node:path";
import type { JevChoiceAnswer, JevState } from "@demlik/tea/jev";
import {
  type ArtifactStore,
  memoryArtifactStore,
  runStage,
  type StageArtifact,
} from "../src/lowering/artifact.js";
import type { ChoiceQuestions } from "../src/lowering/ask.js";
import { gatePolicy } from "../src/lowering/gate.js";
import {
  type CandidateCluster,
  type ClusterQuestionState,
  clusterInput,
  clusterStage,
  GROUP_VERDICTS,
  type GroupingGraph,
  type GroupVerdict,
  groupConfirmQuestion,
} from "../src/lowering/group.js";
import { evaluate, loadGoldSet } from "../src/lowering/harness.js";
import {
  type Lexicon,
  parseLexicon,
  type ResolvedBranch,
  resolveInput,
  resolveStage,
} from "../src/lowering/lexicon.js";
import {
  type GraphFunction,
  type LoweredBranch,
  loweringInput,
  lowerStage,
} from "../src/lowering/lower.js";
import { stubJev } from "./helpers.js";
import { graphOf } from "./lowering-lower-fixture.js";

// Every gold item and state here is synthetic, written for these tests.

export const groupGoldFile = join(
  import.meta.dirname,
  "fixtures/lowering/group-confirm.gold.json",
);

export const groupGold = loadGoldSet(groupGoldFile, GROUP_VERDICTS);

export function groupAnswer(
  label: GroupVerdict,
  confidence: number,
): JevChoiceAnswer<GroupVerdict> {
  const rest = (1 - confidence) / (GROUP_VERDICTS.length - 1);
  return {
    type: "choice",
    choice: label,
    confidence,
    probabilities: Object.fromEntries(
      GROUP_VERDICTS.map((v) => [v, v === label ? confidence : rest]),
    ) as Record<GroupVerdict, number>,
  };
}

/** A stub Jev over the stage-6 question: `answer` sees the cluster state and says what Jev says. */
export const stubGroupJev = (
  answer: (state: ClusterQuestionState) => JevChoiceAnswer<GroupVerdict>,
) =>
  stubJev<ChoiceQuestions<GroupVerdict>>((state: JevState) => ({
    verdict: answer(state as ClusterQuestionState),
  }));

const goldOf = new Map(
  groupGold.items.map((item) => [
    (item.state as ClusterQuestionState).cluster,
    item.gold,
  ]),
);

/** Knows every gold cluster's verdict at 0.95. */
export const goldGroupJev = () =>
  stubGroupJev((state) =>
    groupAnswer(goldOf.get(state.cluster) ?? "unrelated", 0.95),
  );

export const groupThresholds = { ece: 0.2, flipRate: 0.1 };

// ── running stages 2, 3 and 6 over synthetic files ───────────────────────

export interface Stores {
  readonly lower: ArtifactStore<LoweredBranch>;
  readonly resolve: ArtifactStore<ResolvedBranch>;
  readonly cluster: ArtifactStore<CandidateCluster>;
}

export const stores = (): Stores => ({
  lower: memoryArtifactStore<LoweredBranch>(),
  resolve: memoryArtifactStore<ResolvedBranch>(),
  cluster: memoryArtifactStore<CandidateCluster>(),
});

export const emptyLexicon = parseLexicon({ entries: {} });

/** Every file's graph nodes, as code-graph would report them for top-level `export function`s. */
export const functionsOf = (
  files: Readonly<Record<string, string>>,
): GraphFunction[] =>
  Object.entries(files).flatMap(([file, source]) => graphOf(file, source));

/** Lower and resolve every file; each file's two runs, in file order. */
export async function resolveFiles(
  files: Readonly<Record<string, string>>,
  options: {
    readonly lexicon?: Lexicon;
    readonly functions?: readonly GraphFunction[];
    readonly stores?: Stores;
  } = {},
) {
  const s = options.stores ?? stores();
  const functions = options.functions ?? functionsOf(files);
  const runs = [];
  for (const [file, source] of Object.entries(files)) {
    const lowered = await runStage(
      s.lower,
      lowerStage,
      loweringInput({ file, source, functions }),
    );
    const resolved = await runStage(
      s.resolve,
      resolveStage,
      resolveInput(options.lexicon ?? emptyLexicon, lowered.artifact),
    );
    runs.push({ file, lowered, resolved });
  }
  return runs;
}

/** Stage 6's deterministic half over `files`: the candidate-cluster artifact. */
export async function clustersOf(
  files: Readonly<Record<string, string>>,
  data: GroupingGraph["data"] = null,
  options: { readonly lexicon?: Lexicon; readonly stores?: Stores } = {},
): Promise<StageArtifact<CandidateCluster>> {
  const s = options.stores ?? stores();
  const runs = await resolveFiles(files, { ...options, stores: s });
  const run = await runStage(
    s.cluster,
    clusterStage,
    clusterInput(
      runs.map((r) => r.resolved.artifact),
      data,
    ),
  );
  return run.artifact;
}

export const clusters = (artifact: StageArtifact<CandidateCluster>) =>
  artifact.facts.flatMap((f) =>
    f.value._tag === "known" ? [f.value.value] : [],
  );

/** Each cluster as the sorted branch ids it holds. */
export const memberSets = (artifact: StageArtifact<CandidateCluster>) =>
  clusters(artifact).map((c) => c.members.map((m) => m.branch));

/** Stage 6's policy, built from `calibrate` over the stage-6 gold set (through `evaluate`). */
export async function stage6Policy() {
  const evaluation = await evaluate({
    question: groupConfirmQuestion(),
    gold: groupGold,
    connect: () => goldGroupJev(),
    thresholds: groupThresholds,
    target: 0.9,
  });
  if (evaluation.calibration._tag !== "derived")
    throw new Error("expected a derived stage-6 floor");
  return gatePolicy({ calibration: evaluation.calibration, maxRounds: 1 });
}

// ── synthetic sources ─────────────────────────────────────────────────────

/**
 * Acceptance shape A: two guards over the same conditions. One throws on the denied case, the other
 * returns `false`; on the allowed case one returns a value its caller supplies, the other `true`.
 */
export const SHAPE_A = {
  "src/archive/guard.ts": [
    "export function guardArchive(actor, doc, allowed) {",
    "  if (!actor) throw new NotSignedIn();",
    "  if (!actor.canArchive) throw new Forbidden();",
    "  if (doc.locked) throw new Forbidden();",
    "  return allowed;",
    "}",
  ].join("\n"),
  "src/archive/check.ts": [
    "export function archiveIsAllowed(user, item) {",
    "  if (!user) return false;",
    "  if (!user.canArchive) return false;",
    "  if (item.locked) return false;",
    "  return true;",
    "}",
  ].join("\n"),
};

/**
 * Acceptance shape B: two functions that pick the enabled flags from a set, identical apart from
 * their names and the value a parameter default supplies.
 */
export const SHAPE_B = {
  "src/flags/enabled.ts": [
    "export function enabledFlagsOf(active, known = CATALOG_FLAGS) {",
    "  return known.filter((flag) => active.has(flag));",
    "}",
  ].join("\n"),
  "src/flags/switches.ts": [
    "export function switchesOn(on, all = SWITCH_NAMES) {",
    "  return all.filter((name) => on.has(name));",
    "}",
  ].join("\n"),
};

/** Two persistence functions over one binding, whose branches carry different atoms. */
export const LEDGER = {
  "src/ledger/invoices.ts": [
    "export async function loadInvoice(env, id) {",
    '  const row = await env.LEDGER.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first();',
    "  if (row === null) throw new NotFound();",
    "  return row;",
    "}",
    "export async function voidInvoice(env, id, actor) {",
    "  if (!actor.isBilling) return false;",
    '  await env.LEDGER.prepare("UPDATE invoices SET void = 1 WHERE id = ?").bind(id).run();',
    "  return true;",
    "}",
  ].join("\n"),
};

export const dataGraphFile = join(
  import.meta.dirname,
  "fixtures/lowering/group-data.graph.json",
);
