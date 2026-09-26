import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import {
  type ArtifactStore,
  memoryArtifactStore,
  runStage,
} from "../src/lowering/artifact.js";
import {
  type BranchVector,
  cosineSimilarity,
  DEFAULT_SIMILARITY_THRESHOLD,
  type EmbeddingPort,
  embeddingInput,
  embeddingStage,
  nearestNeighbourPairs,
} from "../src/lowering/embed.js";
import type { Fact } from "../src/lowering/fact.js";
import type { GateItem } from "../src/lowering/gate.js";
import {
  askGroupVerdict,
  type CandidateCluster,
  type ClusterQuestionState,
  clusterInput,
  clusterStage,
  confirmInput,
  confirmStage,
  type RuleGroup,
  readGroupingGraph,
} from "../src/lowering/group.js";
import { remeasure, taskSpecs } from "../src/lowering/handoff.js";
import type { Owner } from "../src/lowering/owner.js";
import {
  clusters,
  clustersOf,
  dataGraphFile,
  emptyLexicon,
  functionsOf,
  goldGroupJev,
  groupAnswer,
  LEDGER,
  resolveFiles,
  SHAPE_A,
  SHAPE_B,
  type Stores,
  stage6Policy,
  stores,
  stubGroupJev,
} from "./lowering-group-fixture.js";

// Every source, vector and answer below is synthetic, written for these tests.

/**
 * One rule — a person must be at least 18 — written twice under different names and a different
 * structure: one returns the comparison, the other throws below the line and returns the person.
 * Their condition keys differ, so the condition signal never puts them together.
 */
const ADULT = {
  "src/checkout/alcohol.ts": [
    "export function canBuyAlcohol(customer) {",
    "  return customer.age >= 18;",
    "}",
  ].join("\n"),
  "src/signup/adult.ts": [
    "export function assertAdult(person) {",
    "  if (person.age < 18) throw new Underage();",
    "  return person;",
    "}",
  ].join("\n"),
  "src/posts/title.ts": [
    "export function hasTitle(post) {",
    "  if (!post.title) return false;",
    "  return true;",
    "}",
  ].join("\n"),
};

const ALCOHOL = "src/checkout/alcohol.ts:canBuyAlcohol";
const ADULT_FN = "src/signup/adult.ts:assertAdult";
const TITLE = "src/posts/title.ts:hasTitle";

/**
 * A deterministic stand-in for a provider: an age-18 test points one way (a `<` form a little off
 * the `>=` form), a title test another, anything else a third. It records every call it gets.
 */
function stubEmbedder(model = "stub-v1") {
  const calls: string[][] = [];
  const port: EmbeddingPort = {
    model,
    embed: async (texts) => {
      calls.push(texts);
      return texts.map((t) =>
        /\.age\b/.test(t) && /\b18\b/.test(t)
          ? [1, 0, t.includes("<") ? 0.3 : 0.1]
          : /\.title\b/.test(t)
            ? [0, 1, 0.1]
            : [0, 0, 1],
      );
    },
  };
  return { port, calls };
}

interface EmbedRun {
  readonly port: EmbeddingPort;
  readonly store: ArtifactStore<BranchVector>;
  readonly threshold?: number;
}

/** Stages 2, 3, the embedding stage and stage 6 over `files`; the embedding runs, and the clusters. */
async function clusterWith(
  files: Readonly<Record<string, string>>,
  embed: EmbedRun,
  s: Stores = stores(),
) {
  const runs = await resolveFiles(files, { stores: s });
  const embedded = [];
  for (const run of runs)
    embedded.push(
      await runStage(
        embed.store,
        embeddingStage(embed.port),
        embeddingInput(embed.port, run.lowered.artifact),
      ),
    );
  const clustered = await runStage(
    s.cluster,
    clusterStage,
    clusterInput(
      runs.map((r) => r.resolved.artifact),
      null,
      {
        vectors: embedded.map((e) => e.artifact),
        ...(embed.threshold === undefined
          ? {}
          : { threshold: embed.threshold }),
      },
    ),
  );
  return { embedded, artifact: clustered.artifact };
}

const functionsIn = (c: CandidateCluster) =>
  new Set(c.members.map((m) => m.function));

const together = (cs: readonly CandidateCluster[], a: string, b: string) =>
  cs.filter((c) => functionsIn(c).has(a) && functionsIn(c).has(b));

describe("the embedding candidate source", () => {
  it("proposes two unlike-looking functions for one rule only through the embedding source", async () => {
    const without = clusters(await clustersOf(ADULT));
    expect(together(without, ALCOHOL, ADULT_FN)).toEqual([]);

    const { port } = stubEmbedder();
    const { artifact } = await clusterWith(ADULT, {
      port,
      store: memoryArtifactStore(),
    });
    const paired = together(clusters(artifact), ALCOHOL, ADULT_FN);
    expect(paired.length).toBeGreaterThan(0);
    for (const c of paired) {
      expect(c.basis._tag).toBe("embedding");
      if (c.basis._tag !== "embedding") continue;
      expect(c.basis.similarity).toBeGreaterThanOrEqual(
        DEFAULT_SIMILARITY_THRESHOLD,
      );
    }
    const embeddingClusters = clusters(artifact).filter(
      (c) => c.basis._tag === "embedding",
    );
    expect(embeddingClusters.some((c) => functionsIn(c).has(TITLE))).toBe(
      false,
    );
  });

  it("names its default threshold, and a caller's threshold overrides it", async () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.9);
    const { port } = stubEmbedder();
    const strict = await clusterWith(ADULT, {
      port,
      store: memoryArtifactStore(),
      threshold: 0.99,
    });
    expect(
      clusters(strict.artifact).filter((c) => c.basis._tag === "embedding"),
    ).toEqual([]);
    expect(() => clusterInput([], null, { vectors: [], threshold: 0 })).toThrow(
      /similarity threshold is in \(0, 1\]/,
    );
  });

  it("embeds the lowered branches, never the source, one call per file with equal texts once", async () => {
    const { port, calls } = stubEmbedder();
    await clusterWith(ADULT, { port, store: memoryArtifactStore() });
    expect(calls).toHaveLength(Object.keys(ADULT).length);
    const texts = calls.flat();
    expect(texts).toContain("⇒ return v0.age >= 18");
    expect(
      texts.some((t) => /customer|person|post\b|canBuy|assertAdult/.test(t)),
    ).toBe(false);
    for (const call of calls) expect(new Set(call).size).toBe(call.length);
  });

  it("caches vectors by content hash in the artifact store: a second run calls embed for nothing", async () => {
    const { port, calls } = stubEmbedder();
    const store = memoryArtifactStore<BranchVector>();
    const first = await clusterWith(ADULT, { port, store });
    const before = calls.length;
    expect(before).toBeGreaterThan(0);
    const second = await clusterWith(ADULT, { port, store });
    expect(calls.length).toBe(before);
    expect(second.embedded.map((e) => e._tag)).toEqual(
      first.embedded.map(() => "hit"),
    );
    expect(second.artifact.digest).toBe(first.artifact.digest);
  });

  it("keys the cache on the model: another model's vectors are never read", async () => {
    const store = memoryArtifactStore<BranchVector>();
    await clusterWith(ADULT, { port: stubEmbedder("a").port, store });
    const other = stubEmbedder("b");
    const run = await clusterWith(ADULT, { port: other.port, store });
    expect(run.embedded.map((e) => e._tag)).toEqual(
      Object.keys(ADULT).map(() => "computed"),
    );
    expect(other.calls.length).toBe(Object.keys(ADULT).length);
  });

  it("refuses a port that breaks its contract", async () => {
    const port: EmbeddingPort = { model: "short", embed: async () => [[1]] };
    await expect(
      clusterWith(ADULT, { port, store: memoryArtifactStore() }),
    ).rejects.toThrow(/one number\[\] per text/);
  });

  it("puts every embedding candidate through the existing confirm stage", async () => {
    const { port } = stubEmbedder();
    const { artifact } = await clusterWith(ADULT, {
      port,
      store: memoryArtifactStore(),
    });
    const asked: ClusterQuestionState[] = [];
    const policy = await stage6Policy();
    const ask = askGroupVerdict(
      stubGroupJev((state) => {
        asked.push(state);
        return groupAnswer("same-rule", 0.95);
      }),
    );
    const options = {
      policy,
      ask,
      enrich: async (_item: GateItem, state: JevState) => state,
    };
    const confirmed = await runStage(
      memoryArtifactStore(),
      confirmStage(options),
      confirmInput(artifact, options),
    );
    const embeddingIds = clusters(artifact)
      .filter((c) => c.basis._tag === "embedding")
      .map((c) => c.id);
    expect(embeddingIds.length).toBeGreaterThan(0);
    for (const id of embeddingIds) {
      const state = asked.find((s) => s.cluster === id);
      expect(state?.shared.signal).toBe("embedding");
      expect(confirmed.artifact.facts.some((f) => f.id === id)).toBe(true);
    }
  });
});

describe("nearest neighbours", () => {
  it("pairs each branch with its nearest branch in another function, at or above the threshold", () => {
    const pairs = nearestNeighbourPairs(
      [
        { branch: "a1", function: "a", text: "x", vector: [1, 0] },
        { branch: "a2", function: "a", text: "y", vector: [1, 0.01] },
        { branch: "b1", function: "b", text: "z", vector: [1, 0.02] },
        { branch: "c1", function: "c", text: "w", vector: [0, 1] },
      ],
      0.9,
    );
    expect(pairs.map((p) => p.branches)).toEqual([
      ["a1", "b1"],
      ["a2", "b1"],
    ]);
    expect(cosineSimilarity([1, 0], [0, 0])).toBe(0);
  });

  it("keeps a pair at exactly the threshold", () => {
    const pairs = nearestNeighbourPairs(
      [
        { branch: "a", function: "f", text: "x", vector: [1, 0] },
        { branch: "b", function: "g", text: "x", vector: [1, 0] },
      ],
      1,
    );
    expect(pairs).toHaveLength(1);
  });
});

describe("without an embedding port, stage 6 is byte-for-byte what it was", () => {
  // Recorded on origin/main (d3c1d8b) before the embedding source existed, over the same input.
  const MAIN = {
    key: "3f40f7be5c5d5154df7b058b445d7aacb13ce9a7c4dd78fab662168e09cb6b3d",
    digest: "39beccd998bc727f70cb5f5d54306c2f8092128903564ae03b344004c4571d2f",
    ids: [
      "g-1c5c1780a5bf",
      "g-344837fddb30",
      "g-866b2d2e3a28",
      "g-8863e9cae1f5",
      "g-a6faceb13803",
    ],
    confirmKey:
      "b2eca7137b67b1cd1e34c2620fb35d88f3f2cdcce12789debb00302847b1dbc6",
    confirmDigest:
      "ce4e127b8d3acfffb9f823ee15de2c1af848a173f0dca7189f1ae81986add086",
  };

  it("keeps main's cluster artifact key, facts, cluster ids and the confirm artifact", async () => {
    const graph = readGroupingGraph(dataGraphFile);
    const artifact = await clustersOf(
      { ...SHAPE_A, ...SHAPE_B, ...LEDGER },
      graph.data,
    );
    expect(artifact.key).toBe(MAIN.key);
    expect(artifact.digest).toBe(MAIN.digest);
    expect(artifact.facts.map((f) => f.id)).toEqual(MAIN.ids);
    const policy = await stage6Policy();
    const options = {
      policy,
      ask: askGroupVerdict(goldGroupJev()),
      enrich: async (_item: GateItem, state: JevState) => state,
    };
    const confirmed = await runStage(
      memoryArtifactStore(),
      confirmStage(options),
      confirmInput(artifact, options),
    );
    expect(confirmed.artifact.key).toBe(MAIN.confirmKey);
    expect(confirmed.artifact.digest).toBe(MAIN.confirmDigest);
  });

  it("writes the same input whether the embedding argument is absent or undefined", async () => {
    const runs = await resolveFiles(ADULT);
    const resolved = runs.map((r) => r.resolved.artifact);
    expect(clusterInput(resolved, null, undefined)).toEqual(
      clusterInput(resolved, null),
    );
    expect(clusterInput(resolved, null).content).toBe('{"data":null}');
  });
});

describe("stage 8 over an embedding-basis group", () => {
  async function embeddingSpec(s: Stores) {
    const { port } = stubEmbedder();
    const { artifact } = await clusterWith(
      ADULT,
      { port, store: memoryArtifactStore() },
      s,
    );
    const [group] = together(clusters(artifact), ALCOHOL, ADULT_FN);
    if (group === undefined) throw new Error("expected an embedding cluster");
    const owner = group.members.find((m) => m.function === ALCOHOL);
    if (owner === undefined) throw new Error("expected canBuyAlcohol in it");
    const groups: Fact<RuleGroup>[] = [
      {
        id: group.id,
        span: owner.span,
        value: {
          _tag: "known",
          value: { id: group.id, basis: group.basis, members: group.members },
          basis: { _tag: "promoted", confidence: 0.95, floor: 0.9, round: 0 },
        },
      },
    ];
    const owners: Fact<Owner>[] = [
      {
        id: group.id,
        span: owner.span,
        value: {
          _tag: "known",
          value: {
            group: group.id,
            member: owner.branch,
            function: owner.function,
            span: owner.span,
          },
          basis: { _tag: "derived" },
        },
      },
    ];
    const [spec] = taskSpecs(groups, owners);
    if (spec === undefined) throw new Error("expected one spec");
    return { spec, port };
  }

  const after = (s: Stores) => ({
    sources: ADULT,
    functions: functionsOf(ADULT),
    lexicon: emptyLexicon,
    boundaries: [],
    stores: s,
  });

  it("refuses to re-measure it without an embedding port", async () => {
    const s = stores();
    const { spec } = await embeddingSpec(s);
    expect(spec.basis._tag).toBe("embedding");
    await expect(remeasure(spec, after(s))).rejects.toThrow(
      /has an embedding basis, and no embedding port was supplied/,
    );
  });

  it("re-measures it with the port: the member left in place still clusters", async () => {
    const s = stores();
    const { spec, port } = await embeddingSpec(s);
    const result = await remeasure(spec, {
      ...after(s),
      embedding: { port, store: memoryArtifactStore() },
    });
    expect(result.verdict._tag).toBe("still-clustered");
    if (result.verdict._tag !== "still-clustered") return;
    expect(new Set(result.verdict.members.map((m) => m.function))).toEqual(
      new Set([ADULT_FN]),
    );
  });

  /** Re-measure `spec` over `ADULT` with `file` rewritten to `lines`. */
  const rewritten = (
    s: Stores,
    port: EmbeddingPort,
    spec: Parameters<typeof remeasure>[0],
    file: string,
    lines: readonly string[],
  ) => {
    const sources = { ...ADULT, [file]: lines.join("\n") };
    return remeasure(spec, {
      ...after(s),
      sources,
      functions: functionsOf(sources),
      embedding: { port, store: memoryArtifactStore() },
    });
  };

  it("still clusters when the owner's text changed and the duplicate stayed", async () => {
    const s = stores();
    const { spec, port } = await embeddingSpec(s);
    const result = await rewritten(s, port, spec, "src/checkout/alcohol.ts", [
      "export function canBuyAlcohol(customer) {",
      "  if (customer.age < 18) return false;",
      "  return true;",
      "}",
    ]);
    expect(result.verdict._tag).toBe("still-clustered");
    if (result.verdict._tag !== "still-clustered") return;
    expect(new Set(result.verdict.members.map((m) => m.function))).toEqual(
      new Set([ADULT_FN]),
    );
  });

  it("reads collapsed once the duplicate defers to the owner", async () => {
    const s = stores();
    const { spec, port } = await embeddingSpec(s);
    const result = await rewritten(s, port, spec, "src/signup/adult.ts", [
      "export function assertAdult(person) {",
      "  if (!canBuyAlcohol(person)) throw new Underage();",
      "  return person;",
      "}",
    ]);
    expect(result.verdict).toEqual({
      _tag: "collapsed",
      group: spec.group,
      basis: spec.basis,
    });
  });
});
