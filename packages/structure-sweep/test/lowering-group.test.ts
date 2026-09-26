import type { JevState } from "@demlik/tea/jev";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  memoryArtifactStore,
  runStage,
  type StageArtifact,
} from "../src/lowering/artifact.js";
import { calibrate } from "../src/lowering/calibration.js";
import type { GateItem } from "../src/lowering/gate.js";
import {
  askGroupVerdict,
  type CandidateCluster,
  type ClusterQuestionState,
  type ClusterRecord,
  clusterId,
  clusterStatus,
  conditionKey,
  confirmInput,
  confirmStage,
  DENY,
  GROUP_VERDICT_CRITERIA,
  GROUP_VERDICTS,
  GROUPING_RULES,
  GroupingGraph,
  groupConfirmQuestion,
  groupQueue,
  readGroupingGraph,
  ruleGroups,
} from "../src/lowering/group.js";
import { evaluate } from "../src/lowering/harness.js";
import { readLoweringGraph } from "../src/lowering/lower.js";
import {
  clusters,
  clustersOf,
  dataGraphFile,
  goldGroupJev,
  groupAnswer,
  groupGold,
  groupThresholds,
  LEDGER,
  memberSets,
  resolveFiles,
  SHAPE_A,
  SHAPE_B,
  stage6Policy,
  stubGroupJev,
} from "./lowering-group-fixture.js";

// Every source, state and gold item below is synthetic, written for these tests.

const stateOf = (id: string) =>
  groupGold.items.find((i) => i.id === id)?.state as ClusterQuestionState;

describe("the stage-6 gold set", () => {
  it("loads through loadGoldSet: at least 20 candidate groups and a rewording", () => {
    expect(groupGold.stage).toBe("group-confirm");
    expect(groupGold.items.length).toBeGreaterThanOrEqual(20);
    expect(groupGold.rewordings.length).toBeGreaterThanOrEqual(1);
    expect(new Set(groupGold.items.map((i) => i.gold))).toEqual(
      new Set(GROUP_VERDICTS),
    );
  });

  it("holds same-rule positives written on different surfaces", () => {
    const positives = groupGold.items.filter((i) => i.gold === "same-rule");
    const onDifferentSurfaces = positives.filter(
      (i) => (i.state as ClusterQuestionState).differences.length > 0,
    );
    expect(onDifferentSurfaces.length).toBeGreaterThanOrEqual(5);
    expect(stateOf("admin-edit-throw-vs-false").differences).toEqual([
      { ref: "m0", atoms: [], outcome: "throw new Forbidden()" },
      { ref: "m1", atoms: [], outcome: "return false" },
    ]);
  });

  it("holds related-but-different negatives, including one condition guarding two rules", () => {
    const negatives = groupGold.items.filter(
      (i) => i.gold === "related-different",
    );
    expect(negatives.length).toBeGreaterThanOrEqual(5);
    const coincide = stateOf("owner-delete-vs-owner-billing");
    expect(coincide.shared).toEqual({
      signal: "condition",
      atoms: ['¬(v0.role === "owner")'],
      outcome: "deny",
    });
    expect(
      negatives.some(
        (i) => (i.state as ClusterQuestionState).shared.signal === "data",
      ),
    ).toBe(true);
  });

  it("scores through evaluate with a stubbed Jev", async () => {
    const jev = goldGroupJev();
    const evaluation = await evaluate({
      question: groupConfirmQuestion(),
      gold: groupGold,
      connect: () => jev,
      thresholds: groupThresholds,
      target: 0.9,
    });
    expect(evaluation.accuracy).toBe(1);
    expect(evaluation.flipRate).toBe(0);
    expect(evaluation.verdict).toEqual({ _tag: "shippable" });
    expect(jev.asked).toHaveLength(groupGold.items.length * 2);
  });
});

describe("the stage-6 question", () => {
  it("is a ChoiceQuestion over exactly the three verdicts, each anchored", () => {
    const question = groupConfirmQuestion();
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual([...GROUP_VERDICTS]);
    for (const verdict of GROUP_VERDICTS)
      expect(
        GROUP_VERDICT_CRITERIA[verdict].examples.length,
      ).toBeGreaterThanOrEqual(1);
  });

  it("keeps Jev's whole distribution beside the verdict", async () => {
    const jev = stubGroupJev(() => groupAnswer("same-rule", 0.8));
    const answer = await askGroupVerdict(jev)(
      stateOf("admin-edit-throw-vs-false"),
    );
    expect(answer.label).toBe("same-rule");
    expect(answer.confidence).toBe(0.8);
    expect(answer.probabilities["related-different"]).toBeCloseTo(0.1);
  });

  it("derives its gate policy from calibrate over the gold set", async () => {
    const policy = await stage6Policy();
    const reference = calibrate(
      groupGold.items.flatMap(() => [
        { confidence: 0.95, correct: true },
        { confidence: 0.95, correct: true },
      ]),
      { target: 0.9 },
    );
    expect(reference._tag).toBe("derived");
    if (reference._tag === "derived")
      expect(policy.floor).toBe(reference.floor);
  });
});

// ── stage 6, the deterministic half ───────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
});

const PUBLISH = {
  "src/posts/publish.ts": [
    "export function mayPublish(user, post) {",
    "  if (user.verified && post.ready) return true;",
    "  return false;",
    "}",
    "export function publishNotice(member, item) {",
    '  if (member.verified && item.ready) return "ok";',
    "  return false;",
    "}",
  ].join("\n"),
  "src/posts/allowed.ts": [
    "export function publishAllowed(author, entry) {",
    "  if (entry.ready && author.verified) return true;",
    "  return false;",
    "}",
  ].join("\n"),
};

const clusterHolding = (
  artifact: StageArtifact<CandidateCluster>,
  branch: string,
) => memberSets(artifact).filter((set) => set.includes(branch));

describe("stage 6: the canonical key", () => {
  it("clusters one condition and outcome across atom order and local and parameter names", async () => {
    const artifact = await clustersOf(PUBLISH);
    expect(
      clusterHolding(artifact, "src/posts/publish.ts:mayPublish@0"),
    ).toEqual([
      [
        "src/posts/allowed.ts:publishAllowed@0",
        "src/posts/publish.ts:mayPublish@0",
      ],
    ]);
  });

  it("keeps a branch that differs only in outcome out of that cluster", async () => {
    const artifact = await clustersOf(PUBLISH);
    expect(
      clusterHolding(artifact, "src/posts/publish.ts:publishNotice@0"),
    ).toEqual([]);
  });

  it("needs branches from at least two functions", async () => {
    const artifact = await clustersOf({
      "src/one.ts": [
        "export function twice(x) {",
        "  if (x.a) { if (x.b) return 1; }",
        "  if (x.b) { if (x.a) return 1; }",
        "  return 0;",
        "}",
      ].join("\n"),
    });
    expect(clusters(artifact)).toEqual([]);
  });

  it("makes no Jev call, and names each cluster by a hash of its basis", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const artifact = await clustersOf(PUBLISH);
    expect(fetch).not.toHaveBeenCalled();
    for (const cluster of clusters(artifact))
      expect(cluster.id).toBe(clusterId(cluster.basis));
    expect(clusters(await clustersOf(PUBLISH)).map((c) => c.id)).toEqual(
      clusters(artifact).map((c) => c.id),
    );
  });

  it("reads a lexicon-resolved identifier as its concept", async () => {
    const [run] = await resolveFiles(
      {
        "src/caps.ts": [
          "export function capsOn(org) {",
          '  if (features.isOn("caps")) return true;',
          "  return false;",
          "}",
        ].join("\n"),
      },
      {
        lexicon: (await import("../src/lowering/lexicon.js")).parseLexicon({
          entries: { "features.isOn": { kind: "flag", concept: "caps" } },
        }),
      },
    );
    const fact = run?.resolved.artifact.facts[0];
    if (fact?.value._tag !== "known") throw new Error("expected a branch");
    expect(conditionKey(fact.value.value)).toEqual({
      atoms: ['⟨flag caps⟩("caps")'],
      outcome: "return true",
    });
  });
});

describe("the deny-outcome rule (held-out cases)", () => {
  const WALLET = {
    "src/wallet/spend.ts": [
      "export function canSpend(wallet, amount) {",
      "  if (wallet.balance < amount) return false;",
      "  return true;",
      "}",
      "export function spend(purse, sum) {",
      "  if (purse.balance < sum) throw new InsufficientFunds(sum);",
      "  return purse.debit(sum);",
      "}",
      "export function spendOrNull(wallet, amount) {",
      "  if (wallet.balance < amount) return null;",
      "  return wallet.debit(amount);",
      "}",
      "export function spendOrNothing(wallet, amount) {",
      "  if (wallet.balance < amount) return;",
      "  return wallet.debit(amount);",
      "}",
    ].join("\n"),
  };

  it("is the one named grouping rule", () => {
    expect(GROUPING_RULES).toEqual(["deny-outcome"]);
  });

  it("keys a throw and a return false as one deny outcome", async () => {
    const artifact = await clustersOf(WALLET);
    const deny = clusters(artifact).find(
      (c) => c.basis._tag === "condition" && c.basis.key.outcome === DENY,
    );
    expect(deny?.members.map((m) => m.branch)).toEqual([
      "src/wallet/spend.ts:canSpend@0",
      "src/wallet/spend.ts:spend@0",
    ]);
    expect(deny?.members.map((m) => m.outcome)).toEqual([
      "return false",
      "throw new InsufficientFunds(v1)",
    ]);
  });

  it("does not read return null or a bare return as deny", async () => {
    const artifact = await clustersOf(WALLET);
    expect(
      clusterHolding(artifact, "src/wallet/spend.ts:spendOrNull@0"),
    ).toEqual([]);
    expect(
      clusterHolding(artifact, "src/wallet/spend.ts:spendOrNothing@0"),
    ).toEqual([]);
  });
});

describe("the acceptance shapes", () => {
  it("shape B: both flag pickers land in one candidate cluster", async () => {
    const artifact = await clustersOf(SHAPE_B);
    expect(memberSets(artifact)).toEqual([
      [
        "src/flags/enabled.ts:enabledFlagsOf@0",
        "src/flags/switches.ts:switchesOn@0",
      ],
    ]);
  });

  it("shape A: the three denied-case pairs co-cluster; the allowed case does not", async () => {
    const artifact = await clustersOf(SHAPE_A);
    expect(memberSets(artifact).sort()).toEqual(
      [
        [
          "src/archive/check.ts:archiveIsAllowed@0",
          "src/archive/guard.ts:guardArchive@0",
        ],
        [
          "src/archive/check.ts:archiveIsAllowed@1",
          "src/archive/guard.ts:guardArchive@1",
        ],
        [
          "src/archive/check.ts:archiveIsAllowed@2",
          "src/archive/guard.ts:guardArchive@2",
        ],
      ].sort(),
    );
    // The fourth pair differs for a real reason: one side returns the value its caller supplied.
    expect(
      clusterHolding(artifact, "src/archive/guard.ts:guardArchive@3"),
    ).toEqual([]);
  });
});

describe("stage 6: shared data edges (#461)", () => {
  const graph = readGroupingGraph(dataGraphFile);
  const functions = readLoweringGraph(dataGraphFile).functions;

  it("reads Graph.data's attributed edges and never the unattributed sites", () => {
    expect(graph.data?.edges.map((e) => e.functionId)).toEqual([
      "src/ledger/invoices.ts:loadInvoice",
      "src/ledger/invoices.ts:voidInvoice",
    ]);
    expect(Object.keys(graph.data ?? {})).toEqual(["edges"]);
  });

  it("puts two persistence functions over one binding in one candidate group, atoms and all", async () => {
    const [run] = await resolveFiles(LEDGER, { functions });
    const resolved = run?.resolved.artifact;
    if (resolved === undefined) throw new Error("expected a resolved file");
    const artifact = await clustersOf(LEDGER, graph.data);
    const data = clusters(artifact).filter((c) => c.basis._tag === "data");
    expect(data).toHaveLength(1);
    const [group] = data;
    expect(group?.basis).toEqual({
      _tag: "data",
      binding: {
        ownerService: "billing",
        bindingKind: "d1",
        binding: "LEDGER",
      },
    });
    expect(new Set(group?.members.map((m) => m.function))).toEqual(
      new Set([
        "src/ledger/invoices.ts:loadInvoice",
        "src/ledger/invoices.ts:voidInvoice",
      ]),
    );
    const atoms = group?.members.map((m) => m.atoms.join(" ∧ "));
    expect(new Set(atoms).size).toBeGreaterThan(1);
  });

  it("leaves condition-key clustering unchanged without data, null or absent", async () => {
    const files = { ...SHAPE_A, ...LEDGER };
    const withData = await clustersOf(files, graph.data);
    const nullData = await clustersOf(files, null);
    const absent = await clustersOf(
      files,
      GroupingGraph.parse({ functions: [] }).data,
    );
    expect(absent.facts).toEqual(nullData.facts);
    expect(nullData.facts).toEqual(
      withData.facts.filter(
        (f) =>
          f.value._tag === "known" && f.value.value.basis._tag === "condition",
      ),
    );
    expect(nullData.facts.length).toBeLessThan(withData.facts.length);
  });
});

// ── stage 6, the Jev half ────────────────────────────────────────────────

/** Shape A plus a third guard over the same conditions: three-member clusters. */
const THREE_GUARDS = {
  ...SHAPE_A,
  "src/archive/policy.ts": [
    "export function mayArchive(member, entry) {",
    "  if (!member) throw new HttpError(401);",
    "  if (!member.canArchive) throw new HttpError(403);",
    "  if (entry.locked) return false;",
    "  return true;",
    "}",
  ].join("\n"),
};

describe("stage 6: the confirm", () => {
  /** Promotes the capability and lock rules, rejects the allowed case, and is unsure of sign-in. */
  const jev = () =>
    stubGroupJev((state) => {
      if (state.shared.signal !== "condition")
        return groupAnswer("unrelated", 0.95);
      const [atom] = state.shared.atoms;
      if (atom === "¬(v0)") return groupAnswer("same-rule", 0.2);
      if (state.shared.outcome !== DENY)
        return groupAnswer("related-different", 0.95);
      return groupAnswer("same-rule", 0.95);
    });

  async function confirm(client = jev()) {
    const policy = await stage6Policy();
    const candidates = await clustersOf(THREE_GUARDS);
    const options = {
      policy,
      ask: askGroupVerdict(client),
      enrich: async (_item: GateItem, state: JevState) => state,
    };
    const store = memoryArtifactStore<ClusterRecord>();
    const run = await runStage(
      store,
      confirmStage(options),
      confirmInput(candidates, options),
    );
    return { client, run, store, options, candidates };
  }

  it("asks per candidate cluster through gateAll and makes only confirmed clusters rule groups", async () => {
    const { client, run } = await confirm();
    const statuses = run.artifact.facts.map((f) =>
      f.value._tag === "known" ? clusterStatus(f.value.value) : "none",
    );
    expect([...statuses].sort()).toEqual(
      ["abstained", "confirmed", "confirmed", "rejected"].sort(),
    );
    // Four clusters, and the one below the floor asked again once before it abstained.
    expect(client.asked).toHaveLength(5);
    const groups = ruleGroups(run.artifact.facts);
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.value._tag).toBe("known");
      if (group.value._tag !== "known") continue;
      expect(group.value.basis._tag).toBe("promoted");
      expect(Object.keys(group.value.value).sort()).toEqual(
        ["basis", "id", "members"].sort(),
      );
      expect(group.value.value.members).toHaveLength(3);
      for (const member of group.value.value.members)
        expect(member.span.file).toMatch(/^src\/archive\//);
      expect(group.id).toBe(group.value.value.id);
    }
  });

  it("sends a rejected and an abstained cluster to the human queue, and makes no group of either", async () => {
    const { run } = await confirm();
    const queue = groupQueue(run.artifact.facts);
    expect(queue.entries.map((e) => e.status).sort()).toEqual([
      "abstained",
      "rejected",
    ]);
    const abstained = run.artifact.facts.find(
      (f) =>
        f.value._tag === "known" &&
        clusterStatus(f.value.value) === "abstained",
    );
    expect(
      abstained?.value._tag === "known" && abstained.value.value.verdict,
    ).toEqual({ _tag: "unknown", reason: "abstained" });
    const groupIds = new Set(ruleGroups(run.artifact.facts).map((g) => g.id));
    for (const entry of queue.entries)
      expect(groupIds.has(entry.id)).toBe(false);
  });

  it("shows Jev the members' lowered branches and their differences, never the raw source", async () => {
    const { client } = await confirm();
    for (const state of client.asked) {
      const text = JSON.stringify(state);
      expect(text).not.toMatch(/export function|actor\.canArchive|member\b\)/);
    }
    const lock = (client.asked as ClusterQuestionState[]).find(
      (s) =>
        s.shared.signal === "condition" && s.shared.atoms.includes("v1.locked"),
    );
    expect(lock?.differences.map((d) => d.outcome)).toEqual([
      "return false",
      "throw new Forbidden()",
      "return false",
    ]);
  });

  it("answers a repeat run off the store with no Jev call", async () => {
    const { client, store, options, candidates } = await confirm();
    const asked = client.asked.length;
    const again = await runStage(
      store,
      confirmStage(options),
      confirmInput(candidates, options),
    );
    expect(again._tag).toBe("hit");
    expect(client.asked).toHaveLength(asked);
  });
});
